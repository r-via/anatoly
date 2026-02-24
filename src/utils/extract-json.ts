/**
 * Extract a JSON object from a string that may contain markdown fences or surrounding text.
 * Returns the raw JSON string or null if no valid JSON structure is found.
 */
export function extractJson(text: string): string | null {
  // Try extracting from markdown code fences first
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try to find a JSON object directly (first { to last })
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return null;
}
