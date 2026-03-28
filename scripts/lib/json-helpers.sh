#!/usr/bin/env bash
# json-helpers.sh — JSON manipulation via jq (replaces all python3 -c JSON ops).
#
# Requires: jq installed, logging.sh sourced first.

set -euo pipefail

# ---------------------------------------------------------------------------
# Read JSON fields
# ---------------------------------------------------------------------------

# Read a string field from a JSON file.
# Returns empty string (no output) if the field is null or absent.
# Suppresses jq stderr; exit code 0 on missing fields due to `// empty` fallback.
# @param query  jq filter expression (e.g. ".backend")
# @param file   Path to the JSON file
# @stdout Raw string value, or nothing if field is null/absent
# Usage: json_read ".backend" file.json → "advanced-gguf"
json_read() {
  local query="$1"
  local file="$2"
  jq -r "$query // empty" "$file" 2>/dev/null
}

# Read a numeric field from a JSON file.
# Returns 0 if the field is null or absent.
# Suppresses jq stderr; exit code 0 on missing fields due to `// 0` fallback.
# @param query  jq filter expression (e.g. ".dim_code")
# @param file   Path to the JSON file
# @stdout Numeric value as a string, or "0" if field is null/absent
# Usage: json_read_num ".dim_code" file.json → 3584
json_read_num() {
  local query="$1"
  local file="$2"
  jq -r "$query // 0" "$file" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Read samples from check-samples.json
# ---------------------------------------------------------------------------

# Count the number of elements in a JSON array.
# @param path  jq path expression resolving to an array (e.g. ".code")
# @param file  Path to the JSON file
# @stdout Element count as an integer
# Usage: json_count_samples ".code" samples.json → 10
json_count_samples() {
  local path="$1"
  local file="$2"
  jq -r "${path} | length" "$file"
}

# Get a sample as a compact JSON-escaped string, suitable for embedding in API request bodies.
# Uses jq -c for compact output (preserves JSON quoting).
# @param path  jq path expression resolving to the sample (e.g. ".code[0]")
# @param file  Path to the JSON file
# @stdout Compact JSON string (quoted, escaped)
# Usage: json_get_sample ".code[0]" samples.json → "function hello()..."
json_get_sample() {
  local path="$1"
  local file="$2"
  jq -c "$path" "$file"
}

# Get a sample's raw text (unquoted) for human-readable display.
# Uses jq -r for raw output (strips JSON quoting).
# @param path  jq path expression resolving to the sample (e.g. ".code[0]")
# @param file  Path to the JSON file
# @stdout Raw unquoted text value
# Usage: json_get_sample_raw ".code[0]" samples.json → function hello() { ... }
json_get_sample_raw() {
  local path="$1"
  local file="$2"
  jq -r "$path" "$file"
}

# Extract a label from a code sample by matching the first function/class declaration.
# Matches: function, class, async function — extracts the identifier name.
# Falls back to "sample" if no match is found (jq capture fallback) or if jq fails
# (shell || fallback).
# @param path  jq path expression resolving to a code string (e.g. ".code[0]")
# @param file  Path to the JSON file
# @stdout Extracted identifier name, or "sample" as fallback
# Usage: json_get_code_label ".code[0]" samples.json → "hello"
json_get_code_label() {
  local path="$1"
  local file="$2"
  jq -r "$path | capture(\"(?:function|class|async function)\\\\s+(?<name>\\\\w+)\") // {name: \"sample\"} | .name" "$file" 2>/dev/null || echo "sample"
}

# Get the character length of a sample string value.
# The path must resolve to a string; jq `length` on strings returns Unicode codepoint count.
# @param path  jq path expression resolving to a string value (e.g. ".code[0]")
# @param file  Path to the JSON file
# @stdout Character count as an integer
# Usage: json_get_sample_len ".code[0]" samples.json → 142
json_get_sample_len() {
  local path="$1"
  local file="$2"
  jq -r "$path | length" "$file"
}

# ---------------------------------------------------------------------------
# Extract embedding vectors from backend responses
# ---------------------------------------------------------------------------

# Extract a flat embedding vector from a GGUF (llama.cpp) response.
# Handles three known response shapes:
#   - Array:  [{"embedding": [[...floats...]]}]  → .[0].embedding[0]
#   - Results: {"results": [{"embedding": [[...]]}]} → .results[0].embedding[0]
#   - Direct:  {"embedding": [[...]]}             → .embedding[0]
# Errors with "unexpected GGUF response format" if none match.
# @param response  Raw JSON response string from the GGUF embedding endpoint
# @stdout Compact JSON array of floats (the embedding vector)
# @exits Non-zero if the response format is unrecognized
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

# Extract a flat embedding vector from a TEI (Text Embeddings Inference) response.
# TEI wraps the vector in a single outer array: [[0.1, 0.2, ...]] → .[0] unwraps it.
# @param response  Raw JSON response string from the TEI embedding endpoint
# @stdout Compact JSON array of floats (the embedding vector)
extract_tei_embedding() {
  local response="$1"
  echo "$response" | jq -c '.[0]'
}

# Get the dimension (element count) of an embedding vector JSON array.
# @param vec  JSON array string representing an embedding vector (e.g. "[0.1, 0.2, 0.3]")
# @stdout Integer dimension count
# Usage: embedding_dim "[0.1, 0.2, 0.3]" → 3
embedding_dim() {
  local vec="$1"
  echo "$vec" | jq 'length'
}

# ---------------------------------------------------------------------------
# Cosine similarity (pure jq)
# ---------------------------------------------------------------------------

# Compute cosine similarity between two embedding vectors (JSON arrays), using pure jq.
# Returns -1 if vectors have different lengths, 0 if either vector has zero norm.
# @param vec_a  JSON array string for the first embedding vector
# @param vec_b  JSON array string for the second embedding vector
# @stdout Floating-point similarity score in [-1, 1], or -1 for length mismatch
# Usage: cosine_similarity "$vec_a" "$vec_b" → 0.998942
cosine_similarity() {
  local vec_a="$1"
  local vec_b="$2"

  jq -n --argjson a "$vec_a" --argjson b "$vec_b" '
    def dot(x;y): [range(x|length)] | map(x[.] * y[.]) | add // 0;
    def norm(x): [range(x|length)] | map(x[.] * x[.]) | add // 0 | sqrt;
    if ($a | length) != ($b | length) then -1
    elif (norm($a) == 0) or (norm($b) == 0) then 0
    else dot($a;$b) / (norm($a) * norm($b))
    end
  '
}

# ---------------------------------------------------------------------------
# Write results JSON
# ---------------------------------------------------------------------------

# Write embedding A/B test results to a JSON file.
# After shifting off the file path, remaining positional arguments ($@) are forwarded
# verbatim to `jq -n` — typically a jq filter string followed by --argjson/--arg pairs.
# @param file  Destination path for the JSON output
# @param ...   jq filter and --argjson/--arg pairs (e.g. '{code: $c}' --argjson c "$val")
# @stdout None (writes to file); logs success via `log ok`
# Usage: write_ab_results results.json '{score: $s}' --argjson s 0.95
write_ab_results() {
  local file="$1"
  shift
  jq -n "$@" > "$file"
  log ok "A/B test results written to ${file}"
}

# Write the embeddings-ready configuration JSON file.
# Creates parent directories if they don't exist. After shifting off the file path,
# remaining positional arguments ($@) are forwarded verbatim to `jq -n`.
# @param file  Destination path for the JSON config file
# @param ...   jq filter and --argjson/--arg pairs (e.g. '{backend: $b}' --arg b "tei")
# @stdout None (writes to file); logs success via `log ok`
# Usage: write_embeddings_ready config.json '{backend: $b}' --arg b "tei"
write_embeddings_ready() {
  local file="$1"
  shift
  mkdir -p "$(dirname "$file")"
  jq -n "$@" > "$file"
  log ok "Config written to ${file}"
}
