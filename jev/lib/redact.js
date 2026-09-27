// Strip secrets and bound size before anything leaves the machine. Applied to every string
// in the state (Jev) and in model-fallback prompts.
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED:key]"],
  [/\bapikey_[A-Za-z0-9_]{16,}\b/g, "[REDACTED:key]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED:github-token]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED:aws-key]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED:slack-token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED:jwt]"],
  [/(authorization|x-api-key|api[_-]?key|secret|password|passwd|token|refresh_token|access_token|client_secret)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;]{8,}/gi, "$1$2[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/g, "Bearer [REDACTED]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED:hex]"],
];

export function redactString(s, maxChars) {
  let out = String(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  if (maxChars && out.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    out = out.slice(0, half) + `\n…[truncated ${out.length - maxChars} chars]…\n` + out.slice(-half);
  }
  return out;
}

export function redactDeep(v, maxChars) {
  if (typeof v === "string") return redactString(v, maxChars);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, maxChars));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = /^(api_?key|token|secret|password|authorization)$/i.test(k) ? "[REDACTED]" : redactDeep(x, maxChars);
    return o;
  }
  return v;
}
