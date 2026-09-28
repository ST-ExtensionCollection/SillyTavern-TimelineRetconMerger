// Merge / undo. Order of operations for both:
//   validate → flush pending save → adapters prepare (fail closed on blockers)
//   → backup chat + lorebooks → splice chat in place → adapter metadata edits
//   → save chat → save lorebooks → notify → reload chat.
// MESSAGE_DELETED is deliberately never emitted: WorldTracker and Memory Books
// treat it as a tail deletion and would roll their own state back.

import { ctx, meta, clone, busyReason, currentChatRef, currentGroup, deleteChat, LOG } from './st.js';
import { divergenceIndex, rangeHash } from './diff.js';
import { createBackup } from './chatio.js';
import { makeOp, newReport } from './adapters/remap.js';
import memorybooks from './adapters/memorybooks.js';
import worldtracker from './adapters/worldtracker.js';
import { coreAdapter, warnOnlyAdapter } from './adapters/core.js';

export const RETCON_EVENT = 'timeline_retcon_applied';
const ADAPTERS = [memorybooks, worldtracker, coreAdapter, warnOnlyAdapter];

export function retconState(metadata = meta()) {
    metadata.timelineRetcon ??= { version: 1, retcons: [] };
    metadata.timelineRetcon.retcons ??= [];
    return metadata.timelineRetcon;
}

/** Read-only list; never creates the metadata key (that would dirty the chat). */
export function readRetcons(metadata = meta()) {
    return metadata?.timelineRetcon?.retcons ?? [];
}

export function getRetcon(id) {
    return readRetcons().find(r => r.id === id) ?? null;
}

function forEachExtra(msg, fn) {
    msg.extra ??= {};
    fn(msg.extra);
    for (const si of msg.swipe_info ?? []) {
        if (si && typeof si === 'object') {
            si.extra ??= {};
            fn(si.extra);
        }
    }
}

/** Clean a message copied from the branch and tag it as part of retcon `id`. */
function prepareInserted(msg, id, pos) {
    const m = clone(msg);
    forEachExtra(m, extra => {
        delete extra.bookmark_link; // points at the branch's own checkpoints
        delete extra.branches;
        delete extra.trm_pending;
        extra.trm = { retconId: id, pos };
    });
    return m;
}

