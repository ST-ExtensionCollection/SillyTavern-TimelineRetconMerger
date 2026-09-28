> **Status (2026-09-27):** resolved. WorldTracker implemented item 1 (with `retconId` stash/restore) and item 3, and declined item 2. See `WorldTracker/docs/trm-handoff.md` and `WorldTracker/docs/API.md`. TRM now sends `retconId` and its own adapter steps aside.

# Notes for the WorldTracker session

These notes come from the Timeline Retcon Merger (TRM), which splices message ranges into the middle of a chat.

## Problem

WorldTracker keys its state by message index:

- `chat_metadata.WorldTracker.snapshots[mesId]`, including each delta's `base`
- `history[].mesId`
- `pending[].sourceMessageId`

When messages are inserted or replaced mid-chat, every later index shifts. For now TRM remaps these fields itself (`src/adapters/worldtracker.js`) and rebuilds deltas using WorldTracker's exported `peekSnapshot`. That makes TRM depend on WorldTracker internals.

## Suggested changes (in order of value)

1. **Handle TRM's event and advertise it.** TRM emits `timeline_retcon_applied` on `eventSource`, with the payload `{ direction: 'merge'|'undo', chatId, start, removed, inserted }`. It is emitted after the chat is saved and before the chat is reloaded.
   - If WorldTracker remaps itself in response, set `globalThis.WorldTracker = { handlesRetconEvent: true }`, or set `chat_metadata.WorldTracker.supportsRetconEvent = true`. TRM then skips its own adapter.
   - Remap rule:
     - Leave `i < start` unchanged.
     - Shift `i >= start + removed` by `inserted - removed`.
     - For indices inside the replaced span: keep the snapshot at `start` (when `removed > 0 && inserted > 0`) and drop the rest.
2. **Stop keying by position.** Give each message a stable id (for example `message.extra.worldTracker.uid`, stamped when the message is first processed). Key snapshots and history by that id, or store the pre-turn snapshot directly in `message.extra`. Position shifts then cost nothing, and neither TRM nor anything else has to remap.
3. **Fix the `MESSAGE_DELETED` handler.** It currently assumes a tail deletion (`restoreFrom(chat.length)`). When a message is deleted mid-chat, it rolls back the state and prunes every later snapshot and history record. Consider diffing against a snapshot of message identities, as Memory Books does in `memoryRollback.js`, to find the actual deleted range.
4. **Auto-run caution.** WorldTracker runs a tracker LLM call on `CHARACTER_MESSAGE_RENDERED` and `USER_MESSAGE_RENDERED`. TRM avoids those events: it re-renders via `reloadCurrentChat`, which fires only `CHAT_CHANGED`. Any future bulk-insert path should also make sure it doesn't trigger a run for each message.
