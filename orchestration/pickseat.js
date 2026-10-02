// agent-dispatch pick-seat: Jev picks the seat, code builds the candidates and owns the rule.
// Candidates = running, idle seats of the role with no open work (code: capacity and account availability), each with notes
// Jev can weigh. Act band: dispatch to Jev's seat. Review or uncertain: the lead decides and records why in the row.
import { qualityScore, seatAvailable, pickFor, reviewerFor } from "./lib.js";

export const FAMILIES = ["claude", "codex", "kimi", "grok"];

// Pure: the candidate list for intake.seat. excludeFamily (the locked tests' author family, for an implementer) is
// filtered here, in code, before Jev ranks anything.
export function seatCandidates(all, role, families = {}, excludeFamily = null) {
  return all
    // Idle as observed (not merely no tracked work: a seat can be busy on something the queue doesn't show).
    .filter((s) => s.role === role && s.running && s.idle && s.assigned === 0 && s.pending === 0 && seatAvailable(s, families)
      && s.family !== excludeFamily)
    .map((s) => ({ id: s.seat, text: `${s.seat}: ${s.family} seat (${s.runtime}), idle, no open work, `
      + `quality ${qualityScore(s.seat).toFixed(2)} (completed/returned/failed record)` }));
}

// Pure: who wrote a slice's locked tests, from its PROGRESS.md / SPEC.md. Two forms (case-insensitive):
//   "Locked tests: <seat> (<family>) <PR>"   at the start of a line, and
//   "locked-test author: <seat> (...)"       anywhere, e.g. in an "Implementing family: … · locked-test author: …" note.
// The family: as written "(claude|codex|kimi|grok)", else the seat's family in this rig (a bare "tests-claude-1" matches
// "tests-claude-1@<rig>"), else the seat name's own family part (tests-claude-* -> claude, *-codex-* -> codex,
// *kimi* -> kimi). texts: [{ name, text }] in the order to look. Returns { family, seat, source } or
// { family: null, reason }: never a guess beyond those.
const AUTHOR_LINE = [/^[ \t]*(?:[-*][ \t]*)?Locked tests:[ \t]*([^\n]+)/im, /\blocked[- ]tests?[- ]author[ \t]*:[ \t]*([^\n]+)/i];
// The author's own field: up to a separator (· ; |) or the next "Label:" (e.g. "Implementing family:"), so a family
// written for something else on the same line is never read as the author's (QA PR70).
const authorField = (rest) => rest.split(/\s*[·;|]\s*|,?\s+(?=[A-Za-z][\w -]{0,30}:(?!\/\/))/)[0].trim();   // a URL's "https:" is no label
export const familyFromName = (name) => {
  const parts = String(name || "").split("@")[0].toLowerCase().split(/[-_.]/);
  return FAMILIES.find((f) => parts.includes(f) || parts.some((p) => p.startsWith(f))) || null;
};
export function lockedTestsAuthor(texts, seats = []) {
  for (const { name, text } of texts) {
    for (const re of AUTHOR_LINE) {
      const m = String(text || "").match(re);
      if (!m) continue;
      const line = authorField(m[1]), quoted = `${name}: "${re === AUTHOR_LINE[0] ? "Locked tests" : m[0].slice(0, m[0].indexOf(":")).trim()}: ${line}"`;
      const fam = line.match(/\((claude|codex|kimi|grok)\)/i);
      const seat = (line.match(/^[\w.-]+(?:@[\w.-]+)?/) || [])[0] || null;
      if (fam) return { family: fam[1].toLowerCase(), seat, source: quoted };
      const known = seat && seats.find((s) => s.seat === seat || s.seat.startsWith(`${seat}@`));
      if (known) return { family: known.family, seat: known.seat, source: `${quoted} (${known.seat} is a ${known.family} seat)` };
      const byName = familyFromName(seat);
      if (byName) return { family: byName, seat, source: `${quoted} (a ${byName} seat by its name)` };
      return { family: null, reason: `${name} names the locked tests' author ("${line}") but no family can be read from it: pass --exclude-family` };
    }
  }
  return { family: null, reason: `no "Locked tests: <seat> (<family>)" or "locked-test author: <seat>" line in ${texts.map((t) => t.name).join(" or ") || "the slice"}: pass --exclude-family` };
}

// Pure: what the lead does next with Jev's answer.
export function nextStep(rec, candidates, task) {
  const seat = rec?.result?.seat;
  const known = candidates.some((c) => c.id === seat);
  if (rec?.band === "act" && known)
    return { action: "dispatch", seat, command: `rig queue create --destination ${seat} --mission <mission> --slice <slice> --summary ${JSON.stringify(task.slice(0, 80))} --body-file <brief.md>` };
  return { action: "lead decides", seat: known ? seat : null,
    note: `Jev ${rec?.band || "gave no answer"}${known ? ` (suggested ${seat})` : ""}: pick the seat yourself and write why in the queue row (e.g. "seat chosen by lead: <reason>; Jev ${rec?.band}")` };
}

