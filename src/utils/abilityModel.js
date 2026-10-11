/**
 * Spells & Abilities — pure model.
 *
 * What a character knows how to do: spells (magic) and abilities (skills,
 * techniques, talents). The AI adds them when a character learns one or is
 * shown using one, and removes the ones the user allows it to (aiCanRemove);
 * locked ones can only be removed by the user. A passive ability can carry
 * attribute effects (Iron skin: CON +2) that always apply.
 *
 * Shape: { id, icon, name, desc, type: 'spell'|'ability', effects,
 *          cost: null|'light'|'medium'|'heavy', aiCanRemove, source: 'ai'|'user', createdAt }
 *
 * Spells can cost Mana. The cost is a tier (light / medium / heavy) whose
 * amount the user sets (default 5 / 15 / 30 points of the Mana bar).
 */
import { cleanIcon, splitLeadingEmoji, itemKey, LOCK_MARK } from './equipmentModel.js';

export const ABILITY_NAME_MAX = 40;
export const ABILITY_DESC_MAX = 120;
export const DEFAULT_SPELL_ICON = '🔮';
export const DEFAULT_ABILITY_ICON = '⭐';
export const MAX_ABILITIES = 40;
export const ABILITY_TYPES = ['spell', 'ability'];
export const MANA_COSTS = ['light', 'medium', 'heavy'];
export const DEFAULT_MANA_TIERS = { light: 5, medium: 15, heavy: 30 };

const COST_WORDS = {
    light: 'light', low: 'light', minor: 'light', small: 'light', cheap: 'light', weak: 'light',
    medium: 'medium', moderate: 'medium', normal: 'medium', average: 'medium', mid: 'medium',
    heavy: 'heavy', high: 'heavy', major: 'heavy', large: 'heavy', strong: 'heavy', expensive: 'heavy', big: 'heavy',
};

/** The user's Mana amounts per tier (each 0–100). */
export function resolveManaTiers(custom) {
    const out = { ...DEFAULT_MANA_TIERS };
    if (custom && typeof custom === 'object') {
        for (const t of MANA_COSTS) {
            const n = Math.round(Number(custom[t]));
            if (Number.isFinite(n) && n >= 0) out[t] = Math.min(n, 100);
        }
    }
    return out;
}

/** "medium" / "high" / 12 → a tier, or null ("none", "free", nonsense). */
export function normalizeManaCost(value, tiers = DEFAULT_MANA_TIERS) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' || (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value))) {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return null;
        let best = null;
        for (const t of MANA_COSTS) if (!best || Math.abs(tiers[t] - n) < Math.abs(tiers[best] - n)) best = t;
        return best;
    }
    const words = String(value).toLowerCase().match(/[a-z]+/g) || [];
    for (const w of words) if (COST_WORDS[w]) return COST_WORDS[w];
    return null;
}

/** Emoji offered in the panel's quick picker. */
export const ABILITY_EMOJI = [
    '🔥', '❄️', '⚡', '💧', '🌪️', '🌿', '🪨', '☀️', '🌙', '✨', '💫', '🔮',
    '🛡️', '💚', '🩹', '☠️', '👁️', '🧠', '🌀', '🕯️', '🗡️', '🏹', '👊', '🦶',
    '🤸', '🥷', '🗣️', '🎭', '🎵', '📖', '🔍', '🐾', '🐺', '🦅', '⛓️', '⭐',
];

let idCounter = 0;
function newAbilityId() {
    idCounter = (idCounter + 1) % 1000;
    return 'abl_' + Date.now().toString(36) + '_' + idCounter.toString(36) + Math.random().toString(36).slice(2, 5);
}

function clip(text, max) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** "spell" / "magic" / "incantesimo" → 'spell'; everything else 'ability'. */
export function normalizeAbilityType(t) {
    const s = String(t ?? '').toLowerCase();
    return /spell|magic|cantrip|incant|ritual|hex|curse|prayer|miracle/.test(s) ? 'spell' : 'ability';
}

export function findAbility(list, name) {
    const k = itemKey(splitLeadingEmoji(name).name);
    if (!k) return null;
    return (list || []).find(a => itemKey(a.name) === k) || null;
}

