/**
 * Checks — rolls for the characters, kept in the open chat.
 *
 * A check is d20 + an attribute's modifier against a difficulty
 * (src/utils/checkModel.js). It starts in one of two ways:
 *   - the player rolls by hand (the 🎲 button in the Stats panel);
 *   - the AI suggests one ("check" key of its tracker JSON); it waits as a
 *     pending request until the player rolls or dismisses it.
 * The result is not posted in the chat: it is added, as a fact, to the next
 * prompt so the story follows it, and stays there for one reply.
 *
 * In the chat (chat_metadata.dooms_tracker.betterStats.characterChecks):
 *   { pending: {who, stat, difficulty, dc, reason, at} | null,
 *     results: [{ id, name, isUser, stat, statLabel, difficultyLabel, die, modifier,
 *                 bonus, total, dc, margin, success, degree, reason, source,
 *                 afterIndex, consumedAt }] }   (the last 20)
 */
import { chat } from '../../../../../../../script.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { isRpgModeActive } from './rpgMode.js';
import { chatStore, saveChatScope } from './chatScope.js';
import { getStatCharacters, getStatSheet, getCurrentStatValues, getPersonaName, notifyStatsChanged } from './characterStats.js';
import { getEffectiveStatValues } from './characterModifiers.js';
import { resolveTarget } from './characterEquipment.js';
import { activeStats } from '../../utils/statsModel.js';
import {
    DIFFICULTIES, resolveDifficulty, rollCheck, successChance, attributeModifier,
    normalizeCheckRequest, describeResult, buildChecksPrompt,
} from '../../utils/checkModel.js';

const KEEP_RESULTS = 20;

export function isChecksEnabled() {
    return isRpgModeActive() && extensionSettings.checksEnabled !== false;
}

