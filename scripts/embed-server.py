#!/usr/bin/env python3
"""
Anatoly Embedding Sidecar — GPU-accelerated code embeddings via sentence-transformers.

Usage:
    python scripts/embed-server.py [--port 11435] [--model nomic-ai/nomic-embed-code-v1.5]
                                   [--idle-timeout 300]

Endpoints:
    POST /embed   { "input": "text" }        → { "embedding": [...], "dim": 768 }
    POST /embed   { "input": ["a", "b"] }    → { "embeddings": [[...], [...]], "dim": 768 }
    GET  /health                              → { "status": "ok", "model": "...", "device": "..." }
    POST /shutdown                            → graceful exit
"""

import argparse
import json
import signal
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
from sentence_transformers import SentenceTransformer


def parse_args():
    p = argparse.ArgumentParser(description="Anatoly embedding sidecar")
    p.add_argument("--port", type=int, default=11435)
    p.add_argument("--model", default="nomic-ai/nomic-embed-code")
    p.add_argument("--idle-timeout", type=int, default=300,
                   help="auto-shutdown after N seconds of inactivity (0 = disabled)")
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

idle_label = f", idle timeout {args.idle_timeout}s" if args.idle_timeout > 0 else ""
print(f"[embed-server] ready — {dim}d on {device}, port {args.port}{idle_label}", flush=True)

# ---------------------------------------------------------------------------
# Idle timeout watchdog
# ---------------------------------------------------------------------------

last_activity = time.monotonic()


def touch_activity():
    """Reset the idle timer on every request."""
    global last_activity
    last_activity = time.monotonic()


def idle_watchdog(timeout_sec: int, srv: HTTPServer):
    """Background thread that shuts down the server after inactivity."""
    while True:
        time.sleep(10)  # check every 10s
        idle = time.monotonic() - last_activity
        if idle >= timeout_sec:
            print(f"[embed-server] idle for {int(idle)}s — auto-shutdown", flush=True)
            srv.shutdown()
            return


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

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
        touch_activity()
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "model": args.model, "device": device, "dim": dim})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        touch_activity()
        if self.path == "/shutdown":
            self._send_json(200, {"status": "shutting down"})
            threading.Thread(target=lambda: server.shutdown(), daemon=True).start()
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


# ---------------------------------------------------------------------------
# Server lifecycle
# ---------------------------------------------------------------------------

server = HTTPServer(("127.0.0.1", args.port), Handler)
signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
signal.signal(signal.SIGINT, lambda *_: server.shutdown())

# Start idle watchdog if enabled
if args.idle_timeout > 0:
    threading.Thread(target=idle_watchdog, args=(args.idle_timeout, server), daemon=True).start()

try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
    # Explicitly release GPU memory before exit — relying on process death
    # after SIGKILL leaves CUDA memory orphaned until driver cleanup.
    del model
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("[embed-server] stopped", flush=True)
