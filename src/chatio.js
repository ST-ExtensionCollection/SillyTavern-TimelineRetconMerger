// Reading other chat files, and backups (stored in user/files, not the chat list).

import { ctx, post, settings, saveSettings, addChatToGroup, LOG } from './st.js';

function stripExt(name) {
    return String(name).replace(/\.jsonl$/i, '');
}

/**
 * Lists chats of the current character/group except the open one.
 * @returns {Promise<{name: string, mainChat: string|null, count: number|null, lastMes: number|null}[]>}
 */
export async function listOtherChats(ref) {
    if (ref.isGroup) {
        const group = ctx().groups.find(g => g.id === ref.groupId);
        return (group?.chats ?? [])
            .filter(id => String(id) !== ref.chatId)
            .map(id => ({ name: String(id), mainChat: null, count: null, lastMes: null }))
            .reverse();
    }
    const data = await post('/api/characters/chats', { avatar_url: ref.avatar, metadata: true });
    if (!Array.isArray(data)) return [];
    return data
        .map(x => ({
            name: stripExt(x.file_name),
            mainChat: x.chat_metadata?.main_chat ?? null,
            count: Number.isFinite(Number(x.chat_items)) ? Number(x.chat_items) : null,
            lastMes: Number(x.last_mes) || null,
        }))
        .filter(x => x.name !== ref.chatId)
        .sort((a, b) => (b.lastMes ?? 0) - (a.lastMes ?? 0));
}

/**
 * Loads a chat file of the current character/group without opening it.
 * @returns {Promise<{metadata: object, messages: object[]}>}
 */
export async function loadChatFile(ref, name) {
    const data = ref.isGroup
        ? await post('/api/chats/group/get', { id: name })
        : await post('/api/chats/get', { avatar_url: ref.avatar, file_name: stripExt(name) });
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`Chat "${name}" could not be read (missing or empty).`);
    }
    const hasHeader = data[0] && typeof data[0] === 'object' && Object.hasOwn(data[0], 'chat_metadata');
    return {
        metadata: hasHeader ? (data[0].chat_metadata ?? {}) : {},
        messages: hasHeader ? data.slice(1) : data,
    };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function slug(s) {
    return String(s).replace(/[^a-zA-Z0-9_\-.]/g, '_').replace(/_+/g, '_').slice(0, 60);
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function upload(name, text) {
    const res = await post('/api/files/upload', { name, data: toBase64(text) });
    if (!res?.path) throw new Error(`Upload of ${name} returned no path`);
    return res.path;
}

/**
 * Writes the open chat (header + messages) and the given lorebooks to user/files.
 * Throws on any failure; callers must abort the operation in that case.
 * @param {object} ref chat ref
 * @param {string} label what the backup precedes
 * @param {{name: string, data: object}[]} lorebooks lorebooks about to be written (pre-change state)
 */
export async function createBackup(ref, label, lorebooks = []) {
    const c = ctx();
    const id = `${slug(ref.chatId)}_${stamp()}_${Math.random().toString(36).slice(2, 6)}`;
    const header = { chat_metadata: c.chatMetadata, user_name: 'unused', character_name: 'unused' };
    const jsonl = [header, ...c.chat].map(x => JSON.stringify(x)).join('\n');
    const chatPath = await upload(`trm_${id}_chat.jsonl`, jsonl);

    const books = [];
    for (let i = 0; i < lorebooks.length; i++) {
        const path = await upload(`trm_${id}_lb${i}.json`, JSON.stringify(lorebooks[i].data));
        books.push({ name: lorebooks[i].name, path });
    }

    const record = {
        id,
        createdAt: new Date().toISOString(),
        label,
        chatId: ref.chatId,
        isGroup: ref.isGroup,
        avatar: ref.avatar ?? null,
        groupId: ref.groupId ?? null,
        messageCount: c.chat.length,
        chatPath,
        lorebooks: books,
    };
    const s = settings();
    s.backups.push(record);
    await pruneBackups();
    saveSettings();
    console.info(LOG, 'backup created', record);
    return record;
}

async function deleteFile(path) {
    try {
        await post('/api/files/delete', { path });
    } catch (e) {
        console.warn(LOG, 'could not delete backup file', path, e);
    }
}

async function pruneBackups() {
    const s = settings();
    const max = Math.max(1, Number(s.maxBackups) || 30);
    while (s.backups.length > max) {
        const old = s.backups.shift();
        await deleteFile(old.chatPath);
        for (const b of old.lorebooks ?? []) await deleteFile(b.path);
    }
}

export async function deleteBackup(id) {
    const s = settings();
    const idx = s.backups.findIndex(b => b.id === id);
    if (idx < 0) return;
    const [old] = s.backups.splice(idx, 1);
    await deleteFile(old.chatPath);
    for (const b of old.lorebooks ?? []) await deleteFile(b.path);
    saveSettings();
}

async function fetchText(path) {
    const res = await fetch('/' + String(path).replace(/^\/+/, ''), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
    return res.text();
}

/**
 * Restores a backup as a NEW chat file (never overwrites the live chat).
 * Lorebooks are only restored when asked, and do overwrite the live lorebook.
 * @returns {Promise<string>} name of the new chat
 */
export async function restoreBackup(record, { lorebooks = false } = {}) {
    const c = ctx();
    const lines = (await fetchText(record.chatPath)).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const header = lines[0];
    header.chat_metadata = { ...(header.chat_metadata ?? {}), integrity: c.uuidv4() };
    const name = `${record.chatId} - restored ${stamp()}`;

    if (record.isGroup) {
        const id = name.replace(/[^a-zA-Z0-9_\- .]/g, '_');
        await post('/api/chats/group/save', { id, chat: lines });
        await addChatToGroup(record.groupId, id);
    } else {
        await post('/api/chats/save', { avatar_url: record.avatar, file_name: name, chat: lines });
    }

    if (lorebooks) {
        for (const b of record.lorebooks ?? []) {
            const data = JSON.parse(await fetchText(b.path));
            await c.saveWorldInfo(b.name, data, true);
        }
    }
    return name;
}
