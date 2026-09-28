// Thin layer over SillyTavern. Everything that is NOT on SillyTavern.getContext()
// is imported here, so an ST update that moves an internal only breaks this file.

import { isGenerating, deleteCharacterChatByName } from '/script.js';
import { deleteGroupChatByName, editGroup } from '/scripts/group-chats.js';

export const MODULE = 'timelineRetcon';
export const LOG = '[TimelineRetcon]';

/** Always re-read: chat_metadata is replaced by ST on every chat switch. */
export function ctx() {
    return SillyTavern.getContext();
}

export function meta() {
    return ctx().chatMetadata;
}

export function isGroupChat() {
    return !!ctx().groupId;
}

export function currentGroup() {
    const c = ctx();
    return c.groupId ? c.groups.find(g => g.id === c.groupId) : null;
}

export function currentCharacter() {
    const c = ctx();
    return c.groupId || c.characterId === undefined ? null : c.characters[c.characterId];
}

/** Identity of the open chat, or null if none. */
export function currentChatRef() {
    const c = ctx();
    const chatId = c.getCurrentChatId();
    if (!chatId) return null;
    if (c.groupId) return { isGroup: true, groupId: c.groupId, chatId: String(chatId) };
    const ch = currentCharacter();
    if (!ch) return null;
    return { isGroup: false, avatar: ch.avatar, characterId: c.characterId, chatId: String(chatId) };
}

export function busyReason() {
    if (isGenerating()) return 'A generation is in progress.';
    if (document.querySelector('#curEditTextarea')) return 'A message is being edited. Finish or cancel the edit first.';
    return null;
}

export async function deleteChat(ref, chatName) {
    if (ref.isGroup) {
        await deleteGroupChatByName(ref.groupId, chatName);
    } else {
        await deleteCharacterChatByName(ref.characterId, chatName);
    }
}

export async function addChatToGroup(groupId, chatName) {
    const group = ctx().groups.find(g => g.id === groupId);
    if (!group) throw new Error('Group not found');
    if (!group.chats.includes(chatName)) group.chats.push(chatName);
    await editGroup(groupId, true, false);
}

export function settings() {
    const es = ctx().extensionSettings;
    es[MODULE] ??= {};
    const s = es[MODULE];
    s.backups ??= [];
    s.maxBackups ??= 30;
    return s;
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}

export async function post(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${url} failed: ${res.status} ${text}`.trim());
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('application/json') ? res.json() : res.text();
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

export function clone(v) {
    return v === undefined ? undefined : structuredClone(v);
}
