// SillyTavern core state that depends on chat length / positions, plus
// extensions we only warn about (not used by this user; no remap written).

import { ctx } from '../st.js';
import { mapPoint, newReport } from './remap.js';

export const coreAdapter = {
    id: 'core',
    label: 'SillyTavern',

    detect() {
        return true;
    },

    preflight() {
        return [];
    },

    async prepare(op) {
        const report = newReport();
        const md = ctx().chatMetadata ?? {};
        const plan = [];

        // World Info sticky/cooldown: {start, end} are chat LENGTHS at activation.
        // Effects that started after the touched point move with the chat.
        const timed = md.timedWorldInfo;
        if (timed && typeof timed === 'object') {
            for (const type of Object.keys(timed)) {
                for (const [key, eff] of Object.entries(timed[type] ?? {})) {
                    const s = Number(eff?.start);
                    if (Number.isFinite(s) && s > op.start) plan.push({ type, key, start: s + op.delta, end: Number(eff.end) + op.delta });
                }
            }
        }
        if (plan.length) report.info.push(`World Info timed effects (sticky/cooldown): ${plan.length} shifted.`);
        report.info.push('Prompt Itemization (the per-message prompt inspector) keeps old message numbers for this chat; cosmetic only.');

        return {
            report,
            books: [],
            applyMeta(metadata) {
                for (const p of plan) {
                    const eff = metadata.timedWorldInfo?.[p.type]?.[p.key];
                    if (eff) {
                        eff.start = p.start;
                        eff.end = p.end;
                    }
                }
            },
            log: null,
        };
    },
};

export const warnOnlyAdapter = {
    id: 'warnings',
    label: 'Other extensions',

    detect() {
        return true;
    },

    preflight() {
        return [];
    },

    async prepare(op) {
        const report = newReport();
        const md = ctx().chatMetadata ?? {};
        const after = v => Number.isInteger(v) && mapPoint(v, op).kind !== 'keep';

        const map = md.StoryMode?.blueprintState?.sceneMessageMap;
        if (map && Object.values(map).some(ids => Array.isArray(ids) && ids.some(after))) {
            report.warnings.push('StoryMode scene message map references messages at or after this point; it is not remapped and scene summaries may read the wrong messages.');
        }
        if (after(md.rpg_companion_chapter_checkpoint)) {
            report.warnings.push('RPG Companion chapter checkpoint is at or after this point and is not remapped.');
        }
        if (after(md.tracker?.inlineTrackerId) || after(md.tracker?.tempTrackerId)) {
            report.warnings.push('Tracker has an in-progress message id at or after this point; not remapped.');
        }
        return { report, books: [], applyMeta() {}, log: null };
    },
};
