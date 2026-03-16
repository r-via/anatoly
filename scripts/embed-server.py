#!/usr/bin/env python3
"""
Anatoly Embedding Sidecar — GPU-accelerated code embeddings via sentence-transformers.

Usage:
    python scripts/embed-server.py [--port 11435] [--model nomic-ai/nomic-embed-code-v1.5]

Endpoints:
    POST /embed   { "input": "text" }        → { "embedding": [...], "dim": 768 }
    POST /embed   { "input": ["a", "b"] }    → { "embeddings": [[...], [...]], "dim": 768 }
    GET  /health                              → { "status": "ok", "model": "...", "device": "..." }
    POST /shutdown                            → graceful exit
"""

import argparse
import json
import sys
import signal
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
from sentence_transformers import SentenceTransformer


def parse_args():
    p = argparse.ArgumentParser(description="Anatoly embedding sidecar")
    p.add_argument("--port", type=int, default=11435)
    p.add_argument("--model", default="nomic-ai/nomic-embed-code")
    return p.parse_args()


args = parse_args()

# Detect best device
if torch.cuda.is_available():
    device = "cuda"
elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
    device = "mps"
else:
    device = "cpu"

print(f"[embed-server] loading {args.model} on {device}...", flush=True)
model = SentenceTransformer(args.model, device=device)
dim = model.get_sentence_embedding_dimension()
print(f"[embed-server] ready — {dim}d on {device}, port {args.port}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *_args):
        # Silence per-request logs
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "model": args.model, "device": device, "dim": dim})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/shutdown":
            self._send_json(200, {"status": "shutting down"})
            # Schedule shutdown after response is sent
            import threading
            threading.Thread(target=lambda: (server.shutdown()), daemon=True).start()
            return

        if self.path != "/embed":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return

        inp = data.get("input")
        if inp is None:
            self._send_json(400, {"error": "missing 'input' field"})
            return

        try:
            if isinstance(inp, str):
                vec = model.encode(inp, normalize_embeddings=True).tolist()
                self._send_json(200, {"embedding": vec, "dim": dim})
            elif isinstance(inp, list):
                vecs = model.encode(inp, normalize_embeddings=True, batch_size=32).tolist()
                self._send_json(200, {"embeddings": vecs, "dim": dim})
            else:
                self._send_json(400, {"error": "'input' must be string or array of strings"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


server = HTTPServer(("127.0.0.1", args.port), Handler)
signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
signal.signal(signal.SIGINT, lambda *_: server.shutdown())

try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    print("[embed-server] stopped", flush=True)
