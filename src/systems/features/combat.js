/**
 * Combat — turn-based fights that use the characters' own sheets.
 *
 * The rules are in src/utils/combatModel.js (pure) and the AI's part in
 * src/systems/generation/combatPrompts.js. This module is the glue:
 *   - builds fighters from the Stats data of the open chat (effective
 *     attributes, level, current Health and Mana, equipped gear, spells,
 *     skills and usable items);
 *   - asks the AI for the enemies, and labels once the actions that have no
 *     combat profile yet (labels are kept in the chat: characterCombat);
 *   - keeps the running fight in the chat so a reload resumes it;
 *   - at the end writes the outcome back: Health and Mana bars, leftover
 *     harmful statuses as conditions, used items, XP, money and loot,
 *     affinity — and, if asked, posts the AI's account of the fight to the
 *     chat.
 *
 * Everything lives in the chat that is open (chat_metadata.dooms_tracker
 * .betterStats): the combat profiles under characterCombat and the live
 * fight under combatLive.
 */
import { chat } from '../../../../../../../script.js';
import { getContext } from '../../../../../../extensions.js';
import { executeSlashCommandsOnChatInput } from '../../../../../../../scripts/slash-commands.js';
import { extensionSettings, committedTrackerData, lastGeneratedData } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { repairJSON } from '../../utils/jsonRepair.js';
import { isRpgModeActive } from './rpgMode.js';
import { chatStore, saveChatScope } from './chatScope.js';
import {
    statKey, getStatSheet, getCurrentStatValues, setCurrentStatValue, getPersonaName,
    getStatCharacters, notifyStatsChanged, isCharacterStatsEnabled,
} from './characterStats.js';
import { getEffectiveStatValues } from './characterModifiers.js';
import { getEquipment, addItem, updateItem, isEquipmentEnabled } from './characterEquipment.js';
import { getAbilities, activeManaTiers, isAbilitiesEnabled } from './characterAbilities.js';
import { addCondition, getConditions, isConditionsEnabled } from './characterConditions.js';
import { getLevelInfo, getPartyMembers, isPartyMember, awardPartyXp, getXpSettings, isXpEnabled, isProgressEnabled } from './characterProgress.js';
import { getMoney, setMoney, isMoneyEnabled, getCurrency } from './characterMoney.js';
import { adjustAffinity } from './characterAffinity.js';
import { activeStats } from '../../utils/statsModel.js';
import { itemKey } from '../../utils/equipmentModel.js';
import { formatEffects } from '../../utils/effectsModel.js';
import * as M from '../../utils/combatModel.js';
import { buildEncounterSetupPrompt, buildCombatNarrationPrompt } from '../generation/combatPrompts.js';

// ─── Switches ───────────────────────────────────────────────────────────────

export function isCombatEnabled() {
    return isRpgModeActive() && isCharacterStatsEnabled() && extensionSettings.combatEnabled !== false;
}

