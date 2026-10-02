#!/usr/bin/env node
// Can one seat's model be served now? stdin: the seat's node (rig ps --nodes --full). stdout: JSON
// { servable: true|false|null, family, model, back }: false when its family has no eligible account or every eligible
// account is cooling on its model (lib.js, WO90); back is when it's served again (ISO, or null when not known). null
// when the proxy status couldn't be read: never a reason to hold anything. agent-operator-watch asks before a wake.
import { readFileSync } from "node:fs";
import { seatInfo, eligibleFamilies, seatAvailable, servableAt } from "./lib.js";

const node = JSON.parse(readFileSync(0, "utf8"));
const seat = seatInfo({ ...node, logicalId: node.logicalId || "operator.agent", canonicalSessionName: node.canonicalSessionName || "?" });
const families = eligibleFamilies();
// eligibleFamilies() answers { claude: null, codex: null } (no details) when agent-proxy-status failed
const known = Object.getOwnPropertyDescriptor(families, "_models") !== undefined;
const servable = known ? seatAvailable(seat, families) : null;
const back = servable === false ? servableAt(seat, families) : undefined;
console.log(JSON.stringify({ servable, family: seat.family, model: seat.model,
  ...(servable === false ? { back: back ? new Date(back).toISOString() : null } : {}) }));
