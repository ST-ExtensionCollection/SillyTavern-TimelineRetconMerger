// Read-only viewer for archived originals, plus undo, lists of retcons,
// placeholders and backups. Viewing never touches the chat.

import { ctx, settings, escapeHtml, currentChatRef, LOG } from '../st.js';
import { readRetcons, getRetcon, locateRetcon, previewUndo, applyUndo, listPending, setPending } from '../merge.js';
import { restoreBackup, deleteBackup } from '../chatio.js';
import { el, renderMessages, renderReport, confirmPopup, infoPopup } from './common.js';
import { openMergeWizard } from './wizard.js';

function fmtDate(iso) {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}

export async function openViewer(retconId) {
    const record = getRetcon(retconId);
    if (!record) return toastr.warning('This merge has no archive in this chat (it may have been undone, or the chat was copied without it).');
    const loc = locateRetcon(record);
    const chat = ctx().chat;
    const current = loc.error
        ? (loc.indices ?? []).map(i => chat[i])
        : chat.slice(loc.start, loc.start + loc.count);
    const currentStart = loc.error ? null : loc.start;

    const root = el(`<div class="trm-viewer">
        <h3>Retcon from ${escapeHtml(record.sourceChat)}</h3>
        <div class="trm-muted">${fmtDate(record.createdAt)} · ${record.mode === 'insert' ? 'inserted' : `replaced ${record.removedCount}`} → ${record.mergedCount} message(s)${record.backupId ? ` · backup ${escapeHtml(record.backupId)}` : ''}</div>
        ${loc.error ? `<div class="trm-conflicts">${escapeHtml(loc.error)} Undo is unavailable; the original is still viewable.</div>` : ''}
        <div class="trm-tabs">
            <button class="menu_button trm-tab" data-view="side">Side by side</button>
            <button class="menu_button trm-tab" data-view="original">Original</button>
            <button class="menu_button trm-tab" data-view="current">Current</button>
            ${loc.error ? '' : '<button class="menu_button trm-undo"><i class="fa-solid fa-rotate-left"></i> Undo this merge…</button>'}
        </div>
        <div class="trm-columns" data-view="side">
            <div class="trm-col-original"><h4>Original (archived, read-only)</h4>${record.original.length ? renderMessages(record.original, record.startAtMerge) : '<div class="trm-empty">(inserted without replacing anything)</div>'}</div>
            <div class="trm-col-current"><h4>Current (in chat)</h4>${renderMessages(current, currentStart)}</div>
        </div>
    </div>`);

    const cols = root.querySelector('.trm-columns');
    root.querySelectorAll('.trm-tab').forEach(b => b.addEventListener('click', () => { cols.dataset.view = b.dataset.view; }));

    let wantUndo = false;
    const popup = new (ctx().Popup)(root, ctx().POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, large: true, allowVerticalScrolling: true });
    root.querySelector('.trm-undo')?.addEventListener('click', () => {
        wantUndo = true;
        popup.complete(ctx().POPUP_RESULT.CANCELLED);
    });
    await popup.show();
    if (wantUndo) await undoFlow(record);
}

