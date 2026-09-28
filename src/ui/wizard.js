// Merge dialog: pick source + ranges, then preview with impact report, then apply.

import { ctx, currentChatRef, busyReason, escapeHtml, LOG } from '../st.js';
import { listOtherChats, loadChatFile } from '../chatio.js';
import { divergenceIndex } from '../diff.js';
import { buildMergePlan, previewMerge, applyMerge, listPending } from '../merge.js';
import memorybooks from '../adapters/memorybooks.js';
import { el, renderMessages, renderReport, confirmPopup } from './common.js';

function snippet(m, len = 90) {
    const t = String(m?.mes ?? '').replace(/\s+/g, ' ').trim();
    return `${m?.name ?? '?'}: ${t.length > len ? t.slice(0, len) + '…' : t}`;
}

/**
 * @param {object} [preset]
 * @param {string} [preset.source]
 * @param {number} [preset.srcEnd]
 * @param {'replace'|'insert'} [preset.mode]
 * @param {number} [preset.tStart]
 * @param {number} [preset.tEnd]
 */
export async function openMergeWizard(preset = {}) {
    const ref = currentChatRef();
    if (!ref) return toastr.warning('Open a chat first.');
    const busy = busyReason();
    if (busy) return toastr.warning(busy);

    let chats;
    try {
        chats = await listOtherChats(ref);
    } catch (e) {
        console.error(LOG, e);
        return toastr.error(`Could not list chats: ${e.message}`);
    }
    if (!chats.length) return toastr.info('No other chats found for this character/group.');

    chats.sort((a, b) => Number(b.mainChat === ref.chatId) - Number(a.mainChat === ref.chatId));
    const chat = ctx().chat;

    const root = el(`<div class="trm-wizard">
        <h3>Merge messages from a branch</h3>
        <label class="trm-row">Source chat
            <select class="text_pole trm-source">
                <option value="">— choose —</option>
                ${chats.map(c => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.mainChat === ref.chatId ? ' ⟵ branch of this chat' : ''}${c.count != null ? ` (${c.count} msgs)` : ''}</option>`).join('')}
            </select>
        </label>
        <div class="trm-src-info trm-muted">Choose a source chat.</div>
        <div class="trm-ranges" hidden>
            <label class="trm-row">Take source messages from <b class="trm-d"></b> through
                <select class="text_pole trm-srcend"></select>
            </label>
            <div class="trm-row">
                <label><input type="radio" name="trm-mode" value="replace"> Replace messages in this chat</label>
                <label><input type="radio" name="trm-mode" value="insert"> Insert without replacing</label>
            </div>
            <div class="trm-row trm-replace-fields">
                Replace this chat's messages
                <input type="number" class="text_pole trm-tstart" min="0"> to
                <input type="number" class="text_pole trm-tend" min="0">
            </div>
            <div class="trm-row trm-insert-fields">
                Insert before this chat's message
                <input type="number" class="text_pole trm-tins" min="0"> <small class="trm-muted">(= chat length to append)</small>
            </div>
            <div class="trm-target-preview trm-muted"></div>
        </div>
    </div>`);

    const $ = sel => root.querySelector(sel);
    let loaded = null; // { name, source, d }

    const updateTargetPreview = () => {
        if (!loaded) return;
        const mode = root.querySelector('input[name="trm-mode"]:checked')?.value;
        const box = $('.trm-target-preview');
        if (mode === 'replace') {
            const s = Number($('.trm-tstart').value), e = Number($('.trm-tend').value);
            const msgs = chat.slice(s, e + 1);
            box.innerHTML = msgs.length
                ? `Will be replaced (${msgs.length}):<br>${msgs.slice(0, 5).map(m => escapeHtml(snippet(m))).join('<br>')}${msgs.length > 5 ? '<br>…' : ''}`
                : 'No messages in that range.';
        } else {
            const p = Number($('.trm-tins').value);
            box.innerHTML = `Inserted after: ${chat[p - 1] ? escapeHtml(snippet(chat[p - 1])) : '(start)'}<br>Inserted before: ${chat[p] ? escapeHtml(snippet(chat[p])) : '(end of chat)'}`;
        }
    };

    const setMode = mode => {
        root.querySelectorAll('input[name="trm-mode"]').forEach(r => { r.checked = r.value === mode; });
        $('.trm-replace-fields').hidden = mode !== 'replace';
        $('.trm-insert-fields').hidden = mode !== 'insert';
        updateTargetPreview();
    };

    const loadSource = async name => {
        loaded = null;
        $('.trm-ranges').hidden = true;
        if (!name) return;
        $('.trm-src-info').textContent = 'Loading…';
        try {
            const source = await loadChatFile(ref, name);
            const d = divergenceIndex(chat, source.messages);
            loaded = { name, source, d };
            const src = source.messages;
            if (d === 0) {
                $('.trm-src-info').textContent = 'This chat shares no history with the open chat. It cannot be merged.';
                return;
            }
            if (d >= src.length) {
                $('.trm-src-info').textContent = `All ${src.length} messages of this chat are already in the open chat. Nothing to merge.`;
                return;
            }
            $('.trm-src-info').innerHTML = `Shares messages 0-${d - 1} with this chat. Branch has ${src.length - d} new message(s) after that.<br>`
                + `Last shared: ${escapeHtml(snippet(chat[d - 1]))}`;
            $('.trm-d').textContent = `#${d}`;
            $('.trm-srcend').innerHTML = src.slice(d).map((m, i) => `<option value="${d + i}">#${d + i} ${escapeHtml(snippet(m, 60))}</option>`).join('');
            $('.trm-srcend').value = String(Number.isInteger(preset.srcEnd) ? preset.srcEnd : src.length - 1);

            // Default target: a placeholder mark at/after the split, else the split point itself.
            const pending = listPending().find(p => p.mesId >= d);
            const tStart = Number.isInteger(preset.tStart) ? preset.tStart : (pending?.mesId ?? d);
            const tEnd = Number.isInteger(preset.tEnd) ? preset.tEnd : tStart;
            $('.trm-tstart').value = String(tStart);
            $('.trm-tend').value = String(tEnd);
            $('.trm-tins').value = String(Number.isInteger(preset.tStart) ? preset.tStart : Math.min(d, chat.length));
            $('.trm-ranges').hidden = false;
            setMode(preset.mode ?? (tStart < chat.length ? 'replace' : 'insert'));
        } catch (e) {
            console.error(LOG, e);
            $('.trm-src-info').textContent = `Could not load: ${e.message}`;
        }
    };

    $('.trm-source').addEventListener('change', e => loadSource(e.target.value));
    root.querySelectorAll('input[name="trm-mode"]').forEach(r => r.addEventListener('change', () => setMode(r.value)));
    root.querySelectorAll('.trm-tstart, .trm-tend, .trm-tins').forEach(i => i.addEventListener('input', updateTargetPreview));

    if (preset.source && chats.some(c => c.name === preset.source)) {
        $('.trm-source').value = preset.source;
        await loadSource(preset.source);
    }

    const ok = await confirmPopup(root, { okButton: 'Preview…', cancelButton: 'Cancel' });
    if (!ok) return;
    if (!loaded) return toastr.warning('No source chat selected.');

    const mode = root.querySelector('input[name="trm-mode"]:checked')?.value ?? 'replace';
    const choice = {
        source: loaded.name,
        srcEnd: Number($('.trm-srcend').value),
        mode,
        tStart: Number(mode === 'replace' ? $('.trm-tstart').value : $('.trm-tins').value),
        tEnd: Number($('.trm-tend').value),
    };
    const { plan, error } = buildMergePlan({
        sourceName: loaded.name, source: loaded.source, mode, srcEnd: choice.srcEnd, tStart: choice.tStart, tEnd: choice.tEnd, options: {},
    });
    if (error) {
        toastr.error(error, 'Retcon merge refused', { timeOut: 10000 });
        return openMergeWizard(choice);
    }
    return openPreview(plan, choice);
}

