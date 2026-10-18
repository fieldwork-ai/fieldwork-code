/** Error text from a remote service, made safe to log and show: no control sequences, no token-shaped values. */
export function sanitizeErrorText(value: string): string {
  return value
    .replace(/\x1b\[[\u0020-\u003f]*[\u0040-\u007e]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(/\b(?:access|refresh|id)_token\s*[=:]\s*[^\s,;}]+/gi, "token=[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}
