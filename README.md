# Timeline Retcon Merger

A SillyTavern extension that takes a range of messages from a branch or checkpoint and merges it into the open chat. It can replace a placeholder or insert without replacing anything. The replaced messages are archived so you can read them later. Index-based data in Memory Books and WorldTracker is remapped so it keeps pointing at the right messages.

Built against SillyTavern 1.19.0 (staging), Memory Books 9.1.1 and WorldTracker 0.1.0 (with its `timeline_retcon_applied` handler, commit 3b44d06).

## Install

The extension already lives in `data/default-user/extensions/SIllyTavern-TimelineRetconMerger`, which SillyTavern loads as a third-party extension.

1. Reload SillyTavern in the browser.
2. Open **Extensions** and check that *Timeline Retcon Merger* is enabled. Its panel appears in the right-hand extensions column.

## Use

### Deferred scene

1. At the start of the scene, create a checkpoint or branch.
2. In the main chat, write a short placeholder. Optionally, open the **⋯** menu on that message and choose **Mark as placeholder** (the hourglass icon).
3. Later, write the full scene in the branch.
4. Back in the main chat, open the **⋯** menu on the placeholder and choose **Merge branch messages here** (the merge icon). You can also use the panel button or `/retcon-merge`.
5. Pick the branch. The extension detects where the branch splits off and preselects the placeholder. Then click **Preview…**.
6. Read the report, choose options, and click **Merge**.

### Retcon an existing scene

Redo the scene in a branch, then merge it with **Replace** over the original scene's messages.

### View the original, or undo

Merged messages get a colored left border and a ⎇ badge next to the speaker name. Click the badge to open a read-only viewer with *Side by side*, *Original* and *Current* views, plus **Undo this merge…**. Viewing never changes the chat. The chat always holds the merged version.

### Slash commands (for Quick Replies)

| Command | Does |
|---|---|
| `/retcon-merge [source=<chat>] [srcend=N] [target=A-B \| insert=N]` | Opens the merge dialog, pre-filled. A preview is always shown before anything changes. |
| `/retcon-undo [id]` | Undoes a merge (default: the latest in this chat), with a preview first |
| `/retcon-view [mesid]` | Opens the viewer for a merged message (default: the latest merge) |
| `/retcon-pending [mesid]` | Without an argument, lists placeholders. With a message index, marks or unmarks that message. |
| `/retcon-list` | Lists the retcons in this chat |
| `/retcon-backups` | Restores or deletes backups |

## Safety model

- **A backup is made before every merge and every undo.** It contains the full chat file and every lorebook about to be written, and it is saved to `data/default-user/user/files/trm_*`. **Backups** in the panel restores one as a *new* chat, so the live chat is never overwritten. Lorebooks are only restored when you tick the box. The extension keeps 30 backups by default; change this in the panel.
- **The merge is refused rather than guessed** in these cases:
  - no shared history
  - the target overlaps the shared history
  - the chat changed between preview and apply
  - a generation is running
  - a message is being edited
  - Memory Books scene markers are set
- **Merged messages are copied whole.** Swipes, `extra`, hidden flags, names, avatars and timestamps are kept. Checkpoint and branch links that point *inside* the branch are dropped.
- **Undo** puts the archived originals back and reverses the index remap. It uses a per-field change log, so anything edited since the merge is reported and left alone.

## What gets remapped

| Where | What |
|---|---|
| Memory Books, chat metadata | `highestMemoryProcessed` (if it sits inside the replaced range, you choose *unprocessed* or *processed*); `autoSummaryNextPromptAt` |
| Memory Books, lorebooks (every lorebook is scanned) | For memories whose `STMB_chatId` is this chat: `STMB_start` and `STMB_end`. A memory that covered the replaced range gets a longer range and a "consider regenerating" warning. A partial overlap is listed and left unchanged. Also updated: side-prompt regeneration snapshots, `STMB_*_lastMsgId`, and topical-clip source |
| Memory Books, branch memories (optional) | Memories written in the branch for the merged messages are moved to this chat's positions. If Memory Books made a `"<book> Branch N"` copy for the branch, they are copied into the parent lorebook instead. |
| WorldTracker | Handled by WorldTracker itself: this extension emits `timeline_retcon_applied` (with `retconId`), and WorldTracker re-keys its saved states, stashes what the merge dropped and restores it on undo. A built-in fallback adapter only runs for older WorldTracker builds that don't advertise `handlesRetconEvent`. |
| SillyTavern | World Info sticky and cooldown timers |

Some things are **warned about but not changed**: StoryMode, RPG Companion's chapter checkpoint and Tracker ids. Some are **stale but harmless**: Prompt Itemization, `{{scene}}` numbers in memory titles, and the vector store, which heals on its next sync.

## Known limitations

- Memory Books scene markers (► / ◄) must be cleared before merging. Memory Books keeps them in a module cache that would overwrite any shifted values.
- Undo does not restore the removed checkpoint link, because the branch may already be deleted.
- Deleting the branch leaves Memory Books' branch lorebook copy (if any) orphaned. Memories from the branch that weren't adopted can no longer be regenerated. The delete confirmation lists this.
- Undoing a merge made before WorldTracker handled retcons itself can't restore the tracker states that merge dropped; the undo preview warns about it.
- The archive of replaced messages is stored in `chat_metadata`. Branches created later from this chat therefore carry a copy of it.

## Test checklist (run on a copy of a chat)

Make a copy first: open the chat and use *Save as* / *Checkpoint*, or duplicate the `.jsonl` in `chats/<character>/`.

1. **Longer scene over a one-message placeholder.**
   - Setup: checkpoint at message N, write a one-line placeholder at N+1 in the main chat, write 8 messages in the branch.
   - Merge with Replace over N+1.
   - Check: order, speakers, swipes and timestamps; a backup exists under Backups; later messages moved by +7.
2. **Shorter scene.** Merge 2 branch messages over 5 main messages. Later messages move by −3.
3. **Insert mode.** Insert without replacing and check that nothing was removed.
4. **Viewer.**
   - Click ⎇ and switch between *Original* and *Current*.
   - Check: the chat `.jsonl` file is unchanged afterwards (compare modified time or diff).
5. **Memory Books.**
   - Before merging, note the following, then merge:
     - `/stmb-highest`
     - the `STMB_start` / `STMB_end` values of a memory *after* the placeholder, and of one *covering* the placeholder
   - Check:
     - the numbers in the preview report match the lorebook JSON afterwards
     - `/nextmemory` starts where you expect
   - With a memory made in the branch, tick "Adopt": it now has the main chat's id and positions, and regenerating it works from the main chat.
   - Set a scene marker and try to merge: the merge is refused.
6. **Undo.** Undo the merge from step 1. The chat content and the Memory Books lorebook JSON match the pre-merge state (compare with the backup files). Only the checkpoint link stays removed.
7. **Group chat.** Repeat step 1 in a group chat. Each merged message keeps its own speaker and avatar. A character removed from the group triggers a warning.
8. **Checkpoint link.** After the merge, the flag icon on the checkpoint message is gone. With "Delete the branch" ticked, the branch disappears from the chat list.
9. **Refusals.**
   - Pick an unrelated chat: refused, no shared history.
   - Start a generation, then try to merge: refused.
   - Edit a merged message, then undo: a warning says the edits will be lost.
