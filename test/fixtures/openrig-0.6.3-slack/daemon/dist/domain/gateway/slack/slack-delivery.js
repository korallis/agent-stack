// S10 — the subsystem's Slack DELIVERY path (successor to the retired connector-server's
// slackDeliverFn; the proof-1 semantics carry over unchanged): render the OutboundDecision to a
// hygienic payload (slice-11 item 7 redaction + Block Kit via message.ts) and post it. A 2xx →
// ok (the in-process ack drains the durable buffer); any failure → a bounded failure class (the
// wire retains + replays — fail-visible, never a silent drop).
//
// Changes from the retired path, each contract-driven:
//   - postWebhook → postChatMessage: the R2 thread shape needs thread_ts, which a webhook
//     cannot carry. The webhook retires with the relay.
//   - decisionId idempotent redelivery moved HERE from the connector: an already-delivered
//     decisionId is re-acked WITHOUT re-posting (the delivered-store is the same SeenStore
//     pattern, keyed by decisionId — distinct from the qitemId outbound seen-state).
//   - delivered-ok additionally marks the qitemId seen (slice-11: seen ONLY after success) and
//     releases the driver's in-flight guard.
import fs from "node:fs";
import path from "node:path";
import { postChatMessage, getUploadURLExternal, uploadBytesExternal, completeUploadExternal, fetchRecentMessageTexts } from "./slack-api.js";
import { buildOutboundMessage, attributionFromSession, reconcileToken } from "./message.js";
const LOCAL_IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TRANSPORT_FAILURE_RECEIPT_PREFIX = "::transport-failure-receipt::";
const TRANSPORT_FAILURE_RECEIPT_REPAIRED = "::repaired";
function transportFailureReceiptKey(decisionId, failureClass, detail) {
    const encoded = Buffer.from(JSON.stringify([failureClass, detail]), "utf8").toString("base64url");
    return `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}${encoded}`;
}
function pendingTransportFailureReceipt(attempted, decisionId) {
    const prefix = `${decisionId}${TRANSPORT_FAILURE_RECEIPT_PREFIX}`;
    const key = [...attempted.keys()].find((candidate) => candidate.startsWith(prefix)
        && !candidate.endsWith(TRANSPORT_FAILURE_RECEIPT_REPAIRED)
        && !attempted.has(`${candidate}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`));
    if (!key)
        return null;
    try {
        const parsed = JSON.parse(Buffer.from(key.slice(prefix.length), "base64url").toString("utf8"));
        if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
            return { key, error: "pending transport-failure receipt is malformed" };
        }
        return { key, failureClass: parsed[0], detail: parsed[1] };
    }
    catch (e) {
        return { key, error: `pending transport-failure receipt is unreadable: ${e.message}` };
    }
}
/** Default local-image reader: absolute path, image extension, readable — else null. */
export function defaultReadLocalImage(refPath) {
    try {
        if (!path.isAbsolute(refPath))
            return null;
        if (!LOCAL_IMAGE_EXT.has(path.extname(refPath).toLowerCase()))
            return null;
        const bytes = fs.readFileSync(refPath);
        return { bytes: new Uint8Array(bytes), filename: path.basename(refPath) };
    }
    catch {
        return null;
    }
}
/** Build the subsystem DeliverFn. Contract mirrors the retired connector handleDecision. */
function deliverSinglePart(opts, markEpisode = true) {
    const log = opts.log ?? (() => { });
    return async (decision) => {
        // Idempotent redelivery: an already-delivered decisionId is re-acked without re-posting.
        if (opts.delivered.load().has(decision.decisionId)) {
            log(`delivery: decision ${decision.decisionId} already delivered — re-ack, no re-post`);
            return { ok: true };
        }
        const q = (decision.payload ?? {});
        // M1 A5b (carried over from the retired sweep): an alert's evidenceRef IS the artifact the
        // human judges — an https image URL rides as a Block Kit image. buildImageBlocks stays the
        // single hygiene gate (drops non-https / secret-bearing), so the predicate lives in ONE place.
        const mediaRefs = Array.isArray(q.media)
            ? q.media
            : q.evidenceRef
                ? [{ imageUrl: String(q.evidenceRef), altText: q.summary ?? "attachment" }]
                : undefined;
        const payload = buildOutboundMessage({
            qitemId: q.qitemId ?? decision.decisionId,
            summary: q.summary,
            body: q.body,
            destinationSession: q.destinationSession ?? decision.entityBindingRef,
        }, {
            sourceLabel: opts.sourceLabel,
            bodyExcerpt: opts.bodyExcerpt,
            mediaRefs,
            // A1.2 — attribution rides every post; identity stays the app's own (postChatMessage
            // structurally cannot carry username/icon overrides — the customize-absence rail).
            attribution: attributionFromSession(q.sourceSession),
            mentionUserId: opts.resolveMentionUserId?.(q),
            // fix-r3 — the reconcile identity, reserved outside the clamp budget (same function
            // the scan below matches: one identity, same bytes, both sides).
            reconcileMarker: reconcileToken(decision.decisionId),
        });
        const threadTs = opts.resolveThreadTs?.(q);
        // A failed HTTP outcome whose row-receipt write failed is held in the
        // existing restart-surviving attempted store. Repair that authoritative
        // transition before reconciliation can progress to a later post.
        const attempted = opts.attempted.load();
        const pendingFailure = pendingTransportFailureReceipt(attempted, decision.decisionId);
        if (pendingFailure) {
            if ("error" in pendingFailure) {
                log(`${pendingFailure.error} for ${decision.decisionId} — retained, no resend`);
                return { ok: false, class: "receipt-failed", detail: pendingFailure.error };
            }
            try {
                if (!opts.onTransportFailed)
                    throw new Error("transport-failure receipt hook is unavailable");
                opts.onTransportFailed(q, pendingFailure.failureClass, pendingFailure.detail);
                opts.attempted.mark(`${pendingFailure.key}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`, "transport-failure-receipt-repaired");
            }
            catch (e) {
                log(`transport-failed receipt repair FAILED for ${q.qitemId ?? decision.decisionId}: ${e.message} — retained, no resend`);
                return { ok: false, class: "receipt-failed", detail: e.message };
            }
        }
        // H — RECONCILE-BY-MARKER before any RESEND: if this decision was attempted before, the
        // prior outcome is ambiguous (a timeout may have posted). Search where the message would
        // live (the thread, else channel history) for the message's STRUCTURAL identity; FOUND →
        // already delivered, record + ack, never repost. Search failure = stay ambiguous = retain
        // for the next replay (never a blind repost on an unreadable channel — a duplicate human
        // notification is the red; a delay is not).
        // fix-r3 (R2 exactly-once): the identity is reconcileToken(decisionId) — a bounded,
        // decision-scoped token the renderer reserves OUTSIDE the clamp budget, so it is
        // GUARANTEED present in the scanned top-level text at any ordinary length, and ordinary
        // prose quoting a qitem id can never reproduce it (it embeds the daemon-minted
        // decisionId in a delimited form). Producer and scanner call the same function: one
        // identity, same bytes, both sides.
        const marker = reconcileToken(decision.decisionId);
        if (attempted.has(decision.decisionId)) {
            const scan = await fetchRecentMessageTexts(opts.botToken, opts.channel, threadTs, opts.fetchImpl);
            if (!scan.ok) {
                log(`reconcile scan failed for ${decision.decisionId} (${scan.error}) — retained, no blind repost`);
                return { ok: false, class: "reconcile-unreadable", detail: scan.error };
            }
            const matched = scan.messages.find((m) => m.text.includes(marker));
            if (matched) {
                log(`reconcile: marker "${marker}" FOUND at ts=${matched.ts || "(missing)"} — prior ambiguous post landed; ack without repost`);
                // S14 repair (R2 HOLD): the matched message's REAL Slack ts is the thread
                // anchor. Mirror the normal-post order exactly — root-open (ThreadSeatMap +
                // rebuild stamp) first, then the same-row receipt, only then durable
                // delivered/seen/release — so a reply to the REAL root routes to the row
                // owner instead of generically. A synthetic ts here was the defect.
                if (matched.ts) {
                    // OPR.0.5.6.14 — same retain-and-repair contract as the normal-post
                    // receipt: a throwing receipt write retains the decision for the next
                    // replay (the marker stays findable; no repost can occur).
                    try {
                        if (threadTs === undefined)
                            opts.onPostedRoot?.(q, matched.ts);
                        opts.onPosted?.(q, matched.ts, threadTs);
                    }
                    catch (e) {
                        log(`receipt write FAILED on reconcile for ${q.qitemId ?? decision.decisionId}: ${e.message} — retained for the next replay`);
                        return { ok: false, class: "receipt-failed", detail: e.message };
                    }
                }
                else {
                    // Degraded, stated: a matched message without ts cannot anchor a thread;
                    // keep the ack (never repost) but say loudly that routing stays generic.
                    log(`reconcile: matched message carries NO ts — receipt degraded to synthetic; thread routing unavailable for ${q.qitemId ?? decision.decisionId}`);
                    opts.onPosted?.(q, "reconciled", threadTs);
                }
                opts.delivered.mark(decision.decisionId, "reconciled-delivered");
                if (markEpisode && q.qitemId) {
                    const key = q.notificationKey ?? q.qitemId;
                    opts.outboundSeen.mark(key, "posted");
                    opts.release?.(key);
                }
                return { ok: true };
            }
            log(`reconcile: marker "${marker}" absent — safe to send`);
        }
        // Marked ATTEMPTED durably BEFORE the post: from here any outcome is ambiguous until 2xx.
        opts.attempted.mark(decision.decisionId, "attempted");
        const res = await postChatMessage(opts.botToken, { channel: opts.channel, text: payload.text, blocks: payload.blocks, thread_ts: threadTs }, opts.fetchImpl);
        if (!res.ok) {
            const failureClass = res.status === 0 ? "transport" : `http-${res.status}`;
            // Persist the receipt input before the row write. A throwing row write
            // stays repairable across restart and blocks any later resend until the
            // authoritative transition lands.
            if (opts.onTransportFailed) {
                const receiptKey = transportFailureReceiptKey(decision.decisionId, failureClass, res.error ?? "");
                let receiptRetained = false;
                let retentionError;
                try {
                    opts.attempted.mark(receiptKey, "transport-failure-receipt-pending");
                    receiptRetained = true;
                }
                catch (e) {
                    retentionError = e.message;
                    log(`transport-failed receipt backup FAILED for ${q.qitemId ?? decision.decisionId}: ${retentionError} — authoritative row write still attempted`);
                }
                try {
                    opts.onTransportFailed(q, failureClass, res.error ?? "");
                }
                catch (e) {
                    const disposition = receiptRetained
                        ? "retained for repair before resend"
                        : `NOT retained; backup failed first: ${retentionError}`;
                    log(`transport-failed receipt write FAILED for ${q.qitemId ?? decision.decisionId}: ${e.message} — ${disposition}`);
                    return { ok: false, class: "receipt-failed", detail: e.message };
                }
                if (receiptRetained) {
                    try {
                        opts.attempted.mark(`${receiptKey}${TRANSPORT_FAILURE_RECEIPT_REPAIRED}`, "transport-failure-receipt-repaired");
                    }
                    catch (e) {
                        log(`transport-failed receipt repair marker FAILED for ${q.qitemId ?? decision.decisionId}: ${e.message} — authoritative receipt landed; pending marker retained for idempotent repair`);
                        return { ok: false, class: "receipt-failed", detail: e.message };
                    }
                }
            }
            return { ok: false, class: failureClass, detail: res.error };
        }
        // OPR.0.5.6.14 — the 8f291c37 shape dies by RETAIN-AND-REPAIR: a receipt
        // write that throws after a successful post is a clean retained outcome
        // (never an escaped throw); the replay reconciles by marker — the message
        // IS in the channel — and retries the idempotent receipt without reposting.
        try {
            if (threadTs === undefined)
                opts.onPostedRoot?.(q, res.ts);
            opts.onPosted?.(q, res.ts, threadTs);
        }
        catch (e) {
            log(`receipt write FAILED after successful post for ${q.qitemId ?? decision.decisionId}: ${e.message} — retained; replay reconciles by marker and retries the idempotent receipt`);
            return { ok: false, class: "receipt-failed", detail: e.message };
        }
        // Delivered is complete only after the authoritative row receipt succeeds. A receipt
        // failure retains the decision; replay reconciles by marker and retries the idempotent receipt.
        opts.delivered.mark(decision.decisionId, "delivered");
        if (markEpisode && q.qitemId) {
            const key = q.notificationKey ?? q.qitemId;
            opts.outboundSeen.mark(key, "posted");
            opts.release?.(key);
        }
        // G — a LOCAL image evidenceRef (the founder screenshot) rides the EXTERNAL-UPLOAD flow
        // into the conversation thread (files.upload is sunset). Upload failure is fail-VISIBLE
        // but does NOT fail the decision: the text delivered; failing here would replay the whole
        // post and duplicate the human notification (the H red). https refs already rode as Block
        // Kit image blocks above; non-image/non-existent refs are a clean skip.
        const local = q.evidenceRef && !/^https:\/\//.test(String(q.evidenceRef))
            ? (opts.readLocalImage ?? defaultReadLocalImage)(String(q.evidenceRef))
            : null;
        if (local) {
            const intoThread = threadTs ?? res.ts;
            const up = await getUploadURLExternal(opts.botToken, local.filename, local.bytes.length, opts.fetchImpl);
            if (up.ok && up.uploadUrl && up.fileId) {
                const put = await uploadBytesExternal(up.uploadUrl, local.bytes, opts.fetchImpl);
                if (put.ok) {
                    const done = await completeUploadExternal(opts.botToken, { files: [{ id: up.fileId, title: q.summary ?? local.filename }], channelId: opts.channel, threadTs: intoThread }, opts.fetchImpl);
                    if (done.ok)
                        log(`uploaded ${local.filename} into thread ${intoThread ?? "(root)"} for ${q.qitemId ?? decision.decisionId}`);
                    else
                        log(`ATTACHMENT upload complete FAILED for ${q.qitemId ?? decision.decisionId}: ${done.error} (text delivered; attachment missing)`);
                }
                else {
                    log(`ATTACHMENT byte upload FAILED for ${q.qitemId ?? decision.decisionId}: ${put.error} (text delivered; attachment missing)`);
                }
            }
            else {
                log(`ATTACHMENT upload-url FAILED for ${q.qitemId ?? decision.decisionId}: ${up.error} (text delivered; attachment missing)`);
            }
        }
        log(`delivered ${decision.decisionId}${q.qitemId ? ` (qitem ${q.qitemId})` : ""}`);
        return { ok: true };
    };
}
/** One authored primary and, optionally, one coherent supplemental reply. The
 * existing attempted/delivered stores and marker reconciler own each stable part.
 * Preflight ALL parts before posting; the episode receipt is written only after
 * every required part. A restart retries missing parts and the final receipt. */
