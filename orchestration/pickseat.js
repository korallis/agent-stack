// agent-dispatch pick-seat: Jev picks the seat, code builds the candidates and owns the rule.
// Candidates = running, idle seats of the role with no open work (code: capacity and account availability), each with notes
// Jev can weigh. Act band: dispatch to Jev's seat. Review or uncertain: the lead decides and records why in the row.
import { qualityScore } from "./lib.js";

export const FAMILIES = ["claude", "codex", "kimi"];

// Pure: the candidate list for intake.seat. excludeFamily (the locked tests' author family, for an implementer) is
// filtered here, in code, before Jev ranks anything.
export function seatCandidates(all, role, families = {}, excludeFamily = null) {
  return all
    // Idle as observed (not merely no tracked work: a seat can be busy on something the queue doesn't show).
    .filter((s) => s.role === role && s.running && s.idle && s.assigned === 0 && s.pending === 0 && families[s.family] !== 0
      && s.family !== excludeFamily)
    .map((s) => ({ id: s.seat, text: `${s.seat}: ${s.family} seat (${s.runtime}), idle, no open work, `
      + `quality ${qualityScore(s.seat).toFixed(2)} (completed/returned/failed record)` }));
}

// Pure: who wrote a slice's locked tests, from its PROGRESS.md / SPEC.md. Two forms (case-insensitive):
//   "Locked tests: <seat> (<family>) <PR>"   at the start of a line, and
//   "locked-test author: <seat> (...)"       anywhere, e.g. in an "Implementing family: … · locked-test author: …" note.
// The family: as written "(claude|codex|kimi)", else the seat's family in this rig (a bare "tests-claude-1" matches
// "tests-claude-1@<rig>"), else the seat name's own family part (tests-claude-* -> claude, *-codex-* -> codex,
// *kimi* -> kimi). texts: [{ name, text }] in the order to look. Returns { family, seat, source } or
// { family: null, reason }: never a guess beyond those.
const AUTHOR_LINE = [/^[ \t]*(?:[-*][ \t]*)?Locked tests:[ \t]*([^\n]+)/im, /\blocked[- ]tests?[- ]author[ \t]*:[ \t]*([^\n·;|]+)/i];
export const familyFromName = (name) => {
  const parts = String(name || "").split("@")[0].toLowerCase().split(/[-_.]/);
  return ["claude", "codex", "kimi"].find((f) => parts.includes(f) || parts.some((p) => p.startsWith(f))) || null;
};
export function lockedTestsAuthor(texts, seats = []) {
  for (const { name, text } of texts) {
    for (const re of AUTHOR_LINE) {
      const m = String(text || "").match(re);
      if (!m) continue;
      const line = m[1].trim(), quoted = `${name}: "${re === AUTHOR_LINE[0] ? `Locked tests: ${line}` : m[0].trim()}"`;
      const fam = line.match(/\((claude|codex|kimi)\)/i);
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
