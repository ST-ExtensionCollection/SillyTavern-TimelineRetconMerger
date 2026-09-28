import { ctx, escapeHtml } from '../st.js';

export function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return /** @type {HTMLElement} */ (t.content.firstElementChild);
}

function formatText(m) {
    try {
        return ctx().messageFormatting(m.mes ?? '', m.name ?? '', !!m.is_system, !!m.is_user, -1);
    } catch {
        return escapeHtml(m.mes ?? '').replace(/\n/g, '<br>');
    }
}

/** Read-only rendering of messages; `firstIndex` labels them with chat positions. */
export function renderMessages(messages, firstIndex = null) {
    if (!messages.length) return '<div class="trm-empty">(no messages)</div>';
    return messages.map((m, i) => {
        const idx = firstIndex === null ? '' : `<span class="trm-msg-idx">#${firstIndex + i}</span>`;
        const flags = [
            m.is_user ? 'user' : '',
            m.is_system ? 'hidden/system' : '',
            (m.swipes?.length ?? 0) > 1 ? `${m.swipes.length} swipes` : '',
        ].filter(Boolean).join(', ');
        return `<div class="trm-msg${m.is_user ? ' trm-msg-user' : ''}">
            <div class="trm-msg-head">${idx}<b>${escapeHtml(m.name ?? '')}</b>${flags ? ` <small>(${escapeHtml(flags)})</small>` : ''}</div>
            <div class="trm-msg-text">${formatText(m)}</div>
        </div>`;
    }).join('');
}

/** Blockers / conflicts / warnings / info as HTML. */
export function renderReport(report) {
    const section = (key, title, cls) => {
        const items = report[key] ?? [];
        if (!items.length) return '';
        return `<div class="trm-report-section ${cls}"><h4>${title} (${items.length})</h4><ul>${items
            .map(x => `<li><span class="trm-src">${escapeHtml(x.source)}</span> ${escapeHtml(x.text)}</li>`).join('')}</ul></div>`;
    };
    const html = section('blockers', 'Cannot proceed', 'trm-blockers')
        + section('conflicts', 'Needs your attention (left unchanged)', 'trm-conflicts')
        + section('warnings', 'Warnings', 'trm-warnings')
        + section('info', 'Will change', 'trm-info');
    return html || '<div class="trm-empty">No other stored data is affected.</div>';
}

export async function confirmPopup(content, { okButton = 'OK', cancelButton = 'Cancel', wide = true, onClosing } = {}) {
    const c = ctx();
    const popup = new c.Popup(content, c.POPUP_TYPE.CONFIRM, '', { okButton, cancelButton, wide, allowVerticalScrolling: true, onClosing });
    const result = await popup.show();
    return result === c.POPUP_RESULT.AFFIRMATIVE;
}

export async function infoPopup(content, { wide = true, large = false } = {}) {
    const c = ctx();
    const popup = new c.Popup(content, c.POPUP_TYPE.TEXT, '', { okButton: 'Close', wide, large, allowVerticalScrolling: true });
    await popup.show();
}
