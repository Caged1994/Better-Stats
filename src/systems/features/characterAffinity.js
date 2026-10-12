/**
 * Affinity — how each NPC feels about the player's character.
 *
 * One value per NPC (−100…+100) in the open chat:
 *   chat_metadata.dooms_tracker.betterStats.characterAffinity["Name"] = { value, reason, at }
 * The AI gives a starting value the first time an NPC is in a scene and
 * then moves it a little ("affinity" key, at most ±10 per reply); the user
 * can set it in the Stats panel. A swipe puts back the values the replaced
 * reply changed (chat_metadata.dooms_tracker.affinityUndo).
 *
 * The pure logic is in src/utils/affinityModel.js.
 */
import { chat, chat_metadata } from '../../../../../../../script.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { isRpgModeActive } from './rpgMode.js';
import { chatStore, saveChatScope, CHAT_SCOPE } from './chatScope.js';
import { getStatCharacters, getPersonaName, notifyStatsChanged } from './characterStats.js';
import { resolveTarget } from './characterEquipment.js';
import {
    clampAffinity,
    normalizeAIAffinity,
    applyAffinityChange,
    buildAffinityPrompt,
    formatAffinity,
} from '../../utils/affinityModel.js';

export function isAffinityEnabled() {
    return isRpgModeActive() && extensionSettings.characterAffinityEnabled !== false;
}

export function setAffinityEnabled(on) {
    extensionSettings.characterAffinityEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

function store(create = false) {
    return chatStore('characterAffinity', create);
}

function findKey(obj, name) {
    if (!obj || !name) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, name)) return name;
    const lower = String(name).toLowerCase();
    return Object.keys(obj).find(k => k.toLowerCase() === lower);
}

function rawRecord(name) {
    const s = store();
    const k = findKey(s, name);
    return k !== undefined ? s[k] : null;
}

/** The NPC's affinity toward the persona, or null when none is set yet. */
export function getAffinity(name) {
    const r = rawRecord(name);
    return r && typeof r.value === 'number' ? r.value : null;
}

/** { value, reason, at } or null. */
export function getAffinityRecord(name) {
    const r = rawRecord(name);
    return r && typeof r.value === 'number' ? { ...r } : null;
}

function write(name, value, reason = '') {
    const s = store(true);
    if (!s) return;
    const k = findKey(s, name);
    s[k !== undefined ? k : name] = { value, reason: String(reason || '').slice(0, 100), at: Date.now() };
}

/** Sets an NPC's affinity by hand. Returns the stored value. */
export function setAffinity(name, value) {
    const v = clampAffinity(value);
    if (v === null || !name) return null;
    write(name, v, 'Set by hand');
    saveChatScope();
    notifyStatsChanged({ source: 'affinity', name });
    return v;
}

/**
 * Moves an NPC's affinity by `delta` (a fight, an event outside the AI's
 * replies). Does nothing for an NPC with no value yet — nothing is invented.
 * Returns the new value, or null.
 */
export function adjustAffinity(name, delta, reason = '') {
    if (!isAffinityEnabled() || !name) return null;
    const before = getAffinity(name);
    if (before === null) return null;
    const v = clampAffinity(before + Number(delta || 0));
    if (v === null || v === before) return before;
    write(name, v, reason);
    saveChatScope();
    notifyStatsChanged({ source: 'affinity', name });
    return v;
}

export function deleteAffinity(name) {
    const s = store();
    const k = findKey(s, name);
    if (k !== undefined) { delete s[k]; saveChatScope(); }
}

export function mergeAffinity(canonical, variant) {
    const s = store();
    const vk = findKey(s, variant);
    if (vk === undefined) return;
    if (findKey(s, canonical) === undefined) s[canonical] = s[vk];
    if (vk !== canonical) delete s[vk];
}

