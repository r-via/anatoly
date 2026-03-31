// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2025-present Rémi Viau
// See LICENSE and COMMERCIAL.md for licensing details.

/**
 * Extract a JSON object from a string that may contain markdown fences or surrounding text.
 * Returns the raw JSON string or null if no valid JSON structure is found.
 */
export function extractJson(text: string): string | null {
  // Try extracting from explicitly tagged ```json fences first (not ```rust, ```ts, etc.)
  const jsonFenceMatch = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonFenceMatch) {
    return jsonFenceMatch[1].trim();
  }

  // Try untagged ``` fences only if content starts with { or [
  const bareFenceMatch = text.match(/```\s*\n([\s\S]*?)\n```/);
  if (bareFenceMatch) {
    const content = bareFenceMatch[1].trim();
    if (content.startsWith('{') || content.startsWith('[')) {
      return content;
    }
  }

  // Find the first { or [ and track nesting to find its matching closer
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');

  let start: number;
  let open: string;
  let close: string;

  if (objStart === -1 && arrStart === -1) return null;
  if (arrStart === -1 || (objStart !== -1 && objStart < arrStart)) {
    start = objStart;
    open = '{';
    close = '}';
  } else {
    start = arrStart;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