export async function undoFlow(record) {
    let pre;
    try {
        pre = await previewUndo(record);
    } catch (e) {
        console.error(LOG, e);
        return toastr.error(e.message, 'Undo check failed');
    }
    if (pre.error) return toastr.error(pre.error, 'Cannot undo');
    const blocked = pre.report.blockers.length > 0;
    const ok = await confirmPopup(el(`<div class="trm-preview">
        <h3>Undo merge from ${escapeHtml(record.sourceChat)}?</h3>
        <p>Messages #${pre.loc.start}-#${pre.loc.start + pre.loc.count - 1} are replaced by the ${record.original.length} archived original message(s). A backup is made first.</p>
        <div class="trm-report">${renderReport(pre.report)}</div>
    </div>`), { okButton: blocked ? 'Close' : 'Undo', cancelButton: 'Cancel' });
    if (!ok || blocked) return;
    try {
        await applyUndo(record);
        toastr.success('Merge undone.');
    } catch (e) {
        console.error(LOG, e);
        toastr.error(e.message, 'Undo failed', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
    }
}

export async function openRetconList() {
    if (!currentChatRef()) return toastr.warning('Open a chat first.');
    const list = [...readRetcons()].reverse();
    const root = el(`<div class="trm-list">
        <h3>Retcons in this chat</h3>
        ${list.length ? '' : '<div class="trm-empty">None yet.</div>'}
        ${list.map(r => {
        const loc = locateRetcon(r);
        const where = loc.error ? `<span class="trm-bad">${escapeHtml(loc.error)}</span>` : `messages #${loc.start}-#${loc.start + loc.count - 1}`;
        return `<div class="trm-list-item" data-id="${escapeHtml(r.id)}">
                <div><b>${escapeHtml(r.sourceChat)}</b> · ${fmtDate(r.createdAt)}<br><small>${where}${loc.edited ? ' · edited since merge' : ''}</small></div>
                <button class="menu_button trm-view">View</button>
            </div>`;
    }).join('')}
    </div>`);
    let chosen = null;
    const popup = new (ctx().Popup)(root, ctx().POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, allowVerticalScrolling: true });
    root.querySelectorAll('.trm-view').forEach(b => b.addEventListener('click', () => {
        chosen = b.closest('.trm-list-item').dataset.id;
        popup.complete(ctx().POPUP_RESULT.CANCELLED);
    }));
    await popup.show();
    if (chosen) await openViewer(chosen);
}

export async function openPendingList() {
    if (!currentChatRef()) return toastr.warning('Open a chat first.');
    const list = listPending();
    const root = el(`<div class="trm-list">
        <h3>Placeholders waiting for a full scene</h3>
        ${list.length ? '' : '<div class="trm-empty">None. Use the ⋯ menu on a message → "Mark as placeholder".</div>'}
        ${list.map(p => `<div class="trm-list-item" data-id="${p.mesId}">
            <div><b>#${p.mesId} ${escapeHtml(p.name)}</b>${p.note ? ` — ${escapeHtml(p.note)}` : ''}<br><small>${escapeHtml(String(p.mes ?? '').slice(0, 140))}</small></div>
            <button class="menu_button trm-merge-here">Merge here…</button>
            <button class="menu_button trm-unmark">Unmark</button>
        </div>`).join('')}
    </div>`);
    let action = null;
    const popup = new (ctx().Popup)(root, ctx().POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, allowVerticalScrolling: true });
    root.querySelectorAll('.trm-merge-here, .trm-unmark').forEach(b => b.addEventListener('click', () => {
        action = { kind: b.classList.contains('trm-unmark') ? 'unmark' : 'merge', mesId: Number(b.closest('.trm-list-item').dataset.id) };
        popup.complete(ctx().POPUP_RESULT.CANCELLED);
    }));
    await popup.show();
    if (action?.kind === 'merge') await openMergeWizard({ tStart: action.mesId, tEnd: action.mesId, mode: 'replace' });
    if (action?.kind === 'unmark') {
        await setPending(action.mesId, null);
        await openPendingList();
    }
}

export async function togglePending(mesId) {
    const msg = ctx().chat[mesId];
    if (!msg) return;
    if (msg.extra?.trm_pending) {
        await setPending(mesId, null);
        toastr.info(`Message #${mesId} is no longer a placeholder.`);
        return;
    }
    const c = ctx();
    const note = await c.Popup.show.input('Mark as placeholder', 'Optional note (e.g. what the full scene should cover):', '');
    if (note === null || note === false) return;
    await setPending(mesId, note);
    toastr.info(`Message #${mesId} marked as placeholder.`);
}

export async function openBackups() {
    const s = settings();
    const ref = currentChatRef();
    const list = [...s.backups].reverse();
    const root = el(`<div class="trm-list">
        <h3>Retcon backups</h3>
        <p class="trm-muted">Stored in your user files folder. Restoring creates a <b>new</b> chat; the live chat is never overwritten.</p>
        <label><input type="checkbox" class="trm-restore-books"> Also restore lorebooks saved with the backup (overwrites those lorebooks)</label>
        ${list.length ? '' : '<div class="trm-empty">No backups.</div>'}
        ${list.map(b => `<div class="trm-list-item${ref && b.chatId === ref.chatId ? ' trm-current' : ''}" data-id="${escapeHtml(b.id)}">
            <div><b>${escapeHtml(b.chatId)}</b> · ${fmtDate(b.createdAt)}<br><small>${escapeHtml(b.label)} · ${b.messageCount} msgs${b.lorebooks?.length ? ` · ${b.lorebooks.length} lorebook(s)` : ''}</small></div>
            <button class="menu_button trm-restore">Restore as new chat</button>
            <button class="menu_button trm-delete">Delete</button>
        </div>`).join('')}
    </div>`);
    let action = null;
    const popup = new (ctx().Popup)(root, ctx().POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, allowVerticalScrolling: true });
    root.querySelectorAll('.trm-restore, .trm-delete').forEach(b => b.addEventListener('click', () => {
        action = {
            kind: b.classList.contains('trm-delete') ? 'delete' : 'restore',
            id: b.closest('.trm-list-item').dataset.id,
            books: root.querySelector('.trm-restore-books').checked,
        };
        popup.complete(ctx().POPUP_RESULT.CANCELLED);
    }));
    await popup.show();
    if (!action) return;
    const record = s.backups.find(b => b.id === action.id);
    if (!record) return;
    try {
        if (action.kind === 'delete') {
            if (await confirmPopup(`Delete backup ${escapeHtml(record.id)}? This cannot be undone.`, { okButton: 'Delete' })) {
                await deleteBackup(record.id);
            }
        } else {
            const name = await restoreBackup(record, { lorebooks: action.books });
            await infoPopup(`Restored as chat <b>${escapeHtml(name)}</b>. Open it from the chat list${record.isGroup ? ' of the group' : ''}.`, { wide: false });
        }
    } catch (e) {
        console.error(LOG, e);
        toastr.error(e.message, 'Backup action failed');
    }
    return openBackups();
}
