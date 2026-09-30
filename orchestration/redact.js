// Redaction for evidence our helpers send to Jev (an external service). Credential-shaped text never leaves the
// machine. `longTokens` also masks any 32+ character token (screens); merge evidence keeps it off so commit shas stay.
export function redact(text, { longTokens = false } = {}) {
  let s = String(text ?? "")
    .replace(/postgres(ql)?:\/\/[^\s'")]+/gi, "postgres://<redacted>")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{10,}/g, "<redacted-token>")
    .replace(/\b(Bearer|token)\s+[A-Za-z0-9._-]{16,}/gi, "$1 <redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_]*)=\S+/g, "$1=<redacted>");
  if (longTokens) s = s.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted-long-token>");
  return s;
}