export function setCombatEnabled(on) {
    extensionSettings.combatEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

/** Whether the AI's account of a fight is posted to the chat afterwards. */
export function isCombatNarrationOn() {
    return extensionSettings.combatNarration !== false;
}

export function setCombatNarration(on) {
    extensionSettings.combatNarration = !!on;
    saveSettings();
}

// ─── Combat profiles (what each spell, skill and item does) ─────────────────

function profileStore(create = false) {
    return chatStore('characterCombat', create);
}

const profKey = (kind, name) => `${kind}:${itemKey(name)}`;

/** The saved profile of an action of `owner` (a statKey), or null. */
export function getStoredProfile(owner, kind, name) {
    const s = profileStore();
    const p = s?.[owner]?.[profKey(kind, name)];
    return p ? M.normalizeProfile(p) : null;
}

export function setStoredProfile(owner, kind, name, profile) {
    const p = M.normalizeProfile(profile);
    if (!p) return null;
    const s = profileStore(true);
    if (!s) return null;
    if (!s[owner]) s[owner] = {};
    s[owner][profKey(kind, name)] = p;
    saveChatScope();
    return p;
}

/** Forgets a saved profile, so the action is labelled again (by the AI or by its name). */
export function clearStoredProfile(owner, kind, name) {
    const s = profileStore();
    const bag = s?.[owner];
    if (!bag || !(profKey(kind, name) in bag)) return false;
    delete bag[profKey(kind, name)];
    saveChatScope();
    return true;
}

/**
 * What an item counts for in a fight, for the Equipment tab.
 * `editable` is false when the item is a potion, bomb, etc. (not a weapon or armour).
 * `stored` is true when the numbers were set (by you or by the AI) rather than guessed.
 */
export function getItemCombat(name, isUser, item) {
    const owner = statKey(name, isUser);
    const stored = getStoredProfile(owner, 'item', item.name);
    const eff = stored || M.guessProfile('item', item.name, item.desc, { effects: item.effects });
    const gear = !!eff && eff.type === 'gear';
    return {
        stored: !!stored,
        editable: !eff || eff.type === 'gear' || eff.type === 'none',
        atk: gear ? eff.atk : 0,
        def: gear ? eff.def : 0,
        element: gear ? eff.element || '' : '',
        pierce: gear ? !!eff.pierce : false,
        affinities: gear ? { ...(eff.affinities || {}) } : {},
    };
}

/** Sets an item's weapon and armour values by hand; `null` for both goes back to automatic. */
export function setItemGear(name, isUser, itemName, atk, def, extra = {}) {
    const owner = statKey(name, isUser);
    if (atk === null && def === null) return clearStoredProfile(owner, 'item', itemName);
    return !!setStoredProfile(owner, 'item', itemName, {
        type: 'gear', atk: atk || 0, def: def || 0,
        element: extra.element || undefined, pierce: extra.pierce === true, affinities: extra.affinities,
    });
}

/**
 * What a spell, skill or item does in a fight, for the edit forms.
 * `profile` is what the fight would use (saved or guessed); `stored` says it
 * was fixed by you or labelled by the AI rather than guessed.
 * @param {'spell'|'ability'|'item'} kind
 */
export function getActionProfile(name, isUser, kind, entry) {
    const owner = statKey(name, isUser);
    const stored = getStoredProfile(owner, kind, entry.name);
    const profile = stored || M.guessProfile(kind, entry.name, entry.desc, { cost: entry.cost, effects: entry.effects });
    return { stored: !!stored, profile };
}

/** Fixes what an action does by hand; a null profile goes back to automatic. */
export function setActionProfile(name, isUser, kind, entryName, profile) {
    const owner = statKey(name, isUser);
    if (!profile) return clearStoredProfile(owner, kind, entryName);
    return !!setStoredProfile(owner, kind, entryName, profile);
}

/** A short plain description, e.g. "Damage · Medium · INT · may cause burning". */
export function describeProfile(p) {
    if (!p) return '';
    const type = { damage: 'Damage', heal: 'Heals', status: 'Status', mana: 'Restores Mana', cure: 'Cures', revive: 'Revives', gear: 'Weapon / armour', none: 'Not used in a fight' }[p.type] || p.type;
    const bits = [type];
    if (p.type === 'gear') {
        const aff = Object.entries(p.affinities || {}).map(([el, l]) => `${M.ELEMENTS[el].icon}${M.AFFINITIES[l].name.toLowerCase()}`);
        return [`${type} · ⚔${p.atk || 0} 🛡${p.def || 0}`, p.element ? `${M.ELEMENTS[p.element].icon} ${M.ELEMENTS[p.element].name}` : '', p.pierce ? 'Penetration' : '', ...aff].filter(Boolean).join(' · ');
    }
    if (p.type === 'none') return type;
    if (['damage', 'heal', 'mana', 'revive'].includes(p.type)) bits.push(p.power[0].toUpperCase() + p.power.slice(1));
    if (['damage', 'heal'].includes(p.type) && p.stat && p.stat !== 'none') bits.push(p.stat.toUpperCase());
    if (p.element) bits.push(`${M.ELEMENTS[p.element].icon} ${M.ELEMENTS[p.element].name}`);
    if (p.pierce) bits.push('Penetration');
    if (p.status) {
        const detail = [p.type === 'damage' && p.statusChance ? `${Math.round(p.statusChance * 100)}%` : '', p.statusTurns ? `${p.statusTurns} turn${p.statusTurns === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
        bits.push(`${p.type === 'status' ? '' : 'may cause '}${M.STATUSES[p.status]?.name.toLowerCase() || p.status}${detail ? ` (${detail})` : ''}`.trim());
    }
    return bits.join(' · ');
}

// ─── Fighters ───────────────────────────────────────────────────────────────

function combatId(prefix, name) {
    return `${prefix}:${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/** The action a spell or skill gives, with its profile (saved or guessed). */
function abilityAction(owner, a, tiers) {
    const kind = a.type === 'spell' ? 'spell' : 'ability';
    const stored = getStoredProfile(owner, kind, a.name);
    const profile = stored || M.guessProfile(kind, a.name, a.desc, { cost: a.cost, effects: a.effects });
    if (!profile || profile.type === 'gear' || profile.type === 'none') return { skip: true, labelled: !!stored };
    const power = profile.power;
    // Spells cost Mana (their own tier, else the strength of the effect); with
    // the Mana bar off, or for a skill, the price is a pause between uses.
    let manaCost = 0;
    if (kind === 'spell' && tiers) manaCost = tiers[a.cost && M.POWERS.includes(a.cost) ? a.cost : power] || 0;
    return {
        labelled: !!stored,
        action: {
            id: `ab:${a.id}`, label: a.name, icon: a.icon || '✨', kind,
            profile, manaCost, cooldown: manaCost > 0 ? 0 : M.TUNING.cooldown[power] || 0,
        },
    };
}

function itemAction(owner, name, isUser, it) {
    const stored = getStoredProfile(owner, 'item', it.name);
    const profile = stored || M.guessProfile('item', it.name, it.desc, { effects: it.effects });
    return { profile, labelled: !!stored };
}

/**
 * One fighter from a character's sheet in the open chat.
 * @returns {{ combatant, unlabelled: Array }} unlabelled: actions the AI should label
 */
export function buildPartyMember(name, isUser, id = combatId('p', name)) {
    const owner = statKey(name, isUser);
    const sheet = getStatSheet(name, isUser);
    const stats = activeStats(sheet);
    const cur = getCurrentStatValues(name, isUser, stats);
    const eff = getEffectiveStatValues(name, isUser, stats);
    const attrs = {};
    for (const s of stats) if (s.kind === 'attribute') attrs[s.id] = eff.values[s.id];
    const tiers = activeManaTiers();
    const hasHealth = stats.some(s => s.id === 'health');
    const hasMana = !!tiers && stats.some(s => s.id === 'mana');
    const level = isProgressEnabled() ? getLevelInfo(name, isUser).level : 1;

    const unlabelled = [];
    const actions = [];
    let atkBonus = 0;
    let armor = 0;
    let atkElement = '';
    let atkPierce = false;
    let affinities = {};

    if (isAbilitiesEnabled()) {
        for (const a of getAbilities(name, isUser)) {
            const r = abilityAction(owner, a, hasMana ? tiers : null);
            if (!r.labelled) unlabelled.push({ owner, name, isUser, kind: a.type === 'spell' ? 'spell' : 'ability', ref: a.name, desc: a.desc, cost: a.cost });
            if (r.action) actions.push(r.action);
        }
    }
    if (isEquipmentEnabled()) {
        for (const it of getEquipment(name, isUser)) {
            const r = itemAction(owner, name, isUser, it);
            if (!r.labelled) unlabelled.push({ owner, name, isUser, kind: 'item', ref: it.name, desc: it.desc, effects: formatEffects(it.effects, sheet) });
            const p = r.profile;
            if (!p) continue;
            if (p.type === 'gear') {
                if (it.equipped) {
                    atkBonus += p.atk || 0; armor += p.def || 0;
                    if (p.element && !atkElement) atkElement = p.element;
                    if (p.pierce) atkPierce = true;
                    if (p.affinities) affinities = M.mergeAffinities(affinities, p.affinities);
                }
            } else if (M.isUsableItemProfile(p)) {
                actions.push({
                    id: `it:${it.id}`, label: it.name, icon: it.icon || '📦', kind: 'item',
                    profile: p, manaCost: 0, cooldown: 0, qty: it.qty || 1, itemId: it.id,
                });
            }
        }
    }

    const combatant = M.makeCombatant({
        id, side: 'party', name, isUser, level, attrs,
        healthPct: hasHealth ? cur.health : 100,
        mana: hasMana ? cur.mana : null,
        armor, atkBonus, actions, atkElement, atkPierce, affinities,
    });
    return { combatant, unlabelled };
}

/** Who can fight: the player, the party and everybody in the scene. */
export function partyCandidates() {
    const out = [];
    const seen = new Set();
    const push = (name, isUser, inParty) => {
        const k = `${isUser ? 'u' : 'n'}:${String(name).toLowerCase()}`;
        if (!name || seen.has(k)) return;
        seen.add(k);
        let level = 1;
        try { level = isProgressEnabled() ? getLevelInfo(name, isUser).level : 1; } catch (e) { /* no progress */ }
        out.push({ name, isUser, inParty, level });
    };
    const persona = getPersonaName();
    if (persona) push(persona, true, true);
    for (const m of getPartyMembers()) push(m.name, m.isUser, true);
    for (const c of getStatCharacters()) push(c.name, c.isUser, !c.isUser && isPartyMember(c.name));
    return out;
}

// ─── Setting up ─────────────────────────────────────────────────────────────

export function recentMessages(depth) {
    const out = [];
    const list = Array.isArray(chat) ? chat : [];
    for (const m of list.slice(-Math.max(1, depth))) {
        const text = String(m?.mes || '').replace(/<[^>]*>/g, ' ').trim();
        if (text) out.push({ name: m.name || (m.is_user ? 'User' : ''), text });
    }
    return out;
}

const SCENE_SKIP = new Set(['name', 'emoji', 'thoughts', 'locked', 'lock', 'id']);

function flattenValue(v, depth = 0) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(x => flattenValue(x, depth + 1)).filter(Boolean).join(', ');
    if (typeof v === 'object' && depth < 2) {
        return Object.entries(v).filter(([k]) => !SCENE_SKIP.has(k.toLowerCase()))
            .map(([k, x]) => { const t = flattenValue(x, depth + 1); return t ? `${k} ${t}` : ''; }).filter(Boolean).join('; ');
    }
    return '';
}

/**
 * The characters the scene tracker (the "present characters" bar) lists,
 * except the party, with what it says about each. Enemies the story has
 * already introduced are usually here.
 * @param {string[]} exclude - names to leave out (the fighters)
 * @returns {Array<{name: string, text: string}>}
 */
export function presentCharacters(exclude = []) {
    const raw = lastGeneratedData?.characterThoughts || committedTrackerData?.characterThoughts;
    if (!raw) return [];
    let list;
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        list = Array.isArray(parsed) ? parsed : (parsed?.characters || []);
    } catch (e) { return []; }
    if (!Array.isArray(list)) return [];
    const skip = new Set(exclude.map(n => String(n).toLowerCase()));
    const out = [];
    for (const c of list) {
        const name = typeof c?.name === 'string' ? c.name.trim() : '';
        if (!name || skip.has(name.toLowerCase())) continue;
        out.push({ name, text: flattenValue(Object.fromEntries(Object.entries(c).filter(([k]) => !SCENE_SKIP.has(k.toLowerCase())))).replace(/\s+/g, ' ') });
        if (out.length >= 12) break;
    }
    return out;
}

export function cardInfo() {
    try {
        const ctx = getContext();
        const ch = Array.isArray(ctx.characters) ? ctx.characters[ctx.characterId] : null;
        return { name: ctx.name2 || ch?.name || '', description: String(ch?.description || '') };
    } catch (e) {
        return { name: '', description: '' };
    }
}

function cleanText(v, max) {
    const t = String(v ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** The AI's enemy list → clean specs. */
export function normalizeEnemySpecs(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Map();
    const out = [];
    for (const e of list.slice(0, 6)) {
        if (!e || typeof e !== 'object') continue;
        let name = cleanText(e.name, 40);
        if (!name) continue;
        const n = (seen.get(name.toLowerCase()) || 0) + 1;
        seen.set(name.toLowerCase(), n);
        if (n > 1) name = `${name} ${n}`;
        const attacks = (Array.isArray(e.attacks) ? e.attacks : []).slice(0, 3).map(a => (typeof a === 'string' ? { name: a } : a)).filter(a => a && cleanText(a.name, 40));
        const loot = e.loot && typeof e.loot === 'object' ? {
            money: Number.isFinite(Number(e.loot.money)) ? Math.max(0, Number(e.loot.money)) : undefined,
            items: (Array.isArray(e.loot.items) ? e.loot.items : []).map(x => cleanText(typeof x === 'string' ? x : x?.name, 40)).filter(Boolean).slice(0, 2),
        } : undefined;
        out.push({
            name,
            icon: cleanText(e.icon, 8) || '👹',
            description: cleanText(e.description, 140),
            tier: M.TIERS.includes(String(e.tier).toLowerCase()) ? String(e.tier).toLowerCase() : 'normal',
            levelDelta: Number(e.levelDelta) || 0,
            focus: String(e.focus || '').toLowerCase(),
            attacks: attacks.map(a => ({ name: cleanText(a.name, 40), power: a.power, stat: a.stat, status: a.status, type: a.type, target: a.target, element: String(a.element || '').toLowerCase(), pierce: a.pierce === true })),
            affinities: M.normalizeAffinities(e.affinities || { weak: e.weak, resist: e.resist, immune: e.immune, absorb: e.absorb }),
            armored: e.armored === true || /^(true|yes)$/i.test(String(e.armored)),
            loot,
        });
    }
    // Encounter-wide limits: immune/absorb on one creature, armour on at most half the group.
    let rare = 0, armoured = 0;
    for (const e of out) {
        const cap = M.AFFINITY_CAPS[e.tier] || M.AFFINITY_CAPS.normal;
        const has = Object.values(e.affinities).some(l => l === 'immune' || l === 'absorb');
        if (has && (!cap.rare || rare >= 1)) e.affinities = Object.fromEntries(Object.entries(e.affinities).filter(([, l]) => l !== 'immune' && l !== 'absorb'));
        else if (has) rare++;
        if (e.armored && (!cap.armor || armoured >= Math.ceil(out.length / 2))) e.armored = false;
        else if (e.armored) armoured++;
    }
    return out;
}

/** Reads the AI's reply: { environment, enemies, profiles }, or throws. */
export function parseEncounterReply(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The AI did not return any JSON.');
    const data = repairJSON(m[0], { allowFunctionEval: false });
    if (!data || typeof data !== 'object') throw new Error('The AI reply could not be read.');
    return {
        environment: cleanText(data.environment, 160),
        enemies: normalizeEnemySpecs(data.enemies),
        profiles: data.profiles && typeof data.profiles === 'object' ? data.profiles : {},
    };
}

/**
 * Asks the AI for the enemies (and for labels on whatever has none yet).
 * The labels are saved in the chat; the fighters are rebuilt afterwards.
 * @param {Array<{name, isUser}>} party
 * @param {{situation?: string, generate?: Function, depth?: number}} [options]
 * @returns {Promise<{ environment: string, enemies: Array, labelled: number }>}
 */
/**
 * The fighters of a party, and the spells, skills and items among them that
 * have no combat profile yet (to be labelled by the AI in the same request).
 * @returns {{ members: Array, toLabel: Array, keyed: Map }}
 */
export function collectLabelRequests(party) {
    const members = party.map(p => ({ ...p, ...buildPartyMember(p.name, p.isUser) }));
    const toLabel = [];
    const keyed = new Map();
    for (const m of members) {
        for (const u of m.unlabelled) {
            const key = `a${toLabel.length + 1}`;
            keyed.set(key, u);
            toLabel.push({ key, owner: u.owner, kind: u.kind, name: u.ref, desc: u.desc, effects: u.effects, cost: u.cost });
        }
    }
    return { members, toLabel, keyed };
}

/** Saves the profiles the AI gave for the keys it was asked about. @returns {number} how many were kept */
export function applyLabelReplies(profiles, keyed) {
    let labelled = 0;
    for (const [key, raw] of Object.entries(profiles || {})) {
        const u = keyed.get(key);
        if (!u) continue;
        if (setStoredProfile(u.owner, u.kind, u.ref, raw)) labelled++;
    }
    return labelled;
}

export async function generateEncounterSetup(party, { situation = '', generate = safeGenerateRaw, depth = 8 } = {}) {
    const { members, toLabel, keyed } = collectLabelRequests(party);
    const card = cardInfo();
    const currency = getCurrency();
    const messages = buildEncounterSetupPrompt({
        player: getPersonaName() || 'the player',
        party: members.map(m => ({ name: m.combatant.name, isUser: m.combatant.isUser, level: m.combatant.level })),
        situation,
        cardName: card.name,
        cardDescription: card.description,
        messages: recentMessages(depth),
        present: presentCharacters([getPersonaName(), ...members.map(m => m.combatant.name)].filter(Boolean)),
        currency: currency ? currency.name : '',
        toLabel: toLabel.slice(0, 40),
    });
    const reply = await generate({ prompt: messages, quietToLoud: false });
    const parsed = parseEncounterReply(reply);
    const labelled = applyLabelReplies(parsed.profiles, keyed);
    return { environment: parsed.environment, enemies: parsed.enemies, labelled };
}

/** Fighters + enemies → a fight ready to start (not started). */
export function buildEncounter(party, enemySpecs, { environment = '', seed = Date.now(), tag = null } = {}) {
    const members = party.map(p => buildPartyMember(p.name, p.isUser).combatant);
    const partyLevel = members.length ? Math.max(1, Math.round(members.reduce((s, m) => s + m.level, 0) / members.length)) : 1;
    const enemies = enemySpecs.map((spec, i) => M.buildEnemy(spec, { partyLevel, partySize: members.length, id: `e${i + 1}` }));
    const state = M.createCombat({ combatants: [...members, ...enemies], seed, environment });
    state.partyLevel = partyLevel;
    // Marks a fight that belongs to something else (a dungeon room), so that one can find its result.
    if (tag) state.tag = tag;
    return state;
}

// ─── The fight in progress (kept in the chat) ───────────────────────────────

export function getLiveEncounter() {
    const s = chatStore('combatLive');
    const st = s?.state;
    return st && typeof st === 'object' && Array.isArray(st.combatants) ? st : null;
}

export function saveLiveEncounter(state) {
    const s = chatStore('combatLive', true);
    if (!s) return;
    s.state = state;
    saveChatScope();
}

export function clearLiveEncounter() {
    const s = chatStore('combatLive');
    if (s && s.state) { delete s.state; saveChatScope(); }
}

// ─── The last fight that belonged to something else ─────────────────────────

/** Kept so a dungeon can learn how its room's fight ended even after a reload. */
function recordLastEncounter(state, report) {
    const s = chatStore('combatLast', true);
    if (!s) return;
    s.last = {
        tag: state.tag,
        result: state.result,
        rounds: state.round,
        xp: report.xpGiven || 0,
        money: report.moneyAdded || 0,
        items: [...(report.lootAdded || [])],
        at: Date.now(),
    };
}

export function getLastEncounter() {
    const l = chatStore('combatLast')?.last;
    return l && typeof l === 'object' ? l : null;
}

// ─── Outcome ────────────────────────────────────────────────────────────────

function toast(kind, text) {
    try { window.toastr?.[kind]?.(text, 'Combat', { timeOut: 6000 }); } catch (e) { /* no toastr */ }
}

/**
 * Gives money and items to the player's character (the party's purse and pack).
 * @returns {{ money: number, items: string[] }} what was actually added
 */
export function grantSpoils({ money = 0, items = [] } = {}) {
    const out = { money: 0, items: [] };
    const persona = getPersonaName();
    if (!persona) return out;
    if (money > 0 && isMoneyEnabled()) {
        setMoney(persona, true, (getMoney(persona, true) || 0) + money);
        out.money = money;
    }
    if (items.length && isEquipmentEnabled()) {
        for (const name of items) {
            const have = getEquipment(persona, true).find(i => itemKey(i.name) === itemKey(name));
            const res = have ? updateItem(persona, true, have.id, { qty: (have.qty || 1) + 1 }) : addItem(persona, true, { name, desc: 'Taken from a fight.' });
            if (res && !res.error) out.items.push(name);
        }
    }
    return out;
}

/**
 * Writes the result of a finished fight into the chat's data. Safe to call
 * twice: the second call does nothing.
 * @returns {object} what was done, for the end screen
 */
export function applyOutcome(state) {
    const report = { result: state.result, rewards: M.computeRewards(state, { tierXp: getXpSettings().tiers, partyLevel: state.partyLevel || 1 }), party: [], lootAdded: [], moneyAdded: 0, xpGiven: 0, affinity: [] };
    if (state.applied) return { ...report, already: true };
    state.applied = true;

    const outcomes = M.partyOutcome(state);
    for (const o of outcomes) {
        const sheet = activeStats(getStatSheet(o.name, o.isUser));
        const row = { name: o.name, isUser: o.isUser, healthPct: o.healthPct, down: o.down };
        if (sheet.some(s => s.id === 'health')) setCurrentStatValue(o.name, o.isUser, 'health', o.healthPct, { persist: false });
        if (o.manaPct !== null && sheet.some(s => s.id === 'mana')) setCurrentStatValue(o.name, o.isUser, 'mana', o.manaPct, { persist: false });
        // Harmful statuses still running become conditions.
        if (isConditionsEnabled()) {
            for (const st of o.statuses) {
                const exists = getConditions(o.name, o.isUser).some(c => itemKey(c.name) === itemKey(st.name));
                if (!exists) addCondition(o.name, o.isUser, { icon: st.icon, name: st.name, desc: 'From the last fight.' });
            }
        }
        // Items used up (or left) go back to the inventory.
        if (isEquipmentEnabled()) {
            const c = state.combatants.find(x => x.id === o.id);
            for (const a of c?.actions || []) {
                if (a.kind !== 'item' || !a.itemId) continue;
                const have = getEquipment(o.name, o.isUser).find(i => i.id === a.itemId);
                if (have && have.qty !== a.qty) updateItem(o.name, o.isUser, a.itemId, { qty: a.qty });
            }
        }
        report.party.push(row);
    }

    if (state.result === 'victory') {
        const r = report.rewards;
        if (r.xp > 0 && isXpEnabled()) {
            awardPartyXp(r.xp, { reason: `Fight: ${r.defeated.map(d => d.name).join(', ')}`.slice(0, 80), source: 'ai' });
            report.xpGiven = r.xp;
        }
        const spoils = grantSpoils({ money: r.money, items: r.items });
        report.moneyAdded = spoils.money;
        report.lootAdded.push(...spoils.items);
    }
    const delta = state.result === 'victory' ? M.TUNING.affinityWin : state.result === 'fled' ? M.TUNING.affinityFlee : 0;
    if (delta) {
        for (const o of outcomes) {
            if (o.isUser) continue;
            const v = adjustAffinity(o.name, delta, state.result === 'victory' ? 'Fought side by side' : 'Retreated from a fight');
            if (v !== null) report.affinity.push({ name: o.name, delta });
        }
    }
    if (state.tag) recordLastEncounter(state, report);
    saveChatScope();
    notifyStatsChanged({ source: 'combat' });
    return report;
}

function sanitizeForSlash(text) {
    return String(text || '').replace(/\|/g, '¦').replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }').replace(/^\/+/, '').trim();
}

/**
 * Has the AI tell the story of the fight and posts it to the chat.
 * @returns {Promise<string>} the text posted, or '' if nothing was
 */
export async function narrateOutcome(state, report, { generate = safeGenerateRaw, post = true, depth = 8 } = {}) {
    const card = cardInfo();
    const summary = M.summarizeForNarration(state, report?.rewards);
    const messages = buildCombatNarrationPrompt({
        summary, player: getPersonaName() || 'the player', messages: recentMessages(depth),
        cardName: card.name, cardDescription: card.description,
    });
    const reply = await generate({ prompt: messages, quietToLoud: false });
    const text = sanitizeForSlash(String(reply || '').replace(/^\s*\[?FIGHT CONCLUDED\]?\s*/i, ''));
    if (!text) return '';
    if (post) {
        const speaker = (card.name || 'Narrator').replace(/"/g, '');
        await executeSlashCommandsOnChatInput(`/sendas name="${speaker}" ${text}`, { clearChatInput: false });
    }
    return text;
}

/**
 * Applies a finished fight and (if the setting is on) narrates it.
 * @returns {Promise<{report: object, narration: string, narrationError?: string}>}
 */
export async function finishEncounter(state, { narrate = isCombatNarrationOn(), generate = safeGenerateRaw, post = true } = {}) {
    const report = applyOutcome(state);
    clearLiveEncounter();
    let narration = '';
    let narrationError;
    if (narrate && !report.already) {
        try {
            narration = await narrateOutcome(state, report, { generate, post });
        } catch (e) {
            narrationError = e?.message || 'The story could not be written.';
            toast('warning', 'The fight is recorded, but the AI could not write the story of it.');
        }
    }
    return { report, narration, ...(narrationError ? { narrationError } : {}) };
}