async function openPreview(plan, choice) {
    const hasStmb = memorybooks.detect();
    const delta = plan.inserted - plan.removed;
    const what = plan.mode === 'replace'
        ? `Replace messages <b>#${plan.tStart}-#${plan.tStart + plan.removed - 1}</b> (${plan.removed})`
        : `Insert before message <b>#${plan.tStart}</b>`;

    const root = el(`<div class="trm-preview">
        <h3>Preview merge</h3>
        <p>${what} with <b>${plan.inserted}</b> message(s) from <b>${escapeHtml(plan.sourceName)}</b> (#${plan.srcStart}-#${plan.srcEnd}).
        ${delta ? `Every later message moves by <b>${delta > 0 ? '+' : ''}${delta}</b>.` : 'Message count is unchanged.'}</p>
        <div class="trm-options">
            ${hasStmb ? `<label><input type="checkbox" class="trm-opt-adopt" checked> Adopt Memory Books memories written in the branch for these messages</label>
            <div class="trm-row">If Memory Books' "highest processed message" is inside the replaced messages:
                <label><input type="radio" name="trm-highest" value="unprocessed" checked> treat new messages as unprocessed</label>
                <label><input type="radio" name="trm-highest" value="processed"> treat as processed</label>
            </div>` : ''}
            <label><input type="checkbox" class="trm-opt-link" checked> Remove the checkpoint link to the branch</label>
            <label><input type="checkbox" class="trm-opt-delete"> Delete the branch chat after merging</label>
        </div>
        <div class="trm-report"><div class="trm-muted">Checking stored data…</div></div>
        <div class="trm-columns">
            <div><h4>${plan.mode === 'replace' ? `Current (removed, archived)` : 'Nothing removed'}</h4>${renderMessages(plan.replaced, plan.tStart)}</div>
            <div><h4>From branch (inserted)</h4>${renderMessages(plan.messages, plan.tStart)}</div>
        </div>
    </div>`);

    const q = sel => root.querySelector(sel);
    let report = null;
    let generation = 0;
    const readOptions = () => {
        plan.options.adoptBranchMemories = !!q('.trm-opt-adopt')?.checked;
        plan.options.stmbHighest = root.querySelector('input[name="trm-highest"]:checked')?.value ?? 'unprocessed';
        plan.options.removeCheckpointLink = !!q('.trm-opt-link').checked;
        plan.options.deleteSource = !!q('.trm-opt-delete').checked;
    };
    const refresh = async () => {
        readOptions();
        const mine = ++generation;
        report = null;
        q('.trm-report').innerHTML = '<div class="trm-muted">Checking stored data…</div>';
        let next;
        try {
            next = await previewMerge(plan);
        } catch (e) {
            console.error(LOG, e);
            next = { blockers: [{ source: 'Preview', text: e.message }] };
        }
        if (mine !== generation) return;
        report = next;
        q('.trm-report').innerHTML = renderReport(report);
    };
    root.querySelectorAll('input').forEach(i => i.addEventListener('change', refresh));
    refresh();

    const ok = await confirmPopup(root, {
        okButton: 'Merge',
        cancelButton: 'Back',
        onClosing: popup => {
            if (popup.result !== ctx().POPUP_RESULT.AFFIRMATIVE) return true;
            if (!report) { toastr.info('Still checking…'); return false; }
            if (report.blockers?.length) { toastr.error('Resolve the blockers first.'); return false; }
            return true;
        },
    });
    if (!ok) return openMergeWizard(choice);
    readOptions();

    if (plan.options.deleteSource) {
        const copies = (plan.sourceMetadata?.STMemoryBooks?.branchLorebookCopies?.mappings ?? []).map(m => m.copyName).filter(Boolean);
        const sure = await confirmPopup(el(`<div>
            <h3>Delete "${escapeHtml(plan.sourceName)}" after merging?</h3>
            <ul>
                <li>Memory Books memories and side-prompt snapshots made in the branch that were not adopted will point at a deleted chat and can no longer be regenerated.</li>
                ${copies.length ? `<li>Memory Books' branch lorebook copies stay behind: ${copies.map(escapeHtml).join(', ')}.</li>` : ''}
                <li>The backup made before the merge does <b>not</b> include the branch.</li>
            </ul></div>`), { okButton: 'Merge and delete', cancelButton: 'Merge, keep branch' });
        plan.options.deleteSource = sure;
    }

    try {
        const { record, backup } = await applyMerge(plan);
        toastr.success(`Merged ${record.mergedCount} message(s). Backup: ${backup.id}. Click the ⎇ badge on a merged message to view the original or undo.`, 'Retcon merged', { timeOut: 8000 });
    } catch (e) {
        console.error(LOG, e);
        toastr.error(e.message, 'Retcon merge failed', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
    }
}