export function setChecksEnabled(on) {
    extensionSettings.checksEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

function store(create = false) {
    const s = chatStore('characterChecks', create);
    if (s && create) {
        if (!Array.isArray(s.results)) s.results = [];
        if (!('pending' in s)) s.pending = null;
    }
    return s;
}

const lastIndex = () => (Array.isArray(chat) ? chat.length - 1 : -1);

// ─── Attributes ─────────────────────────────────────────────────────────────

/**
 * The attributes a character can be tested on, with their current value
 * (equipment and conditions included) and modifier.
 * @returns {Array<{id, name, abbr, value, modifier}>}
 */
export function getCheckAttributes(name, isUser) {
    const stats = activeStats(getStatSheet(name, isUser));
    const eff = getEffectiveStatValues(name, isUser, stats).values;
    const cur = getCurrentStatValues(name, isUser, stats);
    return stats.filter(s => s.kind === 'attribute').map(s => {
        const value = Number.isFinite(eff[s.id]) ? eff[s.id] : cur[s.id];
        return { id: s.id, name: s.name, abbr: s.abbr || s.name, value, modifier: attributeModifier(value) };
    });
}

function findAttribute(name, isUser, token) {
    const t = String(token || '').toLowerCase().trim();
    if (!t) return null;
    const list = getCheckAttributes(name, isUser);
    return list.find(a => a.id.toLowerCase() === t)
        || list.find(a => String(a.abbr).toLowerCase() === t)
        || list.find(a => String(a.name).toLowerCase() === t)
        || list.find(a => String(a.name).toLowerCase().startsWith(t))
        || null;
}

/** The chance (0–1) of a check, for the roll dialog. */
export function checkChance(name, isUser, statId, dc, bonus = 0) {
    const a = findAttribute(name, isUser, statId);
    if (!a) return null;
    return successChance(a.modifier + (Number(bonus) || 0), dc);
}

// ─── Rolling ────────────────────────────────────────────────────────────────

/**
 * Rolls a check for a character and records it for the next prompt.
 * @param {string} name
 * @param {boolean} isUser
 * @param {{stat: string, difficulty?: string|number, bonus?: number, reason?: string, source?: 'player'|'ai'|'dungeon', rng?: Function, record?: boolean}} o
 * @returns {object|null} the recorded result, or null (no such attribute)
 */
export function rollCheckFor(name, isUser, { stat, difficulty = 'medium', bonus = 0, reason = '', source = 'player', rng, record = true } = {}) {
    const attr = findAttribute(name, isUser, stat);
    if (!attr) return null;
    const diff = resolveDifficulty(difficulty);
    const r = rollCheck({ value: attr.value, bonus, dc: diff.dc, rng });
    const entry = {
        id: `chk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
        name, isUser: !!isUser,
        stat: attr.id, statLabel: String(attr.abbr).toUpperCase(),
        difficultyLabel: diff.id ? diff.id : `DC ${diff.dc}`,
        ...r,
        reason: String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 100),
        source: source === 'ai' ? 'ai' : (source === 'dungeon' ? 'dungeon' : 'player'),
        at: Date.now(),
        afterIndex: lastIndex(),
        consumedAt: null,
    };
    // `record: false` rolls without telling the story (a dungeon keeps its own log).
    if (!record) return entry;
    const s = store(true);
    if (!s) return entry;
    s.results.push(entry);
    if (s.results.length > KEEP_RESULTS) s.results.splice(0, s.results.length - KEEP_RESULTS);
    // Rolling answers whatever the AI had asked for.
    s.pending = null;
    saveChatScope();
    notifyStatsChanged({ source: 'checks', name });
    return entry;
}

/** The latest results, newest first. */
export function getRecentChecks(limit = 6) {
    const s = store();
    return (s?.results || []).slice(-limit).reverse();
}

export function clearChecks() {
    const s = store();
    if (!s) return;
    s.results = [];
    s.pending = null;
    saveChatScope();
    notifyStatsChanged({ source: 'checks' });
}

// ─── The AI's request ───────────────────────────────────────────────────────

/** The check the AI suggested and nobody has rolled yet, or null. */
export function getPendingCheck() {
    if (!isChecksEnabled()) return null;
    const p = store()?.pending;
    // A request belongs to the reply that made it and the player's answer to it.
    return p && p.stat && lastIndex() - p.at <= 1 ? { ...p } : null;
}

export function dismissPendingCheck() {
    const s = store();
    if (!s || !s.pending) return;
    s.pending = null;
    saveChatScope();
    notifyStatsChanged({ source: 'checks' });
}

/** Who the pending request is about: the persona unless it names a party NPC. */
export function pendingActor(p = getPendingCheck()) {
    if (!p) return null;
    if (p.who) {
        const t = resolveTarget(p.who);
        if (t) return t;
    }
    const persona = getStatCharacters().find(c => c.isUser);
    return persona ? { name: persona.name, isUser: true } : (getPersonaName() ? { name: getPersonaName(), isUser: true } : null);
}

/**
 * Takes the "check" of a fresh reply (if any) as the pending request, and
 * lets everything older than this reply go: a result has done its job once
 * the AI has answered it, and a request the AI did not repeat has passed.
 * @returns {boolean} whether a request was recorded
 */
export function settleChecks(rawCheck, messageIndex) {
    if (!isChecksEnabled()) return false;
    const s = store(!!rawCheck);
    if (!s) return false;
    let changed = false;
    for (const r of s.results || []) {
        if (r.consumedAt === null && r.afterIndex < messageIndex) { r.consumedAt = messageIndex; changed = true; }
    }
    if (s.pending && s.pending.at < messageIndex) { s.pending = null; changed = true; }
    let recorded = false;
    const req = rawCheck ? normalizeCheckRequest(rawCheck) : null;
    if (req) {
        const actor = req.who ? resolveTarget(req.who) : null;
        const who = actor || getStatCharacters().find(c => c.isUser) || null;
        if (who && findAttribute(who.name, who.isUser, req.stat)) {
            s.pending = { who: who.name, stat: req.stat, difficulty: req.difficulty, dc: req.dc, reason: req.reason, at: messageIndex };
            recorded = true;
            changed = true;
        }
    }
    if (changed) { saveChatScope(); notifyStatsChanged({ source: 'checks' }); }
    return recorded;
}

/** A swipe or regenerate replaced that reply: forget what it asked or consumed. */
export function revertAIChecksForReplacedMessage(index) {
    const s = store();
    if (!s || index === undefined) return;
    let changed = false;
    if (s.pending && s.pending.at === index) { s.pending = null; changed = true; }
    for (const r of s.results || []) {
        // The result is waiting again, as if it had been rolled just before that reply.
        if (r.consumedAt === index) { r.consumedAt = null; r.afterIndex = index - 1; changed = true; }
    }
    if (changed) { saveChatScope(); notifyStatsChanged({ source: 'checks' }); }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

/** The outcome lines still waiting for the story to answer them. */
function activeResults() {
    const s = store();
    const idx = lastIndex();
    return (s?.results || []).filter(r => r.consumedAt === null && idx - r.afterIndex <= 1);
}

function activeNote() {
    return activeResults().map(describeResult).join(' ');
}

/** Instructions to ask for a check, plus the outcome of the last one. */
export function buildChecksPromptForGeneration({ compact = true, standalone = false } = {}) {
    if (!isChecksEnabled()) return '';
    const persona = getStatCharacters().find(c => c.isUser);
    const statIds = persona ? getCheckAttributes(persona.name, true).map(a => a.id) : [];
    return buildChecksPrompt({ player: persona?.name || getPersonaName(), statIds, note: activeNote(), compact, standalone });
}

/** The outcome of the last check, for the roleplay reply (separate mode). */
export function buildChecksContextSummary() {
    if (!isChecksEnabled()) return '';
    const note = activeNote();
    return note ? `Check outcome (rolled by the game; it is fixed, write what happens to match it): ${note}` : '';
}

export { DIFFICULTIES };