function chatHash(chat) {
    return rangeHash(chat);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Validates the user's choices and builds an immutable plan. Returns
 * { plan } or { error } — never guesses.
 * @param {object} args
 * @param {string} args.sourceName
 * @param {{metadata: object, messages: object[]}} args.source
 * @param {'replace'|'insert'} args.mode
 * @param {number} args.srcEnd last source message to take (inclusive)
 * @param {number} args.tStart first target index (replace) / insertion index (insert)
 * @param {number} [args.tEnd] last target index to replace (replace only)
 * @param {object} args.options
 */
export function buildMergePlan({ sourceName, source, mode, srcEnd, tStart, tEnd, options }) {
    const ref = currentChatRef();
    if (!ref) return { error: 'No chat is open.' };
    const chat = ctx().chat;
    const src = source.messages;
    const d = divergenceIndex(chat, src);
    const warnings = [];

    if (d === 0) return { error: 'The source chat shares no history with this chat (first message differs). Refusing to merge.' };
    if (d >= src.length) return { error: 'The source chat has no messages after the point where it matches this chat.' };
    if (!Number.isInteger(srcEnd) || srcEnd < d || srcEnd >= src.length) {
        return { error: `Source end must be between ${d} and ${src.length - 1}.` };
    }

    let removed;
    if (mode === 'replace') {
        if (!Number.isInteger(tStart) || !Number.isInteger(tEnd) || tEnd < tStart) return { error: 'Target range is invalid.' };
        if (tStart < d) return { error: `Target start (${tStart}) is inside history both chats share (0-${d - 1}). Refusing: that would overwrite shared messages.` };
        if (tEnd >= chat.length) return { error: `Target end (${tEnd}) is past the last message (${chat.length - 1}).` };
        removed = tEnd - tStart + 1;
    } else {
        if (!Number.isInteger(tStart) || tStart < d || tStart > chat.length) {
            return { error: `Insertion point must be between ${d} and ${chat.length}.` };
        }
        removed = 0;
    }
    if (tStart > d) {
        warnings.push(`The branch split off at message ${d}, but you are placing its messages at ${tStart}: messages ${d}-${tStart - 1} of this chat were never seen by the branch.`);
    }
    const mainChat = source.metadata?.main_chat;
    if (mainChat !== ref.chatId) {
        warnings.push(mainChat
            ? `The source is a branch of "${mainChat}", not of this chat. Shared history was still verified message by message.`
            : 'The source has no parent-chat link. Shared history was still verified message by message.');
    }

    const taken = src.slice(d, srcEnd + 1);
    const group = currentGroup();
    if (group) {
        const members = new Set(group.members ?? []);
        const strangers = new Set(taken.filter(m => !m.is_user && m.original_avatar && !members.has(m.original_avatar)).map(m => m.name));
        if (strangers.size) warnings.push(`Merged messages from characters no longer in this group: ${[...strangers].join(', ')}. They keep their names and avatars.`);
    }
    const childLinks = taken.filter(m => m.extra?.bookmark_link || m.extra?.branches?.length).length;
    if (childLinks) warnings.push(`${childLinks} merged message(s) had checkpoint/branch links inside the branch; those links are not carried over.`);

    return {
        plan: {
            ref,
            sourceName,
            sourceMetadata: source.metadata,
            divergence: d,
            srcStart: d,
            srcEnd,
            mode,
            tStart,
            removed,
            inserted: taken.length,
            messages: taken,
            replaced: clone(chat.slice(tStart, tStart + removed)),
            chatLength: chat.length,
            chatHash: chatHash(chat),
            options: { adoptBranchMemories: true, stmbHighest: 'unprocessed', removeCheckpointLink: true, deleteSource: false, ...options },
            warnings,
        },
    };
}

function mergeOp(plan) {
    return makeOp({
        direction: 'merge',
        chatId: plan.ref.chatId,
        start: plan.tStart,
        removed: plan.removed,
        inserted: plan.inserted,
        sourceChat: plan.sourceName,
        srcStart: plan.srcStart,
        srcEnd: plan.srcEnd,
        sourceMetadata: plan.sourceMetadata,
        options: plan.options,
    });
}

function checkStillValid(plan) {
    const busy = busyReason();
    if (busy) return busy;
    const ref = currentChatRef();
    if (!ref || ref.chatId !== plan.ref.chatId) return 'The open chat changed since the preview.';
    const chat = ctx().chat;
    if (chat.length !== plan.chatLength || chatHash(chat) !== plan.chatHash) return 'This chat changed since the preview. Open the merge dialog again.';
    return null;
}

async function prepareAll(op, logs = {}) {
    const results = [];
    const report = newReport();
    for (const a of ADAPTERS) {
        if (!a.detect()) continue;
        report.blockers.push(...a.preflight(op));
        const r = await a.prepare(op, logs[a.id] ?? null);
        results.push({ adapter: a, ...r });
        for (const k of ['info', 'warnings', 'conflicts', 'blockers']) report[k].push(...r.report[k].map(x => ({ source: a.label, text: x })));
    }
    report.blockers = report.blockers.map(x => (typeof x === 'string' ? { source: 'Preflight', text: x } : x));
    return { results, report };
}

/** Dry run for the preview dialog. Changes nothing. */
export async function previewMerge(plan) {
    const { report } = await prepareAll(mergeOp(plan));
    const busy = busyReason();
    if (busy) report.blockers.unshift({ source: 'SillyTavern', text: busy });
    report.warnings.unshift(...plan.warnings.map(text => ({ source: 'Merge', text })));
    if (plan.options.removeCheckpointLink) {
        const links = ctx().chat.filter(m => m.extra?.bookmark_link === plan.sourceName).length;
        if (links) report.info.unshift({ source: 'Merge', text: `Checkpoint link to "${plan.sourceName}" will be removed from ${links} message(s).` });
    }
    return report;
}

function uniqueBooks(results) {
    const map = new Map();
    for (const r of results) for (const b of r.books ?? []) {
        if (map.has(b.name)) throw new Error(`Two adapters want to write lorebook "${b.name}"; refusing.`);
        map.set(b.name, b);
    }
    return [...map.values()];
}

async function commit({ label, op, results, mutateChat, afterMeta }) {
    const books = uniqueBooks(results);
    const backup = await createBackup(op.chatRef, label, books.map(b => ({ name: b.name, data: b.original })));

    let chatSaved = false;
    try {
        mutateChat(ctx().chat);
        const md = meta();
        for (const r of results) r.applyMeta(md);
        afterMeta?.(md, backup);
        md.tainted = true;
        await ctx().saveChat();
        chatSaved = true;
    } catch (e) {
        console.error(LOG, 'commit failed before chat save; reloading from disk', e);
        if (!chatSaved) await ctx().reloadCurrentChat().catch(() => {});
        throw new Error(`Nothing was changed (chat reloaded from disk). ${e.message}`);
    }

    const failedBooks = [];
    for (const b of books) {
        try {
            await ctx().saveWorldInfo(b.name, b.updated, true);
        } catch (e) {
            console.error(LOG, 'lorebook save failed', b.name, e);
            failedBooks.push(b.name);
        }
    }

    // retconId lets listeners (WorldTracker) pair a merge with its undo; start can differ between the two.
    await ctx().eventSource.emit(RETCON_EVENT, {
        direction: op.direction, chatId: op.chatId, retconId: op.retconId,
        start: op.start, removed: op.removed, inserted: op.inserted,
    });
    await ctx().reloadCurrentChat();

    if (failedBooks.length) {
        throw new Error(`Chat was saved, but these lorebooks failed to save: ${failedBooks.join(', ')}. Backup ${backup.id} has their previous state.`);
    }
    return backup;
}

function removeLinksTo(chat, name) {
    let n = 0;
    for (const m of chat) {
        forEachExtra(m, extra => {
            if (extra.bookmark_link === name) {
                delete extra.bookmark_link;
                n++;
            }
            if (Array.isArray(extra.branches)) extra.branches = extra.branches.filter(b => b !== name);
        });
    }
    return n;
}

/** Applies a previewed plan. Throws with a readable message on refusal/failure. */
export async function applyMerge(plan) {
    const invalid = checkStillValid(plan);
    if (invalid) throw new Error(invalid);
    await ctx().saveChat();

    const op = mergeOp(plan);
    op.chatRef = plan.ref;
    const { results, report } = await prepareAll(op);
    if (report.blockers.length) throw new Error(report.blockers.map(b => b.text).join('\n'));

    const id = ctx().uuidv4();
    op.retconId = id;
    const inserted = plan.messages.map((m, i) => prepareInserted(m, id, i));
    const record = {
        id,
        createdAt: new Date().toISOString(),
        label: `${plan.sourceName}`,
        mode: plan.mode,
        sourceChat: plan.sourceName,
        startAtMerge: plan.tStart,
        removedCount: plan.removed,
        mergedCount: inserted.length,
        mergedHash: rangeHash(inserted),
        original: clone(plan.replaced),
        adapterLogs: Object.fromEntries(results.filter(r => r.log).map(r => [r.adapter.id, r.log])),
        backupId: null,
    };

    const backup = await commit({
        label: `before merge from "${plan.sourceName}"`,
        op,
        results,
        mutateChat(chat) {
            chat.splice(plan.tStart, plan.removed, ...inserted);
            if (plan.options.removeCheckpointLink) removeLinksTo(chat, plan.sourceName);
        },
        afterMeta(md, bk) {
            record.backupId = bk.id;
            retconState(md).retcons.push(record);
        },
    });

    if (plan.options.deleteSource) {
        try {
            await deleteChat(plan.ref, plan.sourceName);
        } catch (e) {
            console.error(LOG, 'source delete failed', e);
            toastr.warning(`Merged, but the branch could not be deleted: ${e.message}`);
        }
    }
    return { record, backup };
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

/** Locates the merged messages of a retcon by their tags. */
export function locateRetcon(record) {
    const chat = ctx().chat;
    const idx = [];
    chat.forEach((m, i) => {
        if (m?.extra?.trm?.retconId === record.id) idx.push(i);
    });
    if (!idx.length) return { error: 'None of the merged messages are in the chat any more.' };
    const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
    const ordered = idx.every((v, i) => chat[v].extra.trm.pos === i);
    if (!contiguous || !ordered || idx.length !== record.mergedCount) {
        return { error: `The merged messages were moved, deleted or split (found ${idx.length} of ${record.mergedCount}, ${contiguous ? 'contiguous' : 'not contiguous'}).`, indices: idx };
    }
    const edited = rangeHash(chat.slice(idx[0], idx[0] + idx.length)) !== record.mergedHash;
    return { start: idx[0], count: idx.length, edited, indices: idx };
}

function undoOp(record, loc) {
    return makeOp({
        direction: 'undo',
        chatId: currentChatRef().chatId,
        start: loc.start,
        removed: loc.count,
        inserted: record.original.length,
        options: {},
    });
}

export async function previewUndo(record) {
    const loc = locateRetcon(record);
    if (loc.error) return { error: loc.error };
    const { report } = await prepareAll(undoOp(record, loc), record.adapterLogs ?? {});
    const busy = busyReason();
    if (busy) report.blockers.unshift({ source: 'SillyTavern', text: busy });
    if (loc.edited) report.warnings.unshift({ source: 'Undo', text: 'Merged messages were edited after the merge; those edits will be lost (they stay in the backup).' });
    return { report, loc };
}

export async function applyUndo(record) {
    const busy = busyReason();
    if (busy) throw new Error(busy);
    await ctx().saveChat();
    const loc = locateRetcon(record);
    if (loc.error) throw new Error(loc.error);

    const op = undoOp(record, loc);
    op.chatRef = currentChatRef();
    op.retconId = record.id;
    const { results, report } = await prepareAll(op, record.adapterLogs ?? {});
    if (report.blockers.length) throw new Error(report.blockers.map(b => b.text).join('\n'));

    return commit({
        label: `before undo of merge from "${record.sourceChat}"`,
        op,
        results,
        mutateChat(chat) {
            chat.splice(loc.start, loc.count, ...clone(record.original));
        },
        afterMeta(md) {
            const st = retconState(md);
            st.retcons = st.retcons.filter(r => r.id !== record.id);
        },
    });
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

export async function setPending(mesId, note) {
    const msg = ctx().chat[mesId];
    if (!msg) throw new Error(`No message #${mesId}`);
    forEachExtra(msg, extra => {
        if (note === null) delete extra.trm_pending;
        else extra.trm_pending = { note: String(note ?? ''), createdAt: new Date().toISOString() };
    });
    await ctx().saveChat();
}

export function listPending() {
    return ctx().chat
        .map((m, i) => (m?.extra?.trm_pending ? { mesId: i, ...m.extra.trm_pending, name: m.name, mes: m.mes } : null))
        .filter(Boolean);
}
