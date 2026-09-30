// agent-dispatch pick-seat: Jev picks the seat, code builds the candidates and owns the rule.
// Candidates = running seats of the role with no open work (code: capacity and account availability), each with notes
// Jev can weigh. Act band: dispatch to Jev's seat. Review or uncertain: the lead decides and records why in the row.
import { qualityScore } from "./lib.js";

// Pure: the candidate list for intake.seat.
export function seatCandidates(all, role, families = {}) {
  return all
    .filter((s) => s.role === role && s.running && s.assigned === 0 && s.pending === 0 && families[s.family] !== 0)
    .map((s) => ({ id: s.seat, text: `${s.seat}: ${s.family} seat (${s.runtime}), ${s.idle ? "idle" : "working"}, no open work, `
      + `quality ${qualityScore(s.seat).toFixed(2)} (completed/returned/failed record)` }));
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
