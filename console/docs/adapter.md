# Console adapter boundary

The six views render a `Snapshot` from [types.ts](../src/v3/types.ts). The contract contains plain objects, arrays,
strings, numbers and nulls: no daemon client, terminal, filesystem handle or renderer class. `renderV3(snapshot,
width, height, state)` reads that snapshot and returns terminal cells and hit targets. Rendering performs no I/O.

[adapter.ts](../src/v3/adapter.ts) implements the `Adapter` interface as `FleetAdapter`. A consumer uses these methods:

| Method | Responsibility |
| --- | --- |
| `snapshot(): Snapshot` | Return the latest cached value synchronously, without waiting for a source. |
| `start(onChange)` | Start background reads and notify the consumer when a snapshot changes. |
| `select({teamId, agentId, taskId, prId})` | Prioritize detail reads for the selected identities. This is navigation, not a work command. |
| `refresh()` | Request fresh data without blocking the render loop. |
| `stop()` | Stop updates and cancel outstanding work. |

The consumer owns `ViewState`: selection, scroll, overlays and pause. The adapter owns data acquisition and freshness.
The renderer never dispatches a task, answers a decision, sends terminal input or merges a pull request.

## Snapshot contents

`version: 1` identifies the current schema. `at` is the snapshot's observation time in epoch milliseconds; `source`
is its display label. `stale` describes overall fleet freshness, while `sources` records the availability or limits
of individual sources. Event and reset timestamps are ISO strings; capacity history uses epoch milliseconds.

| Collection | Meaning |
| --- | --- |
| `teams` | Stable project identity, milestone, measured progress with optional `progressLabel`, ETA, agents, tasks and merge history. `kind: operations` selects operational status rather than project progress. |
| `agents` | Stable seat identity, runtime model, activity, selected task, context and terminal tail with capture time. |
| `tasks` | Assignment, acceptance evidence, owner, linked PR and recorded journey steps. |
| `prs` | Checks, reviews, change counts and a bound Jev verdict with its reason and signals. |
| `capacity` | Account identity, 5-hour `used`, `weekly`, quota `resetAt`, optional `cooldownUntil`, credits and sampled history tagged with its usage `window`. |
| `decisions` | Pending human decisions and what they block. |
| `lastDecision` | Optional last answered question, `answeredAt` and optional answer. Shown only when no decisions are pending. |
| `events` | Notable observations with timestamps, source team and optional task link. |

The OpenRig adapter joins cached daemon state with selected queue details and transitions, recorded project progress,
`agent-proxy-status` measurements, GitHub read commands and local Jev records. Enrichment is bounded and happens in the
background. Project discovery maps `project.yaml` and rig identity to active missions. Progress labels distinguish
project feature evidence from marked-done slice statuses; neither silently becomes witnessed proof, and ETA remains
unknown without a supported derivation. The current-head GitHub `jev-merge` status is the primary gate source, with
exactly bound local records as supplemental evidence. Repository merge charts require an unambiguous team attribution. Terminal content comes from the cache's
selected transcript tail. The adapter may persist its own cache and measurements; it does not change fleet work.

## Unknown and stale are different

Use `null` for an unavailable measurement or identity, and `unknown` for an unsupported status. Never replace a missing
percentage with zero, manufacture an ETA, interpolate an unobserved history, or infer a passing gate from green CI.
Empty history means no recorded observations. The renderer labels those cases unknown or unavailable. A team must
supply `progressLabel` when its percentage represents a particular measure, such as proof readiness; it must not
present that measure as witnessed completion. Operational teams use `kind: operations` and show OPS status instead.

Capacity summaries average only matching windows: observed 5-hour usage when available, otherwise observed weekly
usage. The display states that window and how many accounts supplied it; weekly-only accounts are not silently
averaged into a 5-hour number. History samples carry `window: 5h | weekly` so charts do not connect unlike measures.
New adapter samples must name their window; `FleetAdapter` drops untagged legacy cache points. The renderer retains
compatibility with fixed snapshots whose omitted history windows mean 5-hour data. `cooldownUntil` is separate from a quota `resetAt`;
an account cooldown must not be published as a provider quota reset.

A retained value can be known but stale. Cached startup data is explicitly stale until live evidence arrives. If the
daemon becomes unavailable, retain useful prior data with `stale: true`; preserve the observation time instead of
making it look new. A failed supplemental source belongs in `sources` even if the daemon is healthy. Consumers must
keep those freshness limits visible; the renderer names degraded sources in its footer. The optional last answered
decision must come from the configured owner's verified done transition; absence is not an invitation to fabricate one. Gate decisions must remain bound to their repository, PR and current head;
missing or mismatched evidence is `UNKNOWN`. Each PR also carries its last successful `observedAt`, `freshness` and `refreshError`. A failed refresh makes its current gate unknown while retaining a labelled `historicalGate`; another PR's successful read cannot clear that failure. Historical checks and reviews are labelled as such until that PR refreshes successfully.

## Other backends and renderers

A herdr factory integration can implement `Adapter` by translating its durable teams, occupants, delivery/results,
review gates and capacity observations into the same `Snapshot`. It must validate current occupant bindings before
publishing context or terminal evidence. It must also preserve source provenance, unknown values and staleness. This
is an extension boundary, not a claim that a factory adapter is already implemented.

A Ratatui port can consume serialized snapshots and retain the same view state and navigation rules. TypeScript's
`Adapter` interface does not itself define a wire transport; a separate transport would carry the plain snapshot
schema and update notifications. Neither approach needs to expose OpenRig internals to the renderer.

## Neutral documentation evidence

[The fixture](../fixtures/v3.json) is wholly invented. `--fixture` loads it without starting `FleetAdapter`.
[make-assets.mjs](make-assets.mjs) uses the production renderer and controller to generate all six views, help and the
command palette. No live fleet records, terminal tails or client data belong in published images. Private live demos
are separate evidence and stay local.
