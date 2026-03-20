#!/usr/bin/env bash
# json-helpers.sh — JSON manipulation via jq (replaces all python3 -c JSON ops).
#
# Requires: jq installed, logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# Read JSON fields
# ---------------------------------------------------------------------------

# Read a string field from a JSON file.
# Usage: json_read ".backend" file.json → "advanced-gguf"
json_read() {
  local query="$1"
  local file="$2"
  jq -r "$query // empty" "$file" 2>/dev/null
}

# Read a numeric field.
# Usage: json_read_num ".dim_code" file.json → 3584
json_read_num() {
  local query="$1"
  local file="$2"
  jq -r "$query // 0" "$file" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Read samples from check-samples.json
# ---------------------------------------------------------------------------

# Count samples: json_count_samples ".code" samples.json → 10
json_count_samples() {
  local path="$1"
  local file="$2"
  jq -r "${path} | length" "$file"
}

# Get a sample as a JSON-escaped string (for embedding requests).
# Usage: json_get_sample ".code[0]" samples.json → "function hello()..."
json_get_sample() {
  local path="$1"
  local file="$2"
  jq -c "$path" "$file"
}

# Get a sample's raw text (unquoted) for display.
json_get_sample_raw() {
  local path="$1"
  local file="$2"
  jq -r "$path" "$file"
}

# Extract label from a code sample (first function/class name).
json_get_code_label() {
  local path="$1"
  local file="$2"
  jq -r "$path | capture(\"(?:function|class|async function)\\\\s+(?<name>\\\\w+)\") // {name: \"sample\"} | .name" "$file" 2>/dev/null || echo "sample"
}

# Get character count of a sample.
json_get_sample_len() {
  local path="$1"
  local file="$2"
  jq -r "$path | length" "$file"
}

# ---------------------------------------------------------------------------
# Extract embedding vectors from backend responses
# ---------------------------------------------------------------------------

# Extract embedding vector from GGUF response.
# llama.cpp returns: [{"embedding": [[...floats...]]}]
# The embedding field is a nested array [[...]], so we unwrap with [0].
extract_gguf_embedding() {
  local response="$1"
  echo "$response" | jq -c '
    if type == "array" then .[0].embedding[0]
    elif .results then .results[0].embedding[0]
    elif .embedding then .embedding[0]
    else error("unexpected GGUF response format")
    end
  '
}

# Extract embedding vector from TEI response.
# TEI returns: [[0.1, 0.2, ...]]
extract_tei_embedding() {
  local response="$1"
  echo "$response" | jq -c '.[0]'
}

# Get embedding dimension from a vector JSON array.
embedding_dim() {
  local vec="$1"
  echo "$vec" | jq 'length'
}

# ---------------------------------------------------------------------------
# Cosine similarity (pure jq)
# ---------------------------------------------------------------------------

# Compute cosine similarity between two embedding vectors (JSON arrays).
# Usage: cosine_similarity "$vec_a" "$vec_b" → 0.998942
cosine_similarity() {
  local vec_a="$1"
  local vec_b="$2"

  jq -n --argjson a "$vec_a" --argjson b "$vec_b" '
    def dot(x;y): [range(x|length)] | map(x[.] * y[.]) | add;
    def norm(x): [range(x|length)] | map(x[.] * x[.]) | add | sqrt;
    if ($a | length) != ($b | length) then -1
    elif (norm($a) == 0) or (norm($b) == 0) then 0
    else dot($a;$b) / (norm($a) * norm($b))
    end
  '
}

# ---------------------------------------------------------------------------
# Write results JSON
# ---------------------------------------------------------------------------

# Write embedding-ab-results.json
write_ab_results() {
  local file="$1"
  shift
  # Accepts a jq filter and named args to build the JSON
  jq -n "$@" > "$file"
  log ok "A/B test results written to ${file}"
}

# Write embeddings-ready.json
write_embeddings_ready() {
  local file="$1"
  shift
  mkdir -p "$(dirname "$file")"
  jq -n "$@" > "$file"
  log ok "Config written to ${file}"
}
