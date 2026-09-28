// Memory Books (ST-MemoryBooks, aikohanasaki) — verified against 9.1.1.
//
// What it stores by message index:
//   chat_metadata.STMemoryBooks.{highestMemoryProcessed, sceneStart, sceneEnd, autoSummaryNextPromptAt}
//   lorebook entries: STMB_start/STMB_end (scoped by STMB_chatId),
//     STMB_sidePromptRegeneration.{sceneStart,sceneEnd} (scoped by its chatId),
//     STMB_sp_<key>_lastMsgId / STMB_tracker_lastMsgId / STMB_score_lastMsgId,
//     data.extensions.aikobots.topical_clip.last_message_source.{start,end} (cosmetic).
// It has no API for any of this, so we edit its data directly and log every
// field we touch so undo can put it back.

import { ctx, clone, LOG } from '../st.js';
import { mapPoint, mapRange, newReport } from './remap.js';

const KNOWN_MAJOR = 9;
const LAST_MSG_RE = /^STMB_(sp_.+|tracker|score)_lastMsgId$/;

let versionCache;
async function stmbVersion() {
    if (versionCache !== undefined) return versionCache;
    versionCache = null;
    for (const folder of ['SillyTavern-MemoryBooks', 'ST-MemoryBooks']) {
        try {
            const res = await fetch(`/scripts/extensions/third-party/${folder}/manifest.json`, { cache: 'no-store' });
            if (res.ok) {
                versionCache = String((await res.json()).version ?? '');
                break;
            }
        } catch { /* try next */ }
    }
    return versionCache;
}

function label(entry) {
    return `"${entry.comment || entry.key?.[0] || `uid ${entry.uid}`}"`;
}

function getPath(obj, path) {
    return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = value;
}

function nextUid(data) {
    const uids = Object.values(data.entries).map(e => Number(e.uid)).filter(Number.isFinite);
    return uids.length ? Math.max(...uids) + 1 : 0;
}

/** Branch lorebook copies STMB made for the source chat: copyName -> parent book name. */
function branchCopyMap(sourceMetadata) {
    const map = new Map();
    const marker = sourceMetadata?.STMemoryBooks?.branchLorebookCopies;
    for (const m of marker?.mappings ?? []) {
        if (m?.copyName && m?.sourceName) map.set(String(m.copyName), String(m.sourceName));
    }
    return map;
}

function isStmbEntry(e) {
    return e && (e.stmemorybooks || e.STMB_chatId !== undefined || e.STMB_sidePromptRegeneration
        || Object.keys(e).some(k => LAST_MSG_RE.test(k)) || e.data?.extensions?.aikobots?.topical_clip);
}