function sceneNpcs() {
    return getStatCharacters().filter(c => !c.isUser).map(c => c.name);
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export function buildAffinityPromptForGeneration({ compact = true, standalone = false } = {}) {
    if (!isAffinityEnabled()) return '';
    const player = getPersonaName();
    const npcs = sceneNpcs();
    const known = npcs.filter(n => getAffinity(n) !== null).map(n => ({ name: n, value: getAffinity(n) }));
    const needStart = npcs.filter(n => getAffinity(n) === null);
    return buildAffinityPrompt({ player, known, needStart, compact, standalone });
}

export function buildAffinityContextSummary() {
    if (!isAffinityEnabled()) return '';
    const player = getPersonaName();
    const known = sceneNpcs().filter(n => getAffinity(n) !== null);
    if (!player || !known.length) return '';
    return `Affinity toward ${player}: ${known.map(n => formatAffinity(n, getAffinity(n))).join(', ')}`;
}

// ─── Applying the AI's update ───────────────────────────────────────────────

/**
 * Applies the "affinity" of a fresh reply. A starting value is only taken
 * for an NPC that has none; a change only for one that has one.
 * @returns {number} NPCs changed
 */
export function applyAIAffinity(raw, messageIndex) {
    if (!isAffinityEnabled() || raw === null || raw === undefined) return 0;
    const snapshots = [];
    for (const change of normalizeAIAffinity(raw)) {
        const target = resolveTarget(change.name);
        if (!target || target.isUser) continue;
        const before = getAffinityRecord(target.name);
        const isStart = change.set !== undefined;
        if (isStart && before) continue;          // starting value only once
        if (!isStart && !before) {                 // a change before any start: start from 0
            change.delta = change.delta || 0;
        }
        const value = applyAffinityChange(before ? before.value : 0, change);
        if (value === null || (before && value === before.value)) continue;
        write(target.name, value, change.reason || (isStart ? 'First impression' : ''));
        const prev = snapshots.find(x => x.name === target.name);
        if (prev) prev.after = getAffinityRecord(target.name);
        else snapshots.push({ name: target.name, before, after: getAffinityRecord(target.name) });
    }
    console.log(`[Dooms Tracker] Affinity: ${snapshots.length} character(s) changed`);
    if (!snapshots.length) return 0;
    try {
        if (chat_metadata) {
            if (!chat_metadata.dooms_tracker) chat_metadata.dooms_tracker = {};
            const prev = chat_metadata.dooms_tracker.affinityUndo;
            let snaps = snapshots;
            if (prev && prev.messageIndex === messageIndex && Array.isArray(prev.snapshots)) {
                snaps = prev.snapshots.map(p => ({ ...p }));
                for (const sn of snapshots) {
                    const old = snaps.find(x => x.name === sn.name);
                    if (old) old.after = sn.after;
                    else snaps.push(sn);
                }
            }
            chat_metadata.dooms_tracker.affinityUndo = { messageIndex, campaign: CHAT_SCOPE, snapshots: snaps };
        }
    } catch (e) { /* undo is best-effort */ }
    saveChatScope();
    notifyStatsChanged({ source: 'ai' });
    return snapshots.length;
}

/** Before a swipe/regenerate: put back the values the replaced reply set, where untouched since. */
export function revertAIAffinityForReplacedMessage(replacedIndex) {
    try {
        const rec = chat_metadata?.dooms_tracker?.affinityUndo;
        if (!rec) return 0;
        const lastIdx = Array.isArray(chat) ? chat.length - 1 : -1;
        const idx = typeof replacedIndex === 'number' ? replacedIndex : lastIdx;
        if (rec.messageIndex !== idx && rec.messageIndex !== idx + 1) return 0;
        delete chat_metadata.dooms_tracker.affinityUndo;
        let n = 0;
        for (const { name, before, after } of rec.snapshots || []) {
            const now = getAffinityRecord(name);
            if (!now || !after || now.value !== after.value || now.at !== after.at) continue;
            if (before) write(name, before.value, before.reason);
            else deleteAffinity(name);
            n++;
        }
        if (n) {
            saveChatScope();
            notifyStatsChanged({ source: 'undo' });
        }
        saveChatData();
        return n;
    } catch (e) {
        console.warn('[Dooms Tracker] Affinity: undo failed', e);
        return 0;
    }
}
