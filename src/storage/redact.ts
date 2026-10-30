const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_\-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /(api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*\S+/gi,
];

/** Truncate and strip credential-shaped substrings from errors and progress text. */
export function redactSensitive(text: string, maxLength = 500): string {
  let cleaned = text;
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted]');
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}