export default {
    id: 'memorybooks',
    label: 'Memory Books',

    detect() {
        const c = ctx();
        return !!(c.extensionSettings?.STMemoryBooks || c.chatMetadata?.STMemoryBooks);
    },

    preflight() {
        const stmb = ctx().chatMetadata?.STMemoryBooks;
        const blockers = [];
        if (stmb && (stmb.sceneStart != null || stmb.sceneEnd != null)) {
            blockers.push('Memory Books scene markers (► / ◄) are set. Clear them first: Memory Books keeps them in an internal cache that would overwrite any shifted values.');
        }
        return blockers;
    },

    /**
     * @param {import('./remap.js').RetconOp} op
     * @param {object|null} prevLog this adapter's log from the merge (undo only)
     */
    async prepare(op, prevLog = null) {
        const report = newReport();
        const c = ctx();
        const chatId = String(op.chatId);
        const undo = op.direction === 'undo';

        const version = await stmbVersion();
        if (!version || Number(version.split('.')[0]) !== KNOWN_MAJOR) {
            report.warnings.push(`Memory Books version ${version ?? 'unknown'} was not verified with this extension (built for ${KNOWN_MAJOR}.x). Check the report carefully.`);
        }

        // Fields changed at merge time, keyed "book|uid|path". Undo restores these
        // and leaves everything else to the inverse remap.
        const logged = new Map();
        for (const f of prevLog?.fields ?? []) logged.set(`${f.book}|${f.uid}|${f.path.join('.')}`, f);
        const loggedEntries = new Set((prevLog?.fields ?? []).map(f => `${f.book}|${f.uid}`));
        const createdEntries = new Set((prevLog?.created ?? []).map(x => `${x.book}|${x.uid}`));

        /** @type {Map<string, {name: string, original: object, updated: object}>} */
        const books = new Map();
        const fields = [];
        const created = [];

        const touch = (name, original) => {
            if (!books.has(name)) books.set(name, { name, original, updated: clone(original) });
            return books.get(name);
        };
        const change = (name, original, uid, path, value) => {
            const b = touch(name, original);
            const entry = b.updated.entries[uid];
            const before = getPath(entry, path);
            if (before === value) return;
            setPath(entry, path, value);
            fields.push({ book: name, uid: String(uid), path, before, after: value });
        };

        const copyMap = undo ? new Map() : branchCopyMap(op.sourceMetadata);
        const adopt = !undo && !!op.options.adoptBranchMemories && !!op.sourceChat;
        let adoptedCount = 0;

        const names = c.getWorldInfoNames();
        for (const name of names) {
            let original;
            try {
                original = await c.loadWorldInfo(name);
            } catch (e) {
                console.warn(LOG, 'could not load lorebook', name, e);
                continue;
            }
            if (!original?.entries) continue;
            const entries = Object.entries(original.entries).filter(([, e]) => isStmbEntry(e));
            if (!entries.length) continue;

            for (const [uid, e] of entries) {
                const entryKey = `${name}|${uid}`;
                if (createdEntries.has(entryKey)) continue; // removed below

                // --- undo: restore what the merge changed, if nobody changed it since
                if (undo && loggedEntries.has(entryKey)) {
                    for (const f of prevLog.fields.filter(x => x.book === name && x.uid === String(uid))) {
                        const cur = getPath(e, f.path);
                        if (cur === f.after) {
                            change(name, original, uid, f.path, f.before);
                        } else {
                            report.conflicts.push(`${name}: ${label(e)} ${f.path.join('.')} changed since the merge (${f.after} → ${cur}); not reverted.`);
                        }
                    }
                    continue;
                }

                // --- memories of this chat: remap ranges
                if (e.stmemorybooks && String(e.STMB_chatId) === chatId) {
                    const s = Number(e.STMB_start), en = Number(e.STMB_end);
                    if (Number.isFinite(s) && Number.isFinite(en)) {
                        const r = mapRange(s, en, op);
                        if (r.kind === 'after') {
                            change(name, original, uid, ['STMB_start'], r.s);
                            change(name, original, uid, ['STMB_end'], r.e);
                        } else if (r.kind === 'contains') {
                            change(name, original, uid, ['STMB_end'], r.e);
                            report.warnings.push(`${name}: memory ${label(e)} (${s}-${en}) covered the replaced messages; now ${r.s}-${r.e}. Its text still describes the old version; consider regenerating it.`);
                        } else if (r.kind === 'overlap') {
                            report.conflicts.push(`${name}: memory ${label(e)} (${s}-${en}) partially overlaps the replaced messages; left unchanged.`);
                        }
                    }
                }

                // --- side prompt snapshot + lastMsgId fields (only trustworthy when the snapshot names this chat)
                const snap = e.STMB_sidePromptRegeneration;
                const lastKeys = Object.keys(e).filter(k => LAST_MSG_RE.test(k) && Number.isFinite(Number(e[k])));
                if (snap && String(snap.chatId) === chatId) {
                    const s = Number(snap.sceneStart), en = Number(snap.sceneEnd);
                    if (Number.isFinite(s) && Number.isFinite(en)) {
                        const r = mapRange(s, en, op);
                        if (r.kind === 'after' || r.kind === 'contains') {
                            change(name, original, uid, ['STMB_sidePromptRegeneration', 'sceneStart'], r.s);
                            change(name, original, uid, ['STMB_sidePromptRegeneration', 'sceneEnd'], r.e);
                        } else if (r.kind === 'overlap') {
                            report.conflicts.push(`${name}: side prompt ${label(e)} regeneration range ${s}-${en} overlaps the replaced messages; left unchanged.`);
                        }
                    }
                    for (const k of lastKeys) {
                        const p = mapPoint(Number(e[k]), op);
                        if (p.kind === 'shift') change(name, original, uid, [k], p.value);
                        if (p.kind === 'inside') {
                            change(name, original, uid, [k], op.start - 1);
                            report.warnings.push(`${name}: side prompt ${label(e)} had processed up to a replaced message; reset ${k} to ${op.start - 1} so the new messages get processed.`);
                        }
                    }
                } else if (lastKeys.some(k => Number(e[k]) >= op.start)) {
                    report.warnings.push(`${name}: side prompt ${label(e)} has ${lastKeys.join(', ')} without a chat id; cannot tell which chat it belongs to, left unchanged.`);
                }

                // --- topical clip (informational only)
                const clip = e.data?.extensions?.aikobots?.topical_clip?.last_message_source;
                if (clip && String(clip.chat_id) === chatId && Number.isFinite(Number(clip.start))) {
                    const r = mapRange(Number(clip.start), Number(clip.end), op);
                    if (r.kind === 'after' || r.kind === 'contains') {
                        const base = ['data', 'extensions', 'aikobots', 'topical_clip', 'last_message_source'];
                        change(name, original, uid, [...base, 'start'], r.s);
                        change(name, original, uid, [...base, 'end'], r.e);
                    }
                }

                // --- adopt memories written in the branch
                if (adopt && e.stmemorybooks && String(e.STMB_chatId) === String(op.sourceChat)) {
                    const s = Number(e.STMB_start), en = Number(e.STMB_end);
                    if (!Number.isFinite(s) || !Number.isFinite(en)) continue;
                    if (en < op.srcStart) continue; // covers shared history, not the merged scene
                    if (s < op.srcStart || en > op.srcEnd) {
                        report.conflicts.push(`${name}: branch memory ${label(e)} (${s}-${en}) is only partly inside the merged range (${op.srcStart}-${op.srcEnd}); not adopted.`);
                        continue;
                    }
                    const ns = op.start + (s - op.srcStart);
                    const ne = op.start + (en - op.srcStart);
                    const parentBook = copyMap.get(name);
                    if (parentBook && names.includes(parentBook)) {
                        // STMB made a separate lorebook for the branch: copy into the parent's book.
                        const targetOriginal = await c.loadWorldInfo(parentBook);
                        const t = touch(parentBook, targetOriginal);
                        const newUid = nextUid(t.updated);
                        const copy = clone(e);
                        copy.uid = newUid;
                        copy.STMB_chatId = chatId;
                        copy.STMB_start = ns;
                        copy.STMB_end = ne;
                        if (copy.STMB_canonicalLorebook === name) copy.STMB_canonicalLorebook = parentBook;
                        if (String(copy.STMB_canonicalEntryUid) === String(uid)) copy.STMB_canonicalEntryUid = newUid;
                        t.updated.entries[newUid] = copy;
                        created.push({ book: parentBook, uid: String(newUid) });
                        report.info.push(`Adopt branch memory ${label(e)} → copy into "${parentBook}" as ${ns}-${ne}.`);
                        if (copy.STMB_memoryNumber != null) {
                            report.warnings.push(`Adopted memory ${label(e)} keeps its branch memory number (${copy.STMB_memoryNumber}); numbering in "${parentBook}" may now have a duplicate.`);
                        }
                    } else {
                        change(name, original, uid, ['STMB_chatId'], chatId);
                        change(name, original, uid, ['STMB_start'], ns);
                        change(name, original, uid, ['STMB_end'], ne);
                        report.info.push(`Adopt branch memory ${label(e)} in "${name}" → ${ns}-${ne}.`);
                    }
                    adoptedCount++;
                }
            }
        }

        // --- undo: remove entries the merge created
        if (undo) {
            for (const cr of prevLog?.created ?? []) {
                const original = await c.loadWorldInfo(cr.book).catch(() => null);
                if (!original?.entries?.[cr.uid]) continue;
                const b = touch(cr.book, original);
                delete b.updated.entries[cr.uid];
                report.info.push(`Remove adopted memory copy uid ${cr.uid} from "${cr.book}".`);
            }
        }

        const changedFields = fields.length;
        if (changedFields) report.info.push(`${changedFields} lorebook field(s) updated across ${books.size} lorebook(s).`);
        if (!undo && op.options.adoptBranchMemories && op.sourceChat && adoptedCount === 0) {
            report.info.push('No Memory Books memories from the branch fall inside the merged range.');
        }
        if (!undo && op.sourceChat) {
            report.info.push('Memory titles with {{scene}} ranges keep their old numbers (Memory Books never reads them back).');
        }

        // --- chat metadata
        const stmbMeta = c.chatMetadata?.STMemoryBooks;
        const metaPlan = [];
        if (stmbMeta) {
            const h = stmbMeta.highestMemoryProcessed;
            const prevH = prevLog?.meta?.find(m => m.key === 'highestMemoryProcessed');
            if (undo && prevH && h === prevH.after) {
                metaPlan.push({ key: 'highestMemoryProcessed', before: h, after: prevH.before });
            } else if (Number.isFinite(h)) {
                const p = mapPoint(h, op);
                if (p.kind === 'shift') metaPlan.push({ key: 'highestMemoryProcessed', before: h, after: p.value });
                if (p.kind === 'inside') {
                    const processed = op.options.stmbHighest === 'processed';
                    const after = processed ? op.start + op.inserted - 1 : op.start - 1;
                    metaPlan.push({ key: 'highestMemoryProcessed', before: h, after: after >= 0 ? after : null });
                    report.warnings.push(`Memory Books "highest processed" (${h}) is inside the replaced messages → ${after} (${processed ? 'new messages count as processed' : 'new messages will be picked up by /nextmemory'}).`);
                }
            }
            const a = stmbMeta.autoSummaryNextPromptAt;
            if (Number.isFinite(a) && a > op.start) metaPlan.push({ key: 'autoSummaryNextPromptAt', before: a, after: a + op.delta });
            for (const m of metaPlan) {
                if (m.key === 'highestMemoryProcessed') report.info.push(`Memory Books highest processed message: ${m.before} → ${m.after}.`);
            }
        }

        return {
            report,
            books: [...books.values()],
            applyMeta(metadata) {
                const target = metadata.STMemoryBooks;
                if (!target) return;
                for (const m of metaPlan) target[m.key] = m.after;
            },
            log: { fields, created, meta: metaPlan },
        };
    },
};
