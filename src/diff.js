// Prefix comparison and fingerprints.

function mesOverlap(a, b) {
    if (a.mes === b.mes) return true;
    if (Array.isArray(b.swipes) && b.swipes.includes(a.mes)) return true;
    if (Array.isArray(a.swipes) && a.swipes.includes(b.mes)) return true;
    return false;
}

/**
 * Same message in two chats that share history. Speaker must match; then either
 * the timestamp matches (message edited later in one chat) or the text/swipes
 * overlap (branch created from a different swipe gets a new timestamp).
 */
export function sameMessage(a, b) {
    if (!a || !b) return false;
    if (!!a.is_user !== !!b.is_user) return false;
    if (String(a.name ?? '') !== String(b.name ?? '')) return false;
    const sameDate = a.send_date !== undefined && a.send_date === b.send_date;
    return sameDate || mesOverlap(a, b);
}

/** Index of the first message that differs (= length of the shared prefix). */
export function divergenceIndex(target, source) {
    const n = Math.min(target.length, source.length);
    let i = 0;
    while (i < n && sameMessage(target[i], source[i])) i++;
    return i;
}

// cyrb53 — small, stable, non-cryptographic string hash.
function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Fingerprint of a message range: speaker + visible text of each message. */
export function rangeHash(messages) {
    return cyrb53(JSON.stringify(messages.map(m => [m?.name ?? '', !!m?.is_user, m?.mes ?? ''])));
}
