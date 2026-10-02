export class UsageSamplesStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /** Append the context-lane sample IFF it advanced past the seat's latest row. */
    appendContextSample(s, capturedAt) {
        const last = this.db
            .prepare(`SELECT sampled_at, total_input_tokens, total_output_tokens, used_percentage
         FROM usage_samples
         WHERE lane = 'context' AND seat_session = ?
         ORDER BY id DESC LIMIT 1`)
            .get(s.seatSession);
        if (last &&
            last.sampled_at === s.sampledAt &&
            last.total_input_tokens === s.totalInputTokens &&
            last.total_output_tokens === s.totalOutputTokens &&
            last.used_percentage === s.usedPercentage) {
            return false;
        }
        this.db
            .prepare(`INSERT INTO usage_samples
           (lane, seat_session, node_id, source, sampled_at, captured_at,
            total_input_tokens, total_output_tokens, used_percentage)
         VALUES ('context', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(s.seatSession, s.nodeId, s.source, s.sampledAt, capturedAt, s.totalInputTokens, s.totalOutputTokens, s.usedPercentage);
        return true;
    }
    /** Append the provider-window sample IFF it advanced past the seat's latest row for that window. */
    appendProviderWindowSample(s, capturedAt) {
        const last = this.db
            .prepare(`SELECT sampled_at, window_used_percent, resets_at
         FROM usage_samples
         WHERE lane = 'provider_window' AND seat_session = ? AND window = ?
         ORDER BY id DESC LIMIT 1`)
            .get(s.seatSession, s.window);
        if (last &&
            last.sampled_at === s.asOf &&
            last.window_used_percent === s.usedPercent &&
            last.resets_at === s.resetsAt) {
            return false;
        }
        this.db
            .prepare(`INSERT INTO usage_samples
           (lane, seat_session, source, sampled_at, captured_at,
            window, window_used_percent, resets_at)
         VALUES ('provider_window', ?, 'claude_statusline_json', ?, ?, ?, ?, ?)`)
            .run(s.seatSession, s.asOf, capturedAt, s.window, s.usedPercent, s.resetsAt);
        return true;
    }
}
/** Map the read model's statusline signals to window-sample inputs. Only the two
 *  normalized subscription windows ride the series; rows without a seat identity
 *  or an asOf stamp are skipped (nothing is fabricated — the Option-A bar). */
export function providerWindowSamplesFromSignals(signals) {
    const out = [];
    for (const sig of signals) {
        if (!sig.seatSession || !sig.asOf)
            continue;
        // SignalWindow admits provider-native strings; only the two normalized
        // windows ride the series (an explicit re-literal narrows the open union).
        const window = sig.window === "five_hour" ? "five_hour" : sig.window === "weekly" ? "weekly" : null;
        if (!window)
            continue;
        out.push({
            seatSession: sig.seatSession,
            window,
            usedPercent: typeof sig.usedPercent === "number" ? sig.usedPercent : null,
            resetsAt: sig.resetsAt ?? null,
            asOf: sig.asOf,
        });
    }
    return out;
}
