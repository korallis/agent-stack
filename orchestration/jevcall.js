// One place our helpers call Jev. AGENT_JEV_STUB=<file.json> ({"<decision id>": <record>}) replaces the call, so
// tests never reach the live (billed) Jev.
import { readFileSync } from "node:fs";

export async function decideOrStub(id, input, opts = {}) {
  const stub = process.env.AGENT_JEV_STUB;
  if (stub) {
    const all = JSON.parse(readFileSync(stub, "utf8"));
    const rec = all[id];
    if (!rec) throw new Error(`AGENT_JEV_STUB has no record for ${id}`);
    return { decision: id, ...rec, stubbed: true };
  }
  const { decide } = await import("../jev/lib/engine.js");
  return decide(id, input, opts);
}
