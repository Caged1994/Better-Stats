/**
 * Dungeon — the link between the dungeon rules (src/utils/dungeonModel.js)
 * and the rest of Better Stats.
 *
 * The program lays the dungeon out; the AI dresses it once (names, one
 * sentence per room, who the enemies are) and tells the story at the end.
 * Fights use the combat window, traps and locked chests use dice (the same
 * rules as checks, rolled without telling the story), and Health, Mana, XP,
 * money and items are the real ones of the open chat.
 *
 * The dungeon is kept in the chat after every step
 * (chat_metadata.dooms_tracker.betterStats.dungeon = { state }), so closing the
 * window or reloading the page does not lose it.
 */
import { executeSlashCommandsOnChatInput } from '../../../../../../../scripts/slash-commands.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { repairJSON } from '../../utils/jsonRepair.js';
import { isRpgModeActive } from './rpgMode.js';
import { chatStore, saveChatScope } from './chatScope.js';
import { getStatSheet, getCurrentStatValues, setCurrentStatValue, getPersonaName, notifyStatsChanged } from './characterStats.js';
import { awardPartyXp, getXpSettings, isXpEnabled } from './characterProgress.js';
import { rollCheckFor, getCheckAttributes } from './characterChecks.js';
import { activeStats } from '../../utils/statsModel.js';
import { resolveDifficulty, successChance } from '../../utils/checkModel.js';
import * as D from '../../utils/dungeonModel.js';
import * as M from '../../utils/combatModel.js';
import {
    isCombatEnabled, buildEncounter, saveLiveEncounter, getLiveEncounter, getLastEncounter,
    collectLabelRequests, applyLabelReplies, normalizeEnemySpecs, grantSpoils, recentMessages, cardInfo,
} from './combat.js';
import { buildDungeonDressingPrompt, buildDungeonNarrationPrompt } from '../generation/dungeonPrompts.js';

// ─── Settings ───────────────────────────────────────────────────────────────

/** The dungeon needs RPG mode and combat (its rooms hold fights). */
export function isDungeonEnabled() {
    return isRpgModeActive() && isCombatEnabled() && extensionSettings.dungeonEnabled !== false;
}

