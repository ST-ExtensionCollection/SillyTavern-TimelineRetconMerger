// WorldTracker — LEGACY FALLBACK.
//
// Current WorldTracker handles the 'timeline_retcon_applied' event itself
// (sets globalThis.WorldTracker.handlesRetconEvent, see WorldTracker/docs/API.md)
// and stashes/restores dropped entries by retconId, so this adapter steps aside.
// The code below only runs for WorldTracker builds without that flag.
//
// chat_metadata.WorldTracker keeps:
//   snapshots { [mesId]: {kf, data} | {base: mesId, patch} }  pre-turn state per message
//   history   [{ mesId, swipeId, ... }]
//   pending   [{ sourceMessageId, ... }]
// Snapshot/history/pending for replaced messages are dropped (logged for undo);
// everything after the range is re-keyed; deltas whose base chain runs through a
// dropped snapshot are rebuilt as keyframes first, using WorldTracker's own reader.
// If WorldTracker ever handles the 'timeline_retcon_applied' event itself, this
// adapter steps aside (see supportsRetconEvent below).

import { ctx, clone } from '../st.js';
import { mapPoint, newReport } from './remap.js';

const STATE_URL = '/scripts/extensions/third-party/WorldTracker/src/state.js';

function supportsRetconEvent(st) {
    return !!(globalThis.WorldTracker?.handlesRetconEvent || st?.supportsRetconEvent);
}

async function loadPeek() {
    try {
        const mod = await import(STATE_URL);
        return typeof mod.peekSnapshot === 'function' ? mod.peekSnapshot : null;
    } catch {
        return null;
    }
}

function chainKeys(snapshots, key) {
    const seen = [];
    let k = key;
    for (let i = 0; i < 300; i++) {
        const e = snapshots[k];
        if (!e || e.kf || !('base' in e)) break;
        k = Number(e.base);
        seen.push(k);
    }
    return seen;
}

export default {
    id: 'worldtracker',
    label: 'WorldTracker',

    detect() {
        const st = ctx().chatMetadata?.WorldTracker;
        return !!st && typeof st === 'object';
    },

    preflight() {
        return [];
    },

    async prepare(op, prevLog = null) {
        const report = newReport();
        const live = ctx().chatMetadata?.WorldTracker;
        if (!live) return { report, books: [], applyMeta() {}, log: null };
        if (supportsRetconEvent(live)) {
            report.info.push('WorldTracker re-keys its own saved states when notified.');
            const old = prevLog?.removed;
            if (op.direction === 'undo' && old && (Object.keys(old.snapshots ?? {}).length || old.history?.length || old.pending?.length)) {
                report.warnings.push('This merge was made before WorldTracker handled retcons itself. The tracker states it dropped cannot be put back; those messages fall back to the nearest earlier saved state.');
            }
            return { report, books: [], applyMeta() {}, log: null };
        }

        const st = clone(live);
        const snaps = st.snapshots && typeof st.snapshots === 'object' ? st.snapshots : {};
        const keys = Object.keys(snaps).map(Number).filter(Number.isFinite);

        // Keep the snapshot AT start (state before the range = valid pre-state for
        // the new first message). Drop the rest of the replaced span.
        const dropped = new Set(keys.filter(k => {
            const p = mapPoint(k, op);
            return p.kind === 'inside' && !(k === op.start && op.removed > 0 && op.inserted > 0);
        }));
        const removedLog = { snapshots: {}, history: [], pending: [] };

        const needRebuild = keys.filter(k => !dropped.has(k) && chainKeys(snaps, k).some(b => dropped.has(b)));
        if (needRebuild.length) {
            const peek = await loadPeek();
            if (!peek) {
                report.blockers.push('WorldTracker: some saved states depend on states of replaced messages and WorldTracker\'s state module could not be loaded to rebuild them.');
                return { report, books: [], applyMeta() {}, log: null };
            }
            for (const k of needRebuild) {
                const full = peek(live, k);
                if (!full) {
                    report.blockers.push(`WorldTracker: could not rebuild saved state #${k}.`);
                    return { report, books: [], applyMeta() {}, log: null };
                }
                snaps[k] = { kf: true, data: full };
            }
        }

        const newSnaps = {};
        for (const k of keys) {
            if (dropped.has(k)) {
                removedLog.snapshots[k] = clone(live.snapshots[k]);
                continue;
            }
            const e = snaps[k];
            const nk = mapPoint(k, op).kind === 'shift' ? k + op.delta : k;
            if (e && !e.kf && 'base' in e) {
                const b = Number(e.base);
                e.base = mapPoint(b, op).kind === 'shift' ? b + op.delta : b;
            }
            newSnaps[nk] = e;
        }

        const remapList = (list, field) => (Array.isArray(list) ? list : []).filter(item => {
            const v = item?.[field];
            if (!Number.isInteger(v)) return true;
            const p = mapPoint(v, op);
            if (p.kind === 'inside') {
                removedLog[field === 'mesId' ? 'history' : 'pending'].push(clone(item));
                return false;
            }
            if (p.kind === 'shift') item[field] = p.value;
            return true;
        });
        const newHistory = remapList(st.history, 'mesId');
        const newPending = remapList(st.pending, 'sourceMessageId');

        // Undo: put back what the merge dropped (keys are pre-merge positions again).
        if (op.direction === 'undo' && prevLog?.removed) {
            for (const [k, v] of Object.entries(prevLog.removed.snapshots ?? {})) {
                if (!(k in newSnaps)) newSnaps[k] = v;
            }
            newHistory.push(...(prevLog.removed.history ?? []));
            newHistory.sort((a, b) => (a.mesId ?? 0) - (b.mesId ?? 0));
            newPending.push(...(prevLog.removed.pending ?? []));
        }

        const shifted = keys.filter(k => mapPoint(k, op).kind === 'shift').length;
        const droppedCount = dropped.size + removedLog.history.length + removedLog.pending.length;
        if (shifted) report.info.push(`WorldTracker: ${shifted} saved state(s) re-keyed by ${op.delta >= 0 ? '+' : ''}${op.delta}.`);
        if (droppedCount) {
            report.warnings.push(`WorldTracker: ${dropped.size} saved state(s), ${removedLog.history.length} history record(s), ${removedLog.pending.length} pending change(s) belonged to replaced messages and are dropped (restored on undo). Tracked world state for the new messages starts from the state before the range.`);
        }
        if (needRebuild.length) report.info.push(`WorldTracker: ${needRebuild.length} delta state(s) rebuilt as full keyframes.`);

        return {
            report,
            books: [],
            applyMeta(metadata) {
                const target = metadata.WorldTracker;
                if (!target) return;
                target.snapshots = newSnaps;
                target.history = newHistory;
                target.pending = newPending;
            },
            log: { removed: removedLog },
        };
    },
};