/** Builds an entry, or null without a name. `effects` is a { statId: n } map. */
export function makeAbility({ icon, name, desc, type, effects = {}, cost = null, aiCanRemove = true, source = 'user' } = {}) {
    const split = splitLeadingEmoji(name);
    const n = clip(split.name, ABILITY_NAME_MAX);
    if (!n) return null;
    const kind = ABILITY_TYPES.includes(type) ? type : normalizeAbilityType(type);
    const ic = cleanIcon(String(icon ?? '').trim() ? icon : split.icon);
    return {
        id: newAbilityId(),
        icon: ic === '📦' ? (kind === 'spell' ? DEFAULT_SPELL_ICON : DEFAULT_ABILITY_ICON) : ic,
        name: n,
        desc: clip(desc, ABILITY_DESC_MAX),
        type: kind,
        effects: effects && typeof effects === 'object' && !Array.isArray(effects) ? { ...effects } : {},
        // Only spells cost Mana.
        cost: kind === 'spell' ? normalizeManaCost(cost) : null,
        aiCanRemove: aiCanRemove !== false,
        source,
        createdAt: Date.now(),
    };
}

/**
 * Normalises the AI's "abilities" value into [{ name, add: [...], remove: [names] }].
 * Same shapes as equipment: { "Name": { "add": [...], "remove": [...] } },
 * { "Name": [...] } (a list → added) and [{ "name": "Name", ... }].
 */
export function normalizeAIAbilities(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    const toAdd = (fromList) => (v) => {
        if (typeof v === 'string') return { name: v, fromList };
        if (v && typeof v === 'object') return {
            icon: v.icon ?? v.emoji,
            name: v.name ?? v.spell ?? v.ability ?? v.skill ?? v.title,
            desc: v.desc ?? v.description ?? v.note,
            type: v.type ?? v.kind ?? v.category,
            effects: v.effects ?? v.bonus ?? v.modifiers ?? v.passive,
            cost: v.cost ?? v.mana ?? v.manaCost ?? v.mp,
            fromList,
        };
        return null;
    };
    const toName = (v) => {
        const r = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.name ?? v.spell ?? v.ability) : null);
        return typeof r === 'string' && r.trim() ? splitLeadingEmoji(r).name : null;
    };
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
    const out = [];
    const push = (name, val) => {
        if (typeof name !== 'string' || !name.trim() || !val || typeof val !== 'object') return;
        if (Array.isArray(val)) val = { list: val };
        const add = [
            ...arr(val.add ?? val.added ?? val.learn ?? val.learned ?? val.gain).map(toAdd(false)),
            ...arr(val.list ?? val.spells ?? val.abilities ?? val.skills ?? val.known).map(toAdd(true)),
        ].filter(a => a && typeof a.name === 'string' && a.name.trim());
        const remove = arr(val.remove ?? val.removed ?? val.forget ?? val.forgot ?? val.lose ?? val.lost).map(toName).filter(Boolean);
        if (add.length || remove.length) out.push({ name: name.trim(), add, remove });
    };
    if (Array.isArray(data)) {
        for (const a of data) if (a && typeof a === 'object') push(a.name, a);
        return out;
    }
    for (const [name, val] of Object.entries(data)) push(name, val);
    return out;
}

/**
 * Applies one character's AI change to a COPY of their list.
 * @returns {{ list: object[], added: number, removed: number, blocked: object[] }}
 */
export function applyAbilityChange(list, change, resolveEffects = () => ({})) {
    const next = (Array.isArray(list) ? list : []).map(a => ({ ...a, effects: { ...(a.effects || {}) } }));
    const res = { list: next, added: 0, removed: 0, blocked: [] };
    for (const n of change.remove || []) {
        const a = findAbility(next, n);
        if (!a) continue;
        if (a.aiCanRemove === false) { res.blocked.push(a); continue; }
        next.splice(next.indexOf(a), 1);
        res.removed++;
    }
    for (const a of change.add || []) {
        if (findAbility(next, a.name)) continue;
        if (next.length >= MAX_ABILITIES) break;
        const entry = makeAbility({
            icon: a.icon, name: a.name, desc: a.desc, type: a.type,
            effects: a.effects === undefined || a.effects === null ? {} : resolveEffects(a.effects),
            cost: a.cost,
            source: 'ai', aiCanRemove: true,
        });
        if (!entry || !itemKey(entry.name)) continue;
        next.push(entry);
        res.added++;
    }
    return res;
}

/** Passive effects as modifier sources (they always apply). */
export function abilityModifierSources(list) {
    return (list || [])
        .filter(a => a && a.effects && Object.keys(a.effects).length)
        .map(a => ({ label: a.name, effects: a.effects }));
}

/** "spells: 🔥 Fireball; abilities: 🔒🛡️ Iron skin (CON +2)" */
export function formatAbilities(list, formatEffect = null, { icons = true, manaTiers = null } = {}) {
    const fmt = (arr) => arr.map(a => {
        const eff = formatEffect && a.effects && Object.keys(a.effects).length ? formatEffect(a.effects) : '';
        // Mana cost, only when the Mana bar is in use (manaTiers given).
        const cost = manaTiers && a.type === 'spell' && MANA_COSTS.includes(a.cost) ? `Mana ${manaTiers[a.cost]}` : '';
        const extra = [cost, eff].filter(Boolean).join('; ');
        return `${a.aiCanRemove === false ? LOCK_MARK : ''}${icons ? `${a.icon} ` : ''}${a.name}${extra ? ` (${extra})` : ''}`;
    }).join(', ');
    const spells = (list || []).filter(a => a.type === 'spell');
    const skills = (list || []).filter(a => a.type !== 'spell');
    const parts = [];
    if (spells.length) parts.push(`spells: ${fmt(spells)}`);
    if (skills.length) parts.push(`abilities: ${fmt(skills)}`);
    return parts.join('; ');
}