export function setDungeonEnabled(on) {
    extensionSettings.dungeonEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

export function isDungeonNarrationOn() {
    return extensionSettings.dungeonNarration !== false;
}

export function setDungeonNarration(on) {
    extensionSettings.dungeonNarration = !!on;
    saveSettings();
}

// ─── The dungeon in the chat ────────────────────────────────────────────────

export function getLiveDungeon() {
    const st = chatStore('dungeon')?.state;
    return st && typeof st === 'object' && Array.isArray(st.floors) ? st : null;
}

export function saveLiveDungeon(state) {
    const s = chatStore('dungeon', true);
    if (!s) return;
    s.state = state;
    saveChatScope();
}

export function clearLiveDungeon() {
    const s = chatStore('dungeon');
    if (s && s.state) { delete s.state; saveChatScope(); }
}

/** Whether an expedition is waiting in this chat. */
export function hasLiveDungeon() {
    return !!getLiveDungeon();
}

// ─── Creating one ───────────────────────────────────────────────────────────

/**
 * Builds a dungeon for a party and, unless `useAI` is false, has the AI dress
 * it. If the AI fails the dungeon is still complete (generic names), and
 * `aiError` says why.
 * @param {Array<{name, isUser}>} party
 * @param {{theme?: string, floors?: number, size?: string, useAI?: boolean, seed?: number, generate?: Function, depth?: number}} [o]
 * @returns {Promise<{ state, labelled: number, aiError?: string }>}
 */
export async function createDungeon(party, { theme = '', floors = 1, size = 'medium', useAI = true, seed = Date.now(), generate = safeGenerateRaw, depth = 6 } = {}) {
    const { members, toLabel, keyed } = collectLabelRequests(party);
    const levels = members.map(m => m.combatant.level);
    const partyLevel = levels.length ? Math.max(1, Math.round(levels.reduce((a, b) => a + b, 0) / levels.length)) : 1;
    const state = D.generateDungeon({ seed, floors, size, partySize: party.length, partyLevel, theme });
    state.party = party.map(p => ({ name: p.name, isUser: !!p.isUser }));
    let labelled = 0;
    let aiError;
    if (useAI) {
        try {
            const card = cardInfo();
            const messages = buildDungeonDressingPrompt({
                state,
                party: members.map(m => ({ name: m.combatant.name, isUser: m.combatant.isUser, level: m.combatant.level })),
                player: getPersonaName() || 'the player',
                cardName: card.name,
                cardDescription: card.description,
                messages: recentMessages(depth),
                toLabel: toLabel.slice(0, 40),
            });
            const reply = await generate({ prompt: messages, quietToLoud: false });
            const m = String(reply || '').match(/\{[\s\S]*\}/);
            if (!m) throw new Error('The AI did not return any JSON.');
            const data = repairJSON(m[0], { allowFunctionEval: false });
            if (!data || typeof data !== 'object') throw new Error('The AI reply could not be read.');
            const dressed = D.applyDressing(state, data, normalizeEnemySpecs);
            if (!dressed) throw new Error('The AI reply had no rooms in it.');
            labelled = applyLabelReplies(data.profiles, keyed);
        } catch (e) {
            aiError = e?.message || 'The AI could not be reached.';
        }
    }
    D.fillDressing(state);
    D.addLog(state, `${state.title || 'The dungeon'} — ${state.floors.length} floor${state.floors.length === 1 ? '' : 's'}.`, 'info');
    D.addLog(state, D.currentRoom(state).desc, 'info');
    return { state, labelled, ...(aiError ? { aiError } : {}) };
}

// ─── The party's state (the real Health and Mana bars) ──────────────────────

function pctOf(name, isUser, id) {
    const stats = activeStats(getStatSheet(name, isUser));
    if (!stats.some(s => s.id === id)) return null;
    const v = getCurrentStatValues(name, isUser, stats)[id];
    return Number.isFinite(v) ? v : null;
}

/** Each member's Health and Mana (percent, null when there is no such bar). */
export function partyStatus(state) {
    return state.party.map(p => ({ ...p, health: pctOf(p.name, p.isUser, 'health'), mana: pctOf(p.name, p.isUser, 'mana') }));
}

function changeBar(name, isUser, id, delta, { floor = 0 } = {}) {
    const cur = pctOf(name, isUser, id);
    if (cur === null) return null;
    const next = Math.max(floor, Math.min(100, Math.round(cur + delta)));
    setCurrentStatValue(name, isUser, id, next, { persist: false, silent: true });
    return next - cur;
}

/** Hurts one member by `points` of the Health bar; nobody dies here: the bar stops at 1. */
export function damageMember(name, isUser, points) {
    const done = changeBar(name, isUser, 'health', -Math.abs(points), { floor: 1 });
    saveChatScope();
    notifyStatsChanged({ source: 'dungeon', name });
    return done === null ? 0 : -done;
}

/** Heals everyone in the party. */
export function healParty(state, health, mana) {
    for (const p of state.party) {
        if (health) changeBar(p.name, p.isUser, 'health', health);
        if (mana) changeBar(p.name, p.isUser, 'mana', mana);
    }
    saveChatScope();
    notifyStatsChanged({ source: 'dungeon' });
}

// ─── Experience ─────────────────────────────────────────────────────────────

function giveXp(state, size, reason) {
    if (!isXpEnabled()) return 0;
    const amount = getXpSettings().tiers[size] || 0;
    if (amount <= 0) return 0;
    awardPartyXp(amount, { reason: `Dungeon: ${reason}`.slice(0, 80), source: 'ai' });
    state.stats.xp += amount;
    return amount;
}

// ─── Moving ─────────────────────────────────────────────────────────────────

export function goTo(state, roomId) {
    const res = D.move(state, roomId);
    if (res.ok) saveLiveDungeon(state);
    return res;
}

export function goDown(state) {
    const res = D.descend(state);
    if (res.ok) {
        const xp = giveXp(state, 'medium', `reached floor ${state.floor + 1}`);
        D.addLog(state, D.currentRoom(state).desc, 'info');
        if (xp) D.addLog(state, `+${xp} XP for going deeper.`, 'highlight');
        saveLiveDungeon(state);
    }
    return res;
}

// ─── Fights ─────────────────────────────────────────────────────────────────

function launchFight(state, specs, { kind, label }) {
    const room = D.currentRoom(state);
    const fight = buildEncounter(state.party, specs, {
        environment: `${state.title ? state.title + ' — ' : ''}${room.name}`.slice(0, 160),
        tag: { dungeon: state.id, room: room.id, floor: state.floor, kind },
    });
    M.startCombat(fight);
    saveLiveEncounter(fight);
    state.pendingFight = { room: room.id, floor: state.floor, kind, from: state.from, at: Date.now() };
    D.addLog(state, label, 'fight');
    saveLiveDungeon(state);
    return fight;
}

/** Starts the fight of the room the party is in. Returns the fight (already started and saved). */
export function startRoomFight(state) {
    const room = D.currentRoom(state);
    if (!room || !(room.type === 'combat' || room.type === 'boss') || room.cleared || state.pendingFight) return null;
    return launchFight(state, D.roomEnemies(room), { kind: 'room', label: room.type === 'boss' ? `${room.enemies[0]?.name || 'The master of this place'} faces you.` : 'You fight.' });
}

/** Camping: either a quiet rest, or a group finds the party (a fight). */
export function camp(state) {
    const room = D.currentRoom(state);
    if (!room || state.pendingFight || D.blocksExit(room) || state.phase !== 'active') return { ok: false };
    const roll = D.rollCamp(state);
    if (roll.ambush) {
        const specs = D.wanderingSpecs(state, D.ambushTiers(state));
        const fight = launchFight(state, specs, { kind: 'ambush', label: 'Something finds you while you rest.' });
        return { ok: true, ambush: true, fight, chance: roll.chance };
    }
    healParty(state, D.REST.campHealth, D.REST.campMana);
    state.stats.rests++;
    D.addLog(state, `You rest a while. (+${D.REST.campHealth} Health, +${D.REST.campMana} Mana)`, 'rest');
    saveLiveDungeon(state);
    return { ok: true, ambush: false, chance: roll.chance };
}

/** The proper rest of a safe place, once. */
export function useRestRoom(state) {
    const room = D.currentRoom(state);
    if (!room || room.type !== 'rest' || room.cleared || state.pendingFight) return { ok: false };
    healParty(state, room.rest.health, room.rest.mana);
    room.cleared = true;
    state.stats.rests++;
    D.addLog(state, `You rest in safety. (+${room.rest.health} Health, +${room.rest.mana} Mana)`, 'rest');
    saveLiveDungeon(state);
    return { ok: true, health: room.rest.health, mana: room.rest.mana };
}

/**
 * Takes in how a fight of this dungeon ended.
 * @param {object} state
 * @param {{ result: string, xp?: number, money?: number, items?: string[] }} last
 */
export function resolveFight(state, last) {
    const pending = state.pendingFight;
    if (!pending) return { ok: false };
    state.pendingFight = null;
    state.stats.fights++;
    state.stats.xp += last.xp || 0;
    state.stats.money = Math.round((state.stats.money + (last.money || 0)) * 100) / 100;
    for (const it of last.items || []) if (!state.stats.items.includes(it)) state.stats.items.push(it);
    const room = D.getRoom(state, pending.room, pending.floor);
    let ended = null;
    if (last.result === 'victory') {
        if (pending.kind === 'room' && room) {
            room.cleared = true;
            D.addLog(state, room.type === 'boss' ? 'The last enemy falls.' : 'The way is clear.', 'highlight');
            if (room.type === 'boss' && D.isLastFloor(state)) ended = 'cleared';
        } else if (pending.kind === 'ambush') {
            healParty(state, D.REST.campHealth, D.REST.campMana);
            state.stats.rests++;
            D.addLog(state, `You drive them off, then rest. (+${D.REST.campHealth} Health, +${D.REST.campMana} Mana)`, 'highlight');
        }
    } else if (last.result === 'fled') {
        if (pending.kind === 'room' && pending.from && room) {
            state.at = pending.from;
            state.from = null;
            D.addLog(state, 'You fall back to the room you came from. They are still there.', 'move');
        } else {
            D.addLog(state, 'You get away.', 'move');
        }
    } else {
        ended = 'defeated';
        D.addLog(state, 'The party falls. Nobody dies — you drag yourselves out.', 'highlight');
    }
    if (ended) endDungeon(state, ended);
    saveLiveDungeon(state);
    return { ok: true, ended };
}

/**
 * If a fight of this dungeon ended while the window was away (a reload, the
 * fight window closed), settles it from the saved result.
 * @returns {boolean} whether something changed
 */
export function reconcileFight(state) {
    const pending = state?.pendingFight;
    if (!pending) return false;
    if (getLiveEncounter()) return false; // still being fought
    const last = getLastEncounter();
    if (last && last.tag && last.tag.dungeon === state.id && last.tag.room === pending.room && last.at >= pending.at) {
        resolveFight(state, last);
        return true;
    }
    // The fight is gone without a trace: do not leave the party stuck.
    state.pendingFight = null;
    D.addLog(state, 'The fight is over.', 'info');
    saveLiveDungeon(state);
    return true;
}

// ─── Traps and chests (dice) ────────────────────────────────────────────────

function modOf(name, isUser, statId) {
    return getCheckAttributes(name, isUser).find(a => a.id === statId) || null;
}

/** Who could try, with their chance at a stat and difficulty. */
export function tryOptions(state, statId, difficulty) {
    const dc = resolveDifficulty(difficulty).dc;
    return state.party.map(p => {
        const a = modOf(p.name, p.isUser, statId);
        return { ...p, value: a?.value ?? null, modifier: a?.modifier ?? 0, chance: a ? successChance(a.modifier, dc) : 0, has: !!a };
    });
}

/** Rolls for a member; the dice are real, nothing is told to the story. */
function roll(state, actor, statId, difficulty, reason, rng) {
    return rollCheckFor(actor.name, actor.isUser, { stat: statId, difficulty, reason, source: 'dungeon', record: false, rng });
}

/** Tries to get past the trap of the room. */
export function attemptTrap(state, actor, { rng } = {}) {
    const room = D.currentRoom(state);
    if (!room || room.type !== 'trap' || room.cleared || state.pendingFight) return { ok: false };
    const t = room.trap;
    const entry = roll(state, actor, t.stat, t.difficulty, 'a trap', rng);
    if (!entry) return { ok: false };
    state.stats.traps++;
    room.cleared = true;
    let damage = 0;
    let xp = 0;
    if (entry.success) {
        xp = giveXp(state, 'small', 'a trap avoided');
        D.addLog(state, `${actor.name} spots and avoids the trap.${xp ? ` (+${xp} XP)` : ''}`, 'highlight');
    } else {
        state.stats.trapsFailed++;
        const points = Math.round(t.damage * (entry.degree === 'critical-failure' ? 1.5 : 1));
        damage = damageMember(actor.name, actor.isUser, points);
        D.addLog(state, `${actor.name} sets it off and loses ${damage} Health.`, 'highlight');
    }
    saveLiveDungeon(state);
    return { ok: true, entry, success: entry.success, damage, xp, actor };
}

/**
 * Opens the chest of the room. `method`: 'open' (not locked), 'pick' (Dexterity)
 * or 'force' (Strength). A failed attempt leaves the chest jammed: half the
 * money, no items; forcing it also costs a few Health.
 */
export function openChest(state, { method = 'open', actor = null, rng } = {}) {
    const room = D.currentRoom(state);
    if (!room || room.type !== 'treasure' || room.cleared || state.pendingFight) return { ok: false };
    const loot = room.loot;
    let entry = null;
    let outcome = 'full';
    let damage = 0;
    if (loot.locked) {
        if (!actor) return { ok: false };
        const stat = method === 'force' ? loot.forceStat : loot.lockStat;
        entry = roll(state, actor, stat, loot.lockDifficulty, method === 'force' ? 'forcing a chest' : 'picking a lock', rng);
        if (!entry) return { ok: false };
        if (entry.degree === 'critical-success') outcome = 'rich';
        else if (!entry.success) {
            outcome = 'jammed';
            if (method === 'force') damage = damageMember(actor.name, actor.isUser, D.DAMAGE.chestBase);
        }
    }
    let money = loot.money;
    let items = [...loot.items];
    if (outcome === 'jammed') { money = Math.round(money / 2); items = []; }
    if (outcome === 'rich') money = Math.round(money * 1.5);
    const spoils = grantSpoils({ money, items });
    room.cleared = true;
    state.stats.chests++;
    state.stats.money = Math.round((state.stats.money + spoils.money) * 100) / 100;
    for (const it of spoils.items) if (!state.stats.items.includes(it)) state.stats.items.push(it);
    const xp = outcome === 'jammed' ? 0 : giveXp(state, 'small', 'a chest opened');
    const what = [spoils.items.join(', '), spoils.money ? `${spoils.money} money` : ''].filter(Boolean).join(' and ') || 'nothing of use';
    D.addLog(state, outcome === 'jammed'
        ? `The chest jams and spills only part of its contents: ${what}.${damage ? ` (−${damage} Health)` : ''}`
        : `You open the chest: ${what}.${xp ? ` (+${xp} XP)` : ''}`, 'highlight');
    saveLiveDungeon(state);
    return { ok: true, entry, outcome, money: spoils.money, items: spoils.items, damage, xp };
}

// ─── The end ────────────────────────────────────────────────────────────────

/** Marks the expedition over (nothing else happens until it is finished). */
export function endDungeon(state, result) {
    if (state.phase === 'ended') return;
    state.phase = 'ended';
    state.result = result;
    D.addLog(state, { cleared: 'The dungeon is cleared.', left: 'You leave the dungeon.', defeated: 'The expedition is over.' }[result] || 'The expedition is over.', 'highlight');
    saveLiveDungeon(state);
}

function sanitizeForSlash(text) {
    return String(text || '').replace(/\|/g, '¦').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }').replace(/^\/+/, '').trim();
}