export function subsystemSlackDeliver(opts) {
    return async (decision) => {
        if (opts.delivered.load().has(decision.decisionId))
            return { ok: true };
        const q = (decision.payload ?? {});
        const parts = q.humanDetail
            ? [
                { ...q, humanDetail: undefined, body: `${q.body ?? ""}\n\nSupplemental detail follows in this thread.` },
                { ...q, humanDetail: undefined, summary: `Supplemental detail: ${q.summary ?? ""}`, body: q.humanDetail, media: [], evidenceRef: null },
            ]
            : [q];
        const partId = (index) => parts.length === 1 ? decision.decisionId : `${decision.decisionId}:part:${index + 1}`;
        try {
            for (const [index, part] of parts.entries()) {
                buildOutboundMessage(part, {
                    sourceLabel: opts.sourceLabel,
                    attribution: attributionFromSession(part.sourceSession),
                    mentionUserId: index === 0 ? opts.resolveMentionUserId?.(q) : undefined,
                    reconcileMarker: reconcileToken(partId(index)),
                    mediaRefs: Array.isArray(part.media) ? part.media : part.evidenceRef ? [{ imageUrl: part.evidenceRef, altText: part.summary ?? "attachment" }] : undefined,
                });
            }
        }
        catch (error) {
            const detail = error.message;
            try {
                opts.onTransportFailed?.(q, "human-message-unrenderable", detail);
            }
            catch (receiptError) {
                return { ok: false, class: "receipt-failed", detail: receiptError.message };
            }
            return { ok: false, class: "human-message-unrenderable", detail };
        }
        if (parts.length === 1)
            return deliverSinglePart(opts)(decision);
        const rootPrefix = `${decision.decisionId}::primary-receipt::`;
        const retained = [...opts.attempted.load()].find((key) => key.startsWith(rootPrefix));
        let primary = retained
            ? JSON.parse(Buffer.from(retained.slice(rootPrefix.length), "base64url").toString("utf8"))
            : undefined;
        for (const [index, part] of parts.entries()) {
            if (index > 0 && (!primary || primary.messageTs === "reconciled")) {
                return { ok: false, class: "receipt-failed", detail: "Supplemental delivery requires the actual primary Slack timestamp; retain for reconciliation." };
            }
            const outcome = await deliverSinglePart({
                ...opts,
                resolveMentionUserId: index === 0 ? opts.resolveMentionUserId : undefined,
                resolveThreadTs: index === 0 ? opts.resolveThreadTs : () => primary.threadTs ?? primary.messageTs,
                onPostedRoot: index === 0 ? opts.onPostedRoot : undefined,
                onPosted: (_part, messageTs, threadTs) => {
                    if (index !== 0)
                        return;
                    if (messageTs === "reconciled")
                        throw new Error("Primary reconciliation has no Slack timestamp; multipart delivery remains incomplete.");
                    primary = { messageTs, threadTs };
                    opts.attempted.mark(rootPrefix + Buffer.from(JSON.stringify(primary)).toString("base64url"), "primary-receipt");
                },
            }, false)({ ...decision, decisionId: partId(index), payload: part });
            if (!outcome.ok)
                return outcome;
        }
        try {
            if (!primary)
                throw new Error("Primary receipt unavailable; retain multipart delivery.");
            opts.onPosted?.(q, primary.messageTs, primary.threadTs);
            opts.delivered.mark(decision.decisionId, "all-parts-delivered");
            if (q.qitemId) {
                const key = q.notificationKey ?? q.qitemId;
                opts.outboundSeen.mark(key, "posted");
                opts.release?.(key);
            }
            return { ok: true };
        }
        catch (error) {
            return { ok: false, class: "receipt-failed", detail: error.message };
        }
    };
}