// The independence a row's work carries, read from the row itself (WO90, QA PR119): a review must not go to its author's
// seat, nor its author's family while another family has a free reviewer; an implementation against locked tests must
// not go to the tests' family. Tags first (author:SEAT, author-family:F, locked-tests:F), then the text (review-plan's
// "Review branch agent/SEAT", "Author: SEAT (F)", "Author family: F"; "Locked tests: SEAT (F)" or "locked-test author:").
// Returns { review: { seat, family } } | { exclude: F } | { unknown: why } (a constraint the row implies but doesn't
// state: a lead decides, nothing relaxes it) | {} (none).
export function rowConstraint(row, role, all = []) {
  const tags = row?.tags || [], text = `${row?.summary || ""}\n${row?.body || ""}`;
  const tag = (k) => { const t = tags.find((x) => String(x).toLowerCase().startsWith(`${k}:`)); return t ? String(t).slice(k.length + 1).trim() || null : null; };
  const known = (f) => (f && FAMILIES.includes(f.toLowerCase()) ? f.toLowerCase() : null);
  if (role === "reviewer") {
    const seat = tag("author") || (text.match(/\bReview branch agent\/([\w.-]+)/) || [])[1] || (text.match(/^Author:\s*([\w.@-]+)/im) || [])[1] || null;
    const fam = known(tag("author-family")) || known((text.match(/\bAuthor family:\s*(\w+)/i) || text.match(/^Author:\s*[\w.@-]+\s*\((\w+)\)/im) || [])[1])
      || (seat && (all.find((s) => s.seat === seat || s.seat.startsWith(`${seat}@`))?.family || familyFromName(seat))) || null;
    return fam ? { review: { seat, family: fam } } : { unknown: "a review whose author's family isn't on the row" };
  }
  if (role === "implementer") {
    const f = known(tag("locked-tests"));
    if (f) return { exclude: f, because: "locked tests" };
    const lt = lockedTestsAuthor([{ name: "row", text }], all);
    if (lt?.family) return { exclude: lt.family, because: "locked tests" };
    if (tag("locked-tests") || /\blocked[- ]tests?\b/i.test(text)) return { unknown: `the row names locked tests but not their family${lt?.reason ? ` (${lt.reason})` : ""}` };
  }
  if (role === "test-author") {
    // Locked tests are written by a family other than the slice's implementer: a moved test row must not land on the
    // implementer's family (that seat refuses it). The row names it as "Implementer: <seat> (<family>)" or tags; a test
    // row without it is left for the lead.
    const seat = tag("implementer") || (text.match(/^Implementer:\s*([\w.@-]+)/im) || [])[1] || null;
    const fam = known(tag("implementer-family")) || known((text.match(/^Implementer:\s*[\w.@-]+\s*\((\w+)\)/im) || [])[1])
      || (seat && (all.find((s) => s.seat === seat || s.seat.startsWith(`${seat}@`))?.family || familyFromName(seat))) || null;
    return fam ? { exclude: fam, because: "the slice's implementer" } : { unknown: "a test-author row without its implementer (add \"Implementer: <seat> (<family>)\")" };
  }
  return {};
}

// A seat to move existing work to, keeping its row's constraint (rowConstraint): the role's chain and fallback roles,
// idle seats only, never the author's seat or family for a review (no same-family last resort when moving work), never
// the locked tests' family. { seat, as?, fallback?, matrix?, constraint } or { seat: null, why }.
export function pickForWork(all, role, row, { families, excludeFamily = null } = {}) {
  const c = rowConstraint(row, role, all);
  if (c.unknown) return { seat: null, why: `left for the lead: ${c.unknown}`, constraint: c };
  if (c.review) {
    const r = reviewerFor(all, c.review.seat, c.review.family, families, undefined, { idle: true });
    if (!r.seat || r.matrix.same_family || (excludeFamily && r.seat.family === excludeFamily))
      return { seat: null, why: `no free reviewer outside the author's family (${c.review.family})`, constraint: c };
    return { seat: r.seat, matrix: r.matrix, constraint: c };
  }
  const ex = [excludeFamily, c.exclude].filter(Boolean);
  const p = pickFor(all, role, { families, excludeFamily: ex.length ? ex : null, idle: true });
  return p.seat ? { ...p, constraint: c } : { seat: null, why: `no free ${[role, ...(p.tried || []).slice(1)].join(" or ")} seat${c.exclude ? ` outside ${c.because === "locked tests" ? "the locked tests'" : "the implementer's"} family (${c.exclude})` : ""} in any family`, constraint: c };
}