/**
 * The prompt section for the characters in the scene.
 * @param {Array<{name: string, isUser: boolean, abilities: object[], needsSeed?: boolean, formatEffect?: Function}>} entries
 */
export function buildAbilitiesPrompt(entries, { compact = true, standalone = false, manaTiers = null } = {}) {
    const list = (entries || []).filter(e => e && e.name);
    if (!list.length) return '';
    const lines = list.map(e => `- ${e.name}${e.isUser ? ' (player character)' : ''}: ${e.abilities.length ? formatAbilities(e.abilities, e.formatEffect, { icons: !compact, manaTiers }) : 'nothing listed yet'}`);
    const spellCost = manaTiers ? { cost: 'medium' } : {};
    const seed = list.filter(e => e.needsSeed).map(e => e.name);
    const player = list.find(e => e.isUser)?.name;
    const example = JSON.stringify({ abilities: { [list[0].name]: compact
        ? { add: [{ icon: '🔥', name: 'Fireball', desc: 'Burst of flame', type: 'spell', ...spellCost }], remove: ['Old trick'] }
        : {
            add: [{ icon: '🔥', name: 'Fireball', desc: 'Hurls a burst of flame', type: 'spell', ...spellCost }, { icon: '🛡️', name: 'Iron skin', desc: 'Shrugs off blows', type: 'ability', effects: { CON: 1 } }],
            remove: ['Forgotten trick'],
        } } });
    const where = standalone ? 'start your reply with ONE JSON code block' : 'add an "abilities" key to the same tracker JSON object';
    let out = compact
        ? 'SPELLS & ABILITIES (what each knows how to do):\n'
        : 'SPELLS & ABILITIES — what each character knows how to do:\n';
    out += lines.join('\n') + '\n';
    const playerNote = player
        ? (compact ? `, including any ${player} uses in the user's message` : `. This includes any spell or ability ${player} uses in the user's message, even if it was never mentioned before`)
        : '';
    out += compact
        ? `When someone learns, truly loses, or is shown using a spell or ability not listed${playerNote}, ${where}: ${example} — one emoji, short name, desc under 8 words, "type" spell or ability; "effects" (e.g. {"CON": 1}) only for passive attribute bonuses. Never remove ${LOCK_MARK}. Omit the key when nothing changes.`
        : `ABILITY CHANGES: when a character learns a spell or ability, or the story shows them using one that is not listed yet${playerNote}, or when they truly lose one (forgotten, sealed, taken away), ${where}, like ${example}. Each entry has one emoji, a short name, a description under 8 words and "type": "spell" for magic or "ability" for skills, techniques and talents. Add "effects" only for passive abilities that genuinely raise or lower an attribute (e.g. {"CON": 1}); DES applies them automatically, so never change attributes yourself because of them. Entries marked ${LOCK_MARK} are fixed by the user and must never be removed. Leave the key out entirely when nothing changes.`;
    if (manaTiers) {
        const t = manaTiers;
        out += compact
            ? `\nSpells cost Mana: give new spells "cost" light (${t.light}), medium (${t.medium}) or heavy (${t.heavy}). Casting one lowers the caster's Mana in "stats" by its cost; nobody can cast with less Mana than that. Spells listed without a cost are free.`
            : `\nMANA: spells cost Mana. Give every new spell a "cost" — "light" (${t.light} Mana), "medium" (${t.medium}) or "heavy" (${t.heavy}) — fitting how powerful it is. When a character casts a spell, lower their Mana in "stats" by its cost; a character with less Mana than the cost cannot cast it (the attempt fails or they are too drained). Spells listed without a cost are free.`;
    }
    if (seed.length) {
        out += compact
            ? `\nSTARTING ABILITIES: add the spells and abilities ${seed.join(', ')} already ${seed.length === 1 ? 'knows' : 'know'}, from their description and the scene (a few key ones).`
            : `\nSTARTING ABILITIES: ${seed.join(', ')} ${seed.length === 1 ? 'has' : 'have'} no spells or abilities listed yet. Add the ones they already know, based on their character description (or persona description) and the scene — a few key ones, not every minor skill.`;
    }
    return out.trim();
}
