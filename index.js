// Timeline Retcon Merger — merge a range of messages from a branch/checkpoint
// into the open chat, keep the replaced messages as a viewable archive, and
// keep index-based extension data (Memory Books, WorldTracker) pointing at the
// right messages.

import { ctx, settings, saveSettings, LOG } from './src/st.js';
import { readRetcons, getRetcon } from './src/merge.js';
import { openMergeWizard } from './src/ui/wizard.js';
import { openViewer, openRetconList, openPendingList, openBackups, togglePending, undoFlow } from './src/ui/viewer.js';

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function addSettingsPanel() {
    const html = `
    <div class="trm-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Timeline Retcon Merger</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="trm-buttons">
                    <div class="menu_button trm-open-merge"><i class="fa-solid fa-code-merge"></i> Merge from branch…</div>
                    <div class="menu_button trm-open-list"><i class="fa-solid fa-code-branch"></i> Retcons in this chat</div>
                    <div class="menu_button trm-open-pending"><i class="fa-solid fa-hourglass-half"></i> Placeholders</div>
                    <div class="menu_button trm-open-backups"><i class="fa-solid fa-box-archive"></i> Backups</div>
                </div>
                <label class="trm-row">Backups to keep
                    <input type="number" class="text_pole trm-max-backups" min="1" max="500" style="width:6em">
                </label>
                <small class="trm-muted">Slash commands: /retcon-merge, /retcon-undo, /retcon-view, /retcon-pending, /retcon-list, /retcon-backups</small>
            </div>
        </div>
    </div>`;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    container.insertAdjacentHTML('beforeend', html);
    const root = container.querySelector('.trm-settings');
    root.querySelector('.trm-open-merge').addEventListener('click', () => openMergeWizard());
    root.querySelector('.trm-open-list').addEventListener('click', () => openRetconList());
    root.querySelector('.trm-open-pending').addEventListener('click', () => openPendingList());
    root.querySelector('.trm-open-backups').addEventListener('click', () => openBackups());
    const max = root.querySelector('.trm-max-backups');
    max.value = String(settings().maxBackups);
    max.addEventListener('change', () => {
        settings().maxBackups = Math.max(1, Number(max.value) || 30);
        saveSettings();
    });
}

// ---------------------------------------------------------------------------
// Per-message menu entries and indicators
// ---------------------------------------------------------------------------

const MENU_HTML = `
    <div title="Retcon: merge branch messages here" class="mes_button trm-mes-merge fa-solid fa-code-merge" data-i18n="[title]Retcon: merge branch messages here"></div>
    <div title="Retcon: mark / unmark as placeholder" class="mes_button trm-mes-pending fa-solid fa-hourglass-half" data-i18n="[title]Retcon: mark / unmark as placeholder"></div>`;

function addMessageButtons() {
    // The template is cloned for every message rendered from now on...
    const tpl = document.querySelector('#message_template .mes_buttons .extraMesButtons');
    if (tpl && !tpl.querySelector('.trm-mes-merge')) tpl.insertAdjacentHTML('afterbegin', MENU_HTML);
    // ...and messages already on screen get it too.
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach(x => {
        if (!x.querySelector('.trm-mes-merge')) x.insertAdjacentHTML('afterbegin', MENU_HTML);
    });

    $(document).on('click', '.trm-mes-merge', function () {
        const id = Number($(this).closest('.mes').attr('mesid'));
        openMergeWizard({ tStart: id, tEnd: id });
    });
    $(document).on('click', '.trm-mes-pending', function () {
        togglePending(Number($(this).closest('.mes').attr('mesid')));
    });
    $(document).on('click', '.trm-badge', function (e) {
        e.stopPropagation();
        const id = $(this).attr('data-retcon');
        if (id) openViewer(id);
        else openPendingList();
    });
}

