// Redaction for evidence our helpers send to Jev (an external service). Credential-shaped text never leaves the
// machine. `longTokens` also masks any 32+ character token (screens); merge evidence keeps it off so commit shas stay.
export function redact(text, { longTokens = false } = {}) {
  let s = String(text ?? "")
    .replace(/postgres(ql)?:\/\/[^\s'")]+/gi, "postgres://<redacted>")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, "<redacted-token>")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._-]{16,}/gi, "$1 <redacted>")
    // key=value and key: value where the key names a credential (PASSWORD, DB_PASSWORD, apiKey, client_secret…),
    // with the WHOLE value: "double quoted", 'single quoted', or up to the next space.
    .replace(/\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/gi, "$1$2<redacted>");
  if (longTokens) s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-long-token>");
  return s;
}
