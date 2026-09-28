// Index arithmetic shared by all adapters.
//
// An operation replaces `removed` messages starting at `start` with `inserted`
// messages (removed = 0 is a pure insertion). Undo is the same shape with
// removed/inserted swapped, so adapters use one code path for both.

/**
 * @typedef {object} RetconOp
 * @property {'merge'|'undo'} direction
 * @property {string} chatId       current chat
 * @property {number} start        first index touched
 * @property {number} removed      messages taken out at start
 * @property {number} inserted     messages put in at start
 * @property {number} delta        inserted - removed
 * @property {string} [sourceChat] branch the merged messages came from
 * @property {number} [srcStart]   first merged index in the source chat
 * @property {number} [srcEnd]     last merged index in the source chat
 * @property {object} [sourceMetadata] chat_metadata of the source chat
 * @property {object} options      user choices from the preview
 */

export function makeOp(fields) {
    const op = { options: {}, ...fields };
    op.delta = op.inserted - op.removed;
    return op;
}

/**
 * Where a stored single index ends up.
 * @returns {{kind: 'keep'|'shift'|'inside', value: number}}
 */
export function mapPoint(i, op) {
    if (i < op.start) return { kind: 'keep', value: i };
    if (i >= op.start + op.removed) return { kind: 'shift', value: i + op.delta };
    return { kind: 'inside', value: i };
}

/**
 * Where a stored inclusive range [s, e] ends up.
 * - before:   entirely before the touched span, unchanged
 * - after:    entirely after, shifted
 * - contains: covers the whole replaced span (or straddles an insertion point); end moves by delta
 * - overlap:  cuts into the replaced span; cannot be mapped mechanically
 * @returns {{kind: 'before'|'after'|'contains'|'overlap', s: number, e: number}}
 */
export function mapRange(s, e, op) {
    const { start, removed, delta } = op;
    if (e < start) return { kind: 'before', s, e };
    if (s >= start + removed) return { kind: 'after', s: s + delta, e: e + delta };
    if (removed > 0 && s <= start && e >= start + removed - 1) return { kind: 'contains', s, e: e + delta };
    if (removed === 0 && s < start && e >= start) return { kind: 'contains', s, e: e + delta };
    return { kind: 'overlap', s, e };
}

export function newReport() {
    return { info: [], warnings: [], conflicts: [], blockers: [] };
}

export function isInt(v) {
    return Number.isInteger(v) || (typeof v === 'string' && /^-?\d+$/.test(v));
}