function decorate() {
    const chat = ctx().chat;
    const known = new Set(readRetcons().map(r => r.id));
    document.querySelectorAll('#chat .mes[mesid]').forEach(node => {
        const i = Number(node.getAttribute('mesid'));
        const m = chat[i];
        const trm = m?.extra?.trm;
        const pending = m?.extra?.trm_pending;
        const merged = !!trm && known.has(trm.retconId);
        node.classList.toggle('trm-merged', merged);
        node.classList.toggle('trm-first', merged && chat[i - 1]?.extra?.trm?.retconId !== trm.retconId);
        node.classList.toggle('trm-last', merged && chat[i + 1]?.extra?.trm?.retconId !== trm.retconId);
        node.classList.toggle('trm-pending', !!pending);

        let badge = node.querySelector('.trm-badge');
        if (!merged && !pending) {
            badge?.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'trm-badge';
            (node.querySelector('.ch_name .name_text') ?? node.querySelector('.ch_name'))?.after(badge);
        }
        if (merged) {
            badge.dataset.retcon = trm.retconId;
            badge.title = 'Retconned (merged from a branch) — click to view the original or undo';
            badge.innerHTML = '<i class="fa-solid fa-code-merge"></i>';
        } else {
            delete badge.dataset.retcon;
            badge.title = `Placeholder${pending.note ? `: ${pending.note}` : ''} — click for the placeholder list`;
            badge.innerHTML = '<i class="fa-solid fa-hourglass-half"></i>';
        }
    });
}

let decorateTimer = null;
function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => {
        try {
            decorate();
        } catch (e) {
            console.warn(LOG, 'decorate failed', e);
        }
    }, 50);
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    const int = v => (v === undefined || v === '' ? undefined : Number(v));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-merge',
        helpString: 'Opens the retcon merge dialog, optionally pre-filled. Always shows a preview before changing anything. Example: <code>/retcon-merge source="Chat - Branch #2" target=15-15</code>',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'source', description: 'source chat name (branch/checkpoint)', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'srcend', description: 'last source message index to take', typeList: [ARGUMENT_TYPE.NUMBER] }),
            SlashCommandNamedArgument.fromProps({ name: 'target', description: 'range to replace, e.g. 15-15', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'insert', description: 'insert before this index instead of replacing', typeList: [ARGUMENT_TYPE.NUMBER] }),
        ],
        callback: async (args) => {
            const preset = { source: args.source ? String(args.source) : undefined, srcEnd: int(args.srcend) };
            if (args.insert !== undefined && args.insert !== '') {
                preset.mode = 'insert';
                preset.tStart = int(args.insert);
            } else if (args.target) {
                const [s, e] = String(args.target).split('-').map(Number);
                preset.mode = 'replace';
                preset.tStart = s;
                preset.tEnd = Number.isFinite(e) ? e : s;
            }
            await openMergeWizard(preset);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-undo',
        helpString: 'Undo a retcon merge (shows what will change first). Without an id: the most recent merge in this chat.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'retcon id', typeList: [ARGUMENT_TYPE.STRING] })],
        callback: async (_args, value) => {
            const list = readRetcons();
            const record = value ? getRetcon(String(value)) : list[list.length - 1];
            if (!record) toastr.warning('No retcon to undo in this chat.');
            else await undoFlow(record);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-view',
        helpString: 'View the original vs current version of a retconned message range. Argument: message index (default: last retconned).',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message index', typeList: [ARGUMENT_TYPE.NUMBER] })],
        callback: async (_args, value) => {
            const chat = ctx().chat;
            let id = null;
            if (value !== undefined && value !== '') id = chat[Number(value)]?.extra?.trm?.retconId ?? null;
            else id = readRetcons().at(-1)?.id ?? null;
            if (!id) toastr.warning('No retconned message there.');
            else await openViewer(id);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-pending',
        helpString: '<code>/retcon-pending</code> lists placeholders; <code>/retcon-pending 15</code> marks/unmarks message 15 as a placeholder.',
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message index', typeList: [ARGUMENT_TYPE.NUMBER] })],
        callback: async (_args, value) => {
            if (value !== undefined && value !== '') await togglePending(Number(value));
            else await openPendingList();
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-list',
        helpString: 'List retcons in this chat.',
        callback: async () => { await openRetconList(); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'retcon-backups',
        helpString: 'Manage retcon backups (restore as new chat / delete).',
        callback: async () => { await openBackups(); return ''; },
    }));
}

// ---------------------------------------------------------------------------

(function init() {
    try {
        settings();
        addSettingsPanel();
        addMessageButtons();
        registerCommands();

        const { eventSource, eventTypes } = ctx();
        for (const ev of ['CHAT_CHANGED', 'MORE_MESSAGES_LOADED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED',
            'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_EDITED']) {
            if (eventTypes[ev]) eventSource.on(eventTypes[ev], scheduleDecorate);
        }
        const chatEl = document.getElementById('chat');
        if (chatEl) new MutationObserver(scheduleDecorate).observe(chatEl, { childList: true });
        scheduleDecorate();
        console.info(LOG, 'loaded');
    } catch (e) {
        console.error(LOG, 'init failed', e);
    }
})();
