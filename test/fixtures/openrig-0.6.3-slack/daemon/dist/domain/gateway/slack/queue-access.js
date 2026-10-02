// S10 — the IN-PROCESS queue port for the gateway subsystem. Successor to the retired CLI
// queue-bridge (which shelled out to `rig queue` from the relay's separate process): in-daemon
// there is no process boundary, so fleet access is a direct QueueRepository read/write. The
// SELECTION SEMANTICS consume the single structured OWNER classification written with the
// queue transition. Tags and destination spellings are not a second alert classifier.
//   - reads are unbounded (the B5 lesson: a default limit silently truncates a large backlog).
import { loadHumanRegistry, resolveRegisteredHumanAddress } from "../human-registry.js";
import { ownerNotificationLevelAtLeast } from "../../queue-transition-log.js";
/** PURE: select active qitems whose transition carries a sufficient OWNER classification. */
export function filterHumanAlerts(items, opts) {
    const active = new Set(["pending", "in-progress", "blocked"]);
    return items.filter((q) => {
        if (q.state && !active.has(q.state))
            return false;
        return q.ownerNotificationLevel
            ? ownerNotificationLevelAtLeast(q.ownerNotificationLevel, opts.minimumLevel ?? "NOTICE")
            : false;
    });
}
function project(q, transition, entities) {
    const r = q;
    let destinationSession = null;
    let sourceSession = null;
    if (transition.ownerNotificationKind === "human-decision-resolved") {
        destinationSession = resolveRegisteredHumanAddress(transition.actorSession, entities);
        sourceSession = q.destinationSession;
    }
    else if (q.state === "blocked") {
        destinationSession = resolveRegisteredHumanAddress(q.blockedOn, entities);
        sourceSession = q.destinationSession;
    }
    else {
        destinationSession = resolveRegisteredHumanAddress(q.destinationSession, entities);
        sourceSession = q.sourceSession;
    }
    if (!destinationSession)
        return null;
    return {
        qitemId: String(r.qitemId),
        destinationSession,
        sourceSession,
        tags: r.tags ?? null,
        state: r.state ?? null,
        tier: r.tier ?? null,
        humanIntent: q.humanIntent,
        humanDetail: q.humanDetail,
        summary: r.summary ?? null,
        body: r.body ?? null,
        evidenceRef: r.evidenceRef ?? null,
        notificationKey: `${q.qitemId}:${transition.transitionId}`,
        ownerNotificationKind: transition.ownerNotificationKind,
        ownerNotificationLevel: transition.ownerNotificationLevel,
    };
}
/** Slice-11 item 9, carried over verbatim from the retired outbound.ts: on ENABLE, seed all
 *  currently-active human alerts as history/seen WITHOUT posting, so turning the connector on
 *  never replays the backlog. Returns the honest online-status line marking the transition. */
export async function seedBacklogAsHistory(opts) {
    const alerts = await opts.queue.listHumanAlerts(opts.filter);
    const already = opts.seen.load();
    const toSeed = alerts.map((a) => a.notificationKey ?? a.qitemId).filter((id) => !already.has(id));
    const seeded = opts.seen.seed(toSeed, "seeded-at-enable");
    const onlineStatus = `slack outbound ENABLED at enable-time: ${seeded} pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver.`;
    opts.log?.(onlineStatus);
    return { seeded, onlineStatus };
}
/** Build both ports over the daemon's own QueueRepository. In-process: no shell, no transport,
 *  no `-A` scope trap (list() here is repository-wide), no bounded-body N+1 (rows carry bodies). */
export function makeQueuePorts(queueRepo, opts = {}) {
    return {
        async createQitem(input) {
            const created = await queueRepo.create({
                qitemId: input.qitemId,
                sourceSession: input.source,
                destinationSession: input.destination,
                body: input.body,
                summary: input.summary,
                priority: (input.priority ?? "routine"),
                tags: input.tags ?? ["founder-slack", "inbound"],
            });
            return created.qitemId;
        },
        async listHumanAlerts(filter) {
            const registry = (opts.loadHumanRegistry ?? (() => loadHumanRegistry()))();
            if (!registry.ok)
                return [];
            const rows = queueRepo.list({ activeOnly: true, limit: 1000000 });
            const projected = rows.flatMap((row) => {
                const transition = queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
                if (!transition)
                    return [];
                const notificationKey = `${row.qitemId}:${transition.transitionId}`;
                if (queueRepo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, notificationKey))
                    return [];
                const item = project(row, transition, registry.entities);
                return item ? [item] : [];
            });
            return filterHumanAlerts(projected, filter);
        },
    };
}