/** Has the AI tell the story of the expedition and posts it to the chat. @returns {Promise<string>} */
export async function narrateDungeon(state, { generate = safeGenerateRaw, post = true, depth = 6 } = {}) {
    const card = cardInfo();
    const messages = buildDungeonNarrationPrompt({
        summary: D.summarizeForNarration(state), player: getPersonaName() || 'the player',
        messages: recentMessages(depth), cardName: card.name, cardDescription: card.description,
    });
    const reply = await generate({ prompt: messages, quietToLoud: false });
    const text = sanitizeForSlash(reply);
    if (!text) return '';
    if (post) {
        const speaker = (card.name || 'Narrator').replace(/"/g, '');
        await executeSlashCommandsOnChatInput(`/sendas name="${speaker}" ${text}`, { clearChatInput: false });
    }
    return text;
}

/**
 * Closes the expedition: the bonus for clearing it, the saved dungeon removed,
 * and (if on) the story written into the chat. Safe to call once per run.
 * @returns {Promise<{ summary: object, narration: string, narrationError?: string, bonusXp: number }>}
 */
export async function finishDungeon(state, { narrate = isDungeonNarrationOn(), generate = safeGenerateRaw, post = true } = {}) {
    if (state.phase !== 'ended') endDungeon(state, 'left');
    let bonusXp = 0;
    if (state.result === 'cleared' && !state.finished) bonusXp = giveXp(state, 'large', `cleared ${state.title || 'the dungeon'}`);
    const first = !state.finished;
    state.finished = true;
    const summary = D.summarizeForNarration(state);
    clearLiveDungeon();
    let narration = '';
    let narrationError;
    if (narrate && first) {
        try { narration = await narrateDungeon(state, { generate, post }); } catch (e) { narrationError = e?.message || 'The story could not be written.'; }
    }
    return { summary, narration, bonusXp, ...(narrationError ? { narrationError } : {}) };
}
