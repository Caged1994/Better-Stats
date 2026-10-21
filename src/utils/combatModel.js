/**
 * Combat — pure model.
 *
 * Turn-based fights where the numbers come from the extension, not from the
 * AI: hit chance, damage, defence, healing, statuses, initiative, enemy
 * behaviour, flight and rewards are all computed here from the characters'
 * attributes, equipment and skills. The AI only invents the enemies, labels
 * skills the first time (see "profiles") and tells the story afterwards.
 *
 * No SillyTavern imports: plain data in, plain data out, so it can be tested
 * outside the browser. Randomness comes from state.rng (a number that
 * advances with every roll), so a fight is reproducible and can be saved and
 * resumed. Storage, UI and prompts live elsewhere.
 *
 * Shapes
 *   profile   what an action does:
 *             { type: 'damage'|'heal'|'status'|'mana'|'cure'|'revive'|'gear'|'none',
 *               power: 'light'|'medium'|'heavy',
 *               stat:  attribute id the effect scales with ('none' for flat effects),
 *               target:'enemy'|'enemies'|'ally'|'allies'|'self',
 *               status: a STATUSES id applied by the action (optional),
 *               atk, def: bonuses of a piece of gear (type 'gear') }
 *   action    { id, label, icon, kind: 'basic'|'spell'|'ability'|'item',
 *               profile, manaCost (points of the Mana bar), cooldown (turns),
 *               qty (items) }
 *   combatant { id, name, side: 'party'|'enemy', isUser, icon, level, attrs,
 *               maxHp, hp, mana (0–100, null when Mana is not tracked),
 *               armor, atkBonus, actions, statuses, cooldowns, guard, down, … }
 */

// ─── Tuning ─────────────────────────────────────────────────────────────────

export const TUNING = {
    hpBase: 30, hpPerCon: 4, hpPerLevel: 5,
    hitBase: 0.75, hitPerDex: 0.015, hitMin: 0.10, hitMax: 0.95, spellAccuracy: 0.10,
    critChance: 0.05, critMult: 1.5,
    dmgBase: 5, dmgPerAttr: 1.2,
    varMin: 0.85, varMax: 1.15,
    defPerCon: 0.5, defK: 20, magicArmorShare: 0.5,
    aoeMult: 0.65,
    powerMult: { light: 1, medium: 1.5, heavy: 2.2 },
    healBase: 5, healPerAttr: 1.0, healMult: 1.5,
    itemHealPct: { light: 0.25, medium: 0.45, heavy: 0.7 },
    itemMana: { light: 15, medium: 30, heavy: 50 },
    itemBomb: { light: 12, medium: 22, heavy: 38 },
    revivePct: { light: 0.2, medium: 0.35, heavy: 0.5 },
    cooldown: { light: 0, medium: 1, heavy: 3 },
    statusChance: 0.6,
    statusTurns: 3,
    dotPct: { burn: 0.07, poison: 0.06, bleed: 0.05 },
    regenPct: 0.06,
    weakenMult: 0.75, empowerMult: 1.3,
    vulnerableMult: 1.25, shieldMult: 0.6, guardMult: 0.5,
    fleeBase: 0.5, fleePerDex: 0.02, fleeMin: 0.2, fleeMax: 0.9, fleeBossPenalty: 0.3,
    // Enemy strength by category: attribute scale, hit points scale, XP tier, money.
    tiers: {
        minion: { attr: 0.8, hp: 0.5, xp: 'small', money: 3, moneyCap: 20, label: 'Minion' },
        normal: { attr: 0.95, hp: 1.0, xp: 'medium', money: 8, moneyCap: 60, label: 'Normal' },
        elite: { attr: 1.15, hp: 1.9, xp: 'large', money: 25, moneyCap: 200, label: 'Elite' },
        boss: { attr: 1.4, hp: 3.2, xp: 'epic', money: 80, moneyCap: 800, label: 'Boss' },
    },
    // Each party member after the first adds this much to enemy hit points.
    hpPerExtraHero: 0.45,
    weakMult: 1.5, resistMult: 0.5, absorbPct: 0.5,
    affinityWin: 3, affinityFlee: -2,
    maxLog: 300,
};

export const POWERS = ['light', 'medium', 'heavy'];
export const TIERS = Object.keys(TUNING.tiers);
export const ATTRIBUTE_IDS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const PHYSICAL = new Set(['str', 'dex', 'con']);
export const TARGETS = ['enemy', 'enemies', 'ally', 'allies', 'self'];
export const PROFILE_TYPES = ['damage', 'heal', 'status', 'mana', 'cure', 'revive', 'gear', 'none'];

/** The statuses a fight knows. `bad` ones are harmful and cured by 'cure'. */
export const STATUSES = {
    burn: { icon: '🔥', name: 'Burning', bad: true, dot: true },
    poison: { icon: '☠️', name: 'Poisoned', bad: true, dot: true },
    bleed: { icon: '🩸', name: 'Bleeding', bad: true, dot: true },
    stun: { icon: '💫', name: 'Stunned', bad: true },
    weaken: { icon: '⬇️', name: 'Weakened', bad: true },
    vulnerable: { icon: '🎯', name: 'Vulnerable', bad: true },
    shield: { icon: '🛡️', name: 'Shielded', bad: false },
    empower: { icon: '⬆️', name: 'Empowered', bad: false },
    regen: { icon: '💚', name: 'Regenerating', bad: false },
};
export const STATUS_IDS = Object.keys(STATUSES);
/** What a hand-set status may last (turns of the one who carries it) and its lowest chance. */
export const MAX_STATUS_TURNS = 5;
export const MIN_STATUS_CHANCE = 0.1;

/** The elements. A move or weapon may carry one; creatures and armour answer to them. */
export const ELEMENTS = {
    fire: { icon: '🔥', name: 'Fire' },
    water: { icon: '💧', name: 'Water' },
    ice: { icon: '❄️', name: 'Ice' },
    lightning: { icon: '⚡', name: 'Lightning' },
    earth: { icon: '🪨', name: 'Earth' },
    dark: { icon: '🌑', name: 'Dark' },
    holy: { icon: '✨', name: 'Holy' },
};
export const ELEMENT_IDS = Object.keys(ELEMENTS);
/** How a creature (or armour) answers to an element. Weak/resist are common; immune/absorb are rare. */
export const AFFINITIES = {
    weak: { name: 'Weak', icon: '⚠️', rank: -1 },
    resist: { name: 'Resists', icon: '🛡️', rank: 1 },
    immune: { name: 'Immune', icon: '🚫', rank: 2 },
    absorb: { name: 'Absorbs', icon: '💚', rank: 3 },
};
export const AFFINITY_IDS = Object.keys(AFFINITIES);
/** What an enemy may carry, by category: [weak+resist each, immune+absorb together, may be armoured]. */
export const AFFINITY_CAPS = {
    minion: { common: 1, rare: 0, armor: false },
    normal: { common: 2, rare: 0, armor: true },
    elite: { common: 2, rare: 1, armor: true },
    boss: { common: 2, rare: 1, armor: true },
};

/** How much each enemy category counts towards how dangerous a fight is. */
export const THREAT = { minion: 1, normal: 2, elite: 4, boss: 8 };

/**
 * How hard a fight is likely to be for a party, from the enemy categories
 * and the number of fighters (calibrated against simulated fights).
 * @returns {{ id: 'easy'|'fair'|'hard'|'deadly', label: string, ratio: number }}
 */
export function threatRating(tiers, partySize) {
    const threat = (tiers || []).reduce((sum, t) => sum + (THREAT[t] ?? THREAT.normal), 0);
    const ratio = threat / (Math.max(1, partySize) * 2.2);
    const id = ratio < 0.7 ? 'easy' : ratio < 1.2 ? 'fair' : ratio < 1.8 ? 'hard' : 'deadly';
    return { id, label: { easy: 'Easy', fair: 'Fair', hard: 'Hard', deadly: 'Deadly' }[id], ratio };
}

// ─── Small helpers ──────────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Next random number in [0, 1) — mulberry32 on state.rng. */
export function nextRandom(state) {
    state.rng = (state.rng + 0x6D2B79F5) >>> 0;
    let t = state.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function attrValue(c, id) {
    const v = c?.attrs?.[id];
    return isNum(v) ? v : 10;
}

export function maxHpFor(con, level) {
    return Math.max(10, Math.round(TUNING.hpBase + (isNum(con) ? con : 10) * TUNING.hpPerCon + (level || 1) * TUNING.hpPerLevel));
}

function powerOf(profile) {
    return POWERS.includes(profile?.power) ? profile.power : 'light';
}

export function hasStatus(c, id) {
    return (c.statuses || []).some(s => s.id === id);
}

// ─── Profiles: what an action does ──────────────────────────────────────────

/** Cleans a profile (from the AI or the user); null when unusable. */
export function normalizeProfile(raw, attributeIds = ATTRIBUTE_IDS) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type ?? raw.kind ?? '').toLowerCase().trim();
    const t = PROFILE_TYPES.includes(type) ? type : (type === 'attack' ? 'damage' : type === 'buff' || type === 'debuff' ? 'status' : null);
    if (!t) return null;
    const power = POWERS.includes(String(raw.power).toLowerCase()) ? String(raw.power).toLowerCase() : 'light';
    const statRaw = String(raw.stat ?? raw.attribute ?? '').toLowerCase().trim();
    const wantsStat = t === 'damage' || t === 'heal';
    const stat = statRaw === 'none' ? 'none'
        : (attributeIds.includes(statRaw) ? statRaw : (wantsStat ? 'str' : 'none'));
    let target = String(raw.target ?? '').toLowerCase().trim();
    if (!TARGETS.includes(target)) target = t === 'damage' || (t === 'status' && STATUSES[raw.status]?.bad) ? 'enemy' : (t === 'heal' || t === 'mana' || t === 'cure' || t === 'revive' ? 'ally' : 'self');
    const status = STATUS_IDS.includes(String(raw.status ?? '').toLowerCase()) ? String(raw.status).toLowerCase() : undefined;
    const out = { type: t, power, stat, target };
    if (status) out.status = status;
    if (status) {
        // How long the status lasts, and (for a damaging move) how likely it is to land.
        const turns = Math.round(Number(raw.statusTurns));
        if (Number.isFinite(turns) && turns >= 1) out.statusTurns = clamp(turns, 1, MAX_STATUS_TURNS);
        const chance = Number(raw.statusChance);
        if (t === 'damage' && Number.isFinite(chance) && chance > 0) out.statusChance = clamp(Math.round((chance > 1 ? chance / 100 : chance) * 20) / 20, MIN_STATUS_CHANCE, 1);
    }
    if (t === 'status' && !status) return null;
    const element = String(raw.element ?? '').toLowerCase().trim();
    if (ELEMENT_IDS.includes(element) && (t === 'damage' || t === 'gear')) out.element = element;
    if (raw.pierce === true && (t === 'damage' || t === 'gear')) out.pierce = true;
    if (t === 'gear') {
        out.atk = clamp(Math.round(Number(raw.atk) || 0), 0, 15);
        out.def = clamp(Math.round(Number(raw.def) || 0), 0, 15);
        const aff = normalizeAffinities(raw.affinities);
        if (Object.keys(aff).length) out.affinities = aff;
    }
    return out;
}

/**
 * Cleans an affinity table. Accepts { fire: 'weak', … } or { weak: ['fire'], resist: […], … }.
 * @returns {Object<string,string>} element → 'weak'|'resist'|'immune'|'absorb' (the stronger wins on a clash)
 */
export function normalizeAffinities(raw) {
    const out = {};
    const put = (el, lvl) => {
        const e = String(el ?? '').toLowerCase().trim();
        const l = String(lvl ?? '').toLowerCase().trim();
        if (!ELEMENT_IDS.includes(e) || !AFFINITY_IDS.includes(l)) return;
        if (!out[e] || AFFINITIES[l].rank > AFFINITIES[out[e]].rank) out[e] = l;
    };
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
        if (Array.isArray(v)) v.forEach(el => put(typeof el === 'string' ? el : el?.element, k));
        else put(k, v);
    }
    return out;
}

/** Puts two affinity tables together (armour on top of a creature): a resistance cancels a weakness. */
export function mergeAffinities(a, b) {
    const out = { ...(a || {}) };
    for (const [el, lvl] of Object.entries(b || {})) {
        const cur = out[el];
        if (!cur) out[el] = lvl;
        else if (cur === 'weak' && lvl === 'resist') delete out[el];
        else if (cur === 'resist' && lvl === 'weak') delete out[el];
        else if (AFFINITIES[lvl].rank > AFFINITIES[cur].rank) out[el] = lvl;
    }
    return out;
}

const KEYWORDS = [
    { re: /\b(heal|cure|bandage|medkit|first aid|potion of heal|health potion|healing|cura|guarisc|guarigione|benda|pozione di cura|medikit|pronto soccorso)/i, p: { type: 'heal', stat: 'wis', target: 'ally' } },
    { re: /\b(revive|resurrect|phoenix|rianima|resuscita)/i, p: { type: 'revive', stat: 'none', target: 'ally' } },
    { re: /\b(antidote|remedy|purify|cleanse|antidoto|purifica)/i, p: { type: 'cure', stat: 'none', target: 'ally' } },
    { re: /\b(mana|ether|elixir of mana|energy drink|eter)/i, p: { type: 'mana', stat: 'none', target: 'ally' } },
    { re: /\b(shield|barrier|protect|ward|guard up|scudo|barriera|proteggi)/i, p: { type: 'status', status: 'shield', stat: 'none', target: 'ally' } },
    { re: /\b(haste|rage|bless|empower|inspire|furia|benedi|potenzia|ispira)/i, p: { type: 'status', status: 'empower', stat: 'none', target: 'ally' } },
    { re: /\b(stun|paralyz|freeze|sleep|stordi|paralizz|congela|addorment)/i, p: { type: 'status', status: 'stun', stat: 'none', target: 'enemy' } },
    { re: /\b(weaken|curse|hex|debilit|maledi)/i, p: { type: 'status', status: 'weaken', stat: 'none', target: 'enemy' } },
    { re: /\b(poison|venom|veleno|velen)/i, p: { type: 'damage', status: 'poison', stat: 'dex', target: 'enemy' } },
    { re: /\b(fire|flame|burn|inferno|blaze|explosion|fuoco|fiamma|brucia|esplosion)/i, p: { type: 'damage', status: 'burn', stat: 'int', target: 'enemy' } },
    { re: /\b(bleed|slash|rend|sanguin|taglio|squarcia)/i, p: { type: 'damage', status: 'bleed', stat: 'str', target: 'enemy' } },
    { re: /\b(lightning|thunder|bolt|ice|frost|storm|magic|arcane|spell|fulmine|tuono|ghiaccio|tempesta|magia|arcano|incantesimo)/i, p: { type: 'damage', stat: 'int', target: 'enemy' } },
    { re: /\b(bomb|grenade|dynamite|molotov|bomba|granata|dinamite)/i, p: { type: 'damage', stat: 'none', target: 'enemy' } },
    { re: /\b(sword|blade|dagger|knife|axe|mace|hammer|spear|bow|crossbow|gun|pistol|rifle|club|staff|spada|lama|pugnale|coltello|ascia|mazza|martello|lancia|arco|balestra|pistola|fucile|bastone)/i, p: { type: 'gear', atk: 4, def: 0, stat: 'none', target: 'self' } },
    { re: /\b(armor|armour|helmet|vest|shield|cuirass|plate|mail|jacket|armatura|elmo|giubbotto|corazza|cotta|giacca)/i, p: { type: 'gear', atk: 0, def: 4, stat: 'none', target: 'self' } },
];

/**
 * A best guess from the name and description, for when the AI has not
 * labelled the action (or is not reachable). `kind` is 'spell', 'ability' or
 * 'item'; `effects` the item's attribute bonuses ({ str: 2 }).
 */
export function guessProfile(kind, name, desc = '', { cost = null, effects = null } = {}) {
    const text = `${name || ''} ${desc || ''}`;
    for (const { re, p } of KEYWORDS) {
        if (!re.test(text)) continue;
        if (kind === 'item' && (p.type === 'gear')) continue; // gear is decided below
        if (kind !== 'item' && p.type === 'gear') continue;
        return normalizeProfile({ ...p, power: cost && POWERS.includes(cost) ? cost : 'medium' });
    }
    if (kind === 'item') {
        for (const { re, p } of KEYWORDS) {
            if (p.type === 'gear' && re.test(text)) return normalizeProfile(p);
        }
        const atk = (effects?.str > 0 ? effects.str : 0) + (effects?.dex > 0 ? effects.dex : 0);
        const def = effects?.con > 0 ? effects.con : 0;
        if (atk || def) return normalizeProfile({ type: 'gear', atk: Math.min(atk * 2, 15), def: Math.min(def * 2, 15) });
        return normalizeProfile({ type: 'none' });
    }
    // A skill that only gives always-on bonuses ("CON +2") is passive, not an attack.
    if (kind === 'ability' && effects && Object.keys(effects).length) return normalizeProfile({ type: 'none' });
    if (kind === 'spell') return normalizeProfile({ type: 'damage', stat: 'int', target: 'enemy', power: cost && POWERS.includes(cost) ? cost : 'medium' });
    return normalizeProfile({ type: 'damage', stat: 'str', target: 'enemy', power: 'medium' });
}

/** Whether an item can be used during a fight (consumed or thrown). */
export function isUsableItemProfile(p) {
    return !!p && ['damage', 'heal', 'status', 'mana', 'cure', 'revive'].includes(p.type);
}

// ─── Combatants ─────────────────────────────────────────────────────────────

/** The attack everybody has. */
export function basicAttack(c) {
    const stat = attrValue(c, 'dex') > attrValue(c, 'str') ? 'dex' : 'str';
    const profile = { type: 'damage', power: 'light', stat, target: 'enemy' };
    if (c.atkElement) profile.element = c.atkElement;
    if (c.atkPierce) profile.pierce = true;
    return { id: 'basic', label: 'Attack', icon: '⚔️', kind: 'basic', profile, manaCost: 0, cooldown: 0 };
}

/**
 * Builds a combatant. `healthPct` (0–100) starts them partly wounded;
 * `mana` is a percentage or null when the Mana bar is off.
 */
export function makeCombatant(spec) {
    const attrs = { ...(spec.attrs || {}) };
    for (const id of ATTRIBUTE_IDS) if (!isNum(attrs[id])) attrs[id] = 10;
    const level = Math.max(1, Math.round(spec.level || 1));
    const maxHp = isNum(spec.maxHp) ? Math.max(1, Math.round(spec.maxHp)) : maxHpFor(attrs.con, level);
    let hp = maxHp;
    if (isNum(spec.hp)) hp = clamp(Math.round(spec.hp), 0, maxHp);
    else if (isNum(spec.healthPct)) hp = clamp(Math.round(maxHp * spec.healthPct / 100), 1, maxHp);
    const c = {
        id: spec.id,
        name: String(spec.name || 'Unknown'),
        side: spec.side === 'enemy' ? 'enemy' : 'party',
        isUser: !!spec.isUser,
        icon: spec.icon || (spec.side === 'enemy' ? '👹' : '🙂'),
        level, attrs, maxHp, hp,
        mana: isNum(spec.mana) ? clamp(Math.round(spec.mana), 0, 100) : null,
        armor: Math.max(0, Math.round(spec.armor || 0)),
        atkBonus: Math.max(0, Math.round(spec.atkBonus || 0)),
        actions: [],
        statuses: [],
        cooldowns: {},
        guard: false,
        down: hp <= 0,
        stunImmune: 0,
        affinities: normalizeAffinities(spec.affinities),
        armored: !!spec.armored,
    };
    if (ELEMENT_IDS.includes(spec.atkElement)) c.atkElement = spec.atkElement;
    if (spec.atkPierce) c.atkPierce = true;
    if (spec.tier) c.tier = spec.tier;
    if (spec.description) c.description = String(spec.description);
    if (spec.loot) c.loot = spec.loot;
    const extra = Array.isArray(spec.actions) ? spec.actions : [];
    c.actions = [basicAttack(c), ...extra.filter(a => a && a.id && a.id !== 'basic')];
    return c;
}

/**
 * The affinities an enemy may keep. The AI suggests; the category limits how many
 * (common: weak and resist, up to two of each; rare: immune or absorb, one, elite and boss only).
 */
export function capAffinities(spec, tierId) {
    const caps = AFFINITY_CAPS[tierId] || AFFINITY_CAPS.normal;
    const given = normalizeAffinities(spec.affinities || {
        weak: spec.weak, resist: spec.resist, immune: spec.immune, absorb: spec.absorb,
    });
    const out = {};
    let weak = 0, resist = 0, rare = 0;
    // Rare ones first (they matter most), then weaknesses, then resistances.
    const order = ['immune', 'absorb', 'weak', 'resist'];
    for (const lvl of order) {
        for (const [el, l] of Object.entries(given)) {
            if (l !== lvl) continue;
            if (lvl === 'weak') { if (weak >= caps.common) continue; weak++; }
            else if (lvl === 'resist') { if (resist >= caps.common) continue; resist++; }
            else { if (rare >= caps.rare) continue; rare++; }
            out[el] = lvl;
        }
    }
    return out;
}

/**
 * Builds an enemy from the AI's description. The AI picks the category and
 * what the enemy can do; the numbers come from the category and the party's
 * level, so it cannot unbalance the fight.
 * spec: { name, description, icon, tier, levelDelta, focus, attacks: [{ name, power, stat, status, target, type }], loot }
 */
export function buildEnemy(spec, { partyLevel = 1, partySize = 1, id }) {
    const tierId = TIERS.includes(String(spec.tier).toLowerCase()) ? String(spec.tier).toLowerCase() : 'normal';
    const tier = TUNING.tiers[tierId];
    const delta = clamp(Math.round(Number(spec.levelDelta) || 0), -2, 3);
    const level = Math.max(1, partyLevel + delta);
    const base = (8 + level * 1.2) * tier.attr;
    const attrs = {};
    for (const a of ATTRIBUTE_IDS) attrs[a] = Math.round(base);
    const focus = ATTRIBUTE_IDS.includes(String(spec.focus).toLowerCase()) ? String(spec.focus).toLowerCase() : null;
    if (focus) attrs[focus] = Math.round(base * 1.25);
    const maxHp = Math.max(8, Math.round(maxHpFor(attrs.con, level) * tier.hp * (1 + TUNING.hpPerExtraHero * Math.max(0, partySize - 1))));
    const primary = focus || 'str';
    const actions = [];
    (Array.isArray(spec.attacks) ? spec.attacks : []).slice(0, 3).forEach((a, i) => {
        const prof = normalizeProfile({
            type: a.type || 'damage',
            power: a.power || 'medium',
            stat: a.stat || primary,
            target: a.target,
            status: a.status,
            element: a.element,
            pierce: a.pierce === true,
        });
        if (!prof || prof.type === 'gear' || prof.type === 'none') return;
        actions.push({
            id: `atk${i}`, label: String(a.name || `Attack ${i + 1}`).slice(0, 40), icon: a.icon || '💥', kind: 'ability',
            profile: prof, manaCost: 0, cooldown: TUNING.cooldown[prof.power],
        });
    });
    const c = makeCombatant({
        id, side: 'enemy', name: spec.name, icon: spec.icon || '👹', level, attrs, maxHp,
        tier: tierId, description: spec.description, loot: spec.loot, actions,
        affinities: capAffinities(spec, tierId), armored: !!spec.armored && AFFINITY_CAPS[tierId].armor,
    });
    return c;
}

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * A new fight. `combatants` is the party and the enemies; `seed` makes it
 * reproducible. Call startCombat() to roll initiative and begin.
 */
export function createCombat({ combatants, seed = Date.now(), environment = '', title = '' } = {}) {
    return {
        v: 1,
        phase: 'setup', // setup → active → ended
        result: null,   // 'victory' | 'defeat' | 'fled'
        round: 0,
        order: [],
        turn: 0,
        rng: (seed >>> 0) || 1,
        combatants: combatants || [],
        log: [],
        environment, title,
        seq: 0,
    };
}

export const getCombatant = (state, id) => state.combatants.find(c => c.id === id) || null;
export const alive = (state, side) => state.combatants.filter(c => c.side === side && !c.down);
const opposite = (side) => (side === 'party' ? 'enemy' : 'party');

export function currentActor(state) {
    if (state.phase !== 'active') return null;
    return getCombatant(state, state.order[state.turn]);
}

function push(state, events, ev) {
    const e = { n: ++state.seq, round: state.round, ...ev };
    events.push(e);
    state.log.push(e);
    if (state.log.length > TUNING.maxLog) state.log.splice(0, state.log.length - TUNING.maxLog);
    return e;
}

/** Rolls initiative (DEX + d10) and opens the first turn. */
export function startCombat(state) {
    const events = [];
    const roll = {};
    for (const c of state.combatants) roll[c.id] = attrValue(c, 'dex') + Math.floor(nextRandom(state) * 10) + 1;
    state.order = state.combatants.filter(c => !c.down)
        .sort((a, b) => (roll[b.id] - roll[a.id]) || (a.side === b.side ? 0 : a.side === 'party' ? -1 : 1))
        .map(c => c.id);
    state.phase = 'active';
    state.round = 1;
    state.turn = 0;
    push(state, events, { type: 'info', text: `Round 1 — ${state.order.map(id => getCombatant(state, id).name).join(', ')}` });
    // Armour nobody can break would make the fight unwinnable: it is dropped, and the player is told.
    const plated = state.combatants.filter(c => c.side === 'enemy' && c.armored);
    if (plated.length) {
        if (state.combatants.some(c => c.side === 'party' && !c.down && canBreakArmour(c))) {
            push(state, events, { type: 'info', text: `${plated.map(c => c.name).join(', ')}: armoured — only Penetration, elements or magic get through. 🛡️` });
        } else {
            for (const c of plated) c.armored = false;
            push(state, events, { type: 'info', text: `Nobody here can pierce armour, so ${plated.map(c => c.name).join(', ')} fight without it.` });
        }
    }
    beginTurn(state, events);
    return events;
}

// ─── Statuses ───────────────────────────────────────────────────────────────

const pctText = (x) => `${Math.round(x * 100)}%`;

/**
 * What a status does, in words and with the real numbers (for the combat
 * window). Returns null for an unknown id.
 * @returns {{ id: string, name: string, icon: string, bad: boolean, text: string } | null}
 */
export function statusInfo(id) {
    const d = STATUSES[id];
    if (!d) return null;
    const t = TUNING;
    const text = {
        burn: `Loses ${pctText(t.dotPct.burn)} of its maximum HP at the start of each of its turns.`,
        poison: `Loses ${pctText(t.dotPct.poison)} of its maximum HP at the start of each of its turns.`,
        bleed: `Loses ${pctText(t.dotPct.bleed)} of its maximum HP at the start of each of its turns.`,
        stun: 'Loses its next turn. Lasts one turn, and afterwards it cannot be stunned again for two turns (bosses may resist it).',
        weaken: `Deals ${pctText(1 - t.weakenMult)} less damage.`,
        vulnerable: `Takes ${pctText(t.vulnerableMult - 1)} more damage.`,
        shield: `Takes ${pctText(1 - t.shieldMult)} less damage.`,
        empower: `Deals ${pctText(t.empowerMult - 1)} more damage.`,
        regen: `Recovers ${pctText(t.regenPct)} of its maximum HP at the start of each of its turns.`,
    }[id] || '';
    return { id, name: d.name, icon: d.icon, bad: !!d.bad, text };
}

/**
 * The next turns in order, for the turn bar. The fight keeps one order per
 * round (set by Dexterity), so this is a plain look ahead: the fallen are
 * skipped, and whoever is stunned is marked on their first turn, which they
 * will lose.
 * @param {object} state
 * @param {number} [count]
 * @returns {Array<{ id, name, side, icon, isUser, round, current: boolean, stunned: boolean, newRound: boolean }>}
 */
export function upcomingTurns(state, count = 8) {
    const order = Array.isArray(state?.order) ? state.order : [];
    if (!order.length || state.phase !== 'active') return [];
    const byId = new Map(state.combatants.map(c => [c.id, c]));
    if (!state.combatants.some(c => !c.down)) return [];
    const out = [];
    const stunSeen = new Set();
    let idx = state.turn;
    let round = state.round;
    let guard = 0;
    while (out.length < count && guard++ < order.length * 6) {
        if (idx >= order.length) { idx = 0; round++; }
        const c = byId.get(order[idx]);
        const first = out.length === 0;
        if (c && !c.down) {
            const stunned = hasStatus(c, 'stun') && !stunSeen.has(c.id);
            if (stunned) stunSeen.add(c.id);
            out.push({ id: c.id, name: c.name, side: c.side, icon: c.icon, isUser: !!c.isUser, round, current: first, stunned, newRound: idx === 0 && !first });
        }
        idx++;
    }
    return out;
}

/** The chance an attack's status lands: the profile's own, or the standard one. */
export function statusChanceOf(p) {
    return isNum(p?.statusChance) ? p.statusChance : TUNING.statusChance;
}

/** How many turns the status of a profile lasts: its own, or the standard length. */
export function statusTurnsOf(p) {
    return isNum(p?.statusTurns) ? p.statusTurns : TUNING.statusTurns;
}

function applyStatus(state, events, source, target, id, turns = TUNING.statusTurns) {
    const def = STATUSES[id];
    if (!def || target.down) return false;
    if (id === 'stun') {
        if (target.stunImmune > 0 || (target.tier === 'boss' && nextRandom(state) < 0.5)) {
            push(state, events, { type: 'resist', actor: source?.id, target: target.id, text: `${target.name} resists being stunned.` });
            return false;
        }
        turns = 1;
    }
    const cur = target.statuses.find(s => s.id === id);
    if (cur) cur.turns = Math.max(cur.turns, turns);
    else target.statuses.push({ id, turns });
    push(state, events, { type: 'status', actor: source?.id, target: target.id, status: id, text: `${target.name} is ${def.name.toLowerCase()} ${def.icon}` });
    return true;
}

function atkMult(c) {
    let m = 1;
    if (hasStatus(c, 'weaken')) m *= TUNING.weakenMult;
    if (hasStatus(c, 'empower')) m *= TUNING.empowerMult;
    return m;
}

function inMult(c) {
    let m = 1;
    if (c.guard) m *= TUNING.guardMult;
    if (hasStatus(c, 'shield')) m *= TUNING.shieldMult;
    if (hasStatus(c, 'vulnerable')) m *= TUNING.vulnerableMult;
    return m;
}

function takeDamage(state, events, c, amount, text, extra = {}) {
    c.hp = Math.max(0, c.hp - amount);
    push(state, events, { type: 'damage', target: c.id, amount, text, ...extra });
    if (c.hp <= 0 && !c.down) {
        c.down = true;
        c.statuses = [];
        c.guard = false;
        push(state, events, { type: 'down', target: c.id, text: c.side === 'enemy' ? `${c.name} is defeated! 💀` : `${c.name} falls! 💀` });
    }
}

// ─── Numbers ────────────────────────────────────────────────────────────────

export function hitChance(attacker, defender, profile = null) {
    let p = TUNING.hitBase + (attrValue(attacker, 'dex') - attrValue(defender, 'dex')) * TUNING.hitPerDex;
    if (profile && profile.stat && !PHYSICAL.has(profile.stat) && profile.stat !== 'none') p += TUNING.spellAccuracy;
    return clamp(p, TUNING.hitMin, TUNING.hitMax);
}

/** Damage before the defender's armour; `roll` is the variation factor. */
function rawDamage(attacker, action, roll, aoe) {
    const p = action.profile;
    const power = powerOf(p);
    let base;
    if (p.stat === 'none') {
        base = TUNING.itemBomb[power] + attacker.level * 1.5;
    } else {
        base = TUNING.dmgBase + attrValue(attacker, p.stat) * TUNING.dmgPerAttr;
        if (PHYSICAL.has(p.stat)) base += attacker.atkBonus;
        base *= TUNING.powerMult[power];
    }
    base *= atkMult(attacker) * roll;
    if (aoe) base *= TUNING.aoeMult;
    return base;
}

function defenceOf(defender, profile) {
    const physical = !profile || profile.stat === 'none' || PHYSICAL.has(profile.stat);
    return attrValue(defender, 'con') * TUNING.defPerCon + defender.armor * (physical ? 1 : TUNING.magicArmorShare);
}

/** How much of the damage a defender shrugs off, as 0–1: { physical, magic }. For the inspect panel. */
export function damageReduction(defender) {
    const f = (profile) => { const d = defenceOf(defender, profile); return d / (d + TUNING.defK); };
    return { physical: f(null), magic: f({ stat: 'int' }) };
}

/**
 * What a damaging action does to a defender: { amount, kind, element }.
 * kind: 'normal' | 'weak' | 'resist' | 'immune' | 'absorb' | 'bounce' (armour turned it away).
 * For 'absorb', `amount` is what the defender is healed by; for 'immune' and 'bounce' it is 0.
 */
export function damageOutcome(attacker, action, defender, { roll = 1, crit = false, aoe = false } = {}) {
    const p = action.profile;
    const element = p.element || null;
    if (defender.armored && !element && !p.pierce && PHYSICAL.has(p.stat)) return { amount: 0, kind: 'bounce', element };
    let d = rawDamage(attacker, action, roll, aoe) * (crit ? TUNING.critMult : 1);
    const def = defenceOf(defender, p);
    d = d * (1 - def / (def + TUNING.defK)) * inMult(defender);
    const aff = element ? defender.affinities?.[element] : null;
    if (aff === 'immune') return { amount: 0, kind: 'immune', element };
    if (aff === 'absorb') return { amount: Math.max(1, Math.round(d * TUNING.absorbPct)), kind: 'absorb', element };
    if (aff === 'weak') d *= TUNING.weakMult;
    else if (aff === 'resist') d *= TUNING.resistMult;
    return { amount: Math.max(1, Math.round(d)), kind: aff === 'weak' || aff === 'resist' ? aff : 'normal', element };
}

/** Damage dealt (0 when the target is immune, absorbs it or its armour turns it away). */
export function damageAgainst(attacker, action, defender, opts = {}) {
    const o = damageOutcome(attacker, action, defender, opts);
    return o.kind === 'absorb' ? 0 : o.amount;
}

export function healAmount(actor, action, target) {
    const p = action.profile;
    const power = powerOf(p);
    if (action.kind === 'item' || p.stat === 'none') return Math.max(1, Math.round(target.maxHp * TUNING.itemHealPct[power]));
    return Math.max(1, Math.round((TUNING.healBase + attrValue(actor, p.stat) * TUNING.healPerAttr) * TUNING.powerMult[power] * TUNING.healMult));
}

/** What the action would do, for a tooltip: { min, max, hit } or { amount }. */
export function estimateAction(actor, action, target = null) {
    const p = action.profile;
    if (!p) return null;
    if (p.type === 'damage' && target) {
        const aoe = p.target === 'enemies';
        const lo = damageOutcome(actor, action, target, { roll: TUNING.varMin, aoe });
        const hi = damageOutcome(actor, action, target, { roll: TUNING.varMax, aoe });
        return {
            min: lo.kind === 'absorb' ? 0 : lo.amount,
            max: hi.kind === 'absorb' ? 0 : hi.amount,
            hit: Math.round(hitChance(actor, target, p) * 100),
            kind: lo.kind,
            heals: lo.kind === 'absorb' ? { min: lo.amount, max: hi.amount } : null,
        };
    }
    if (p.type === 'heal' && target) return { amount: healAmount(actor, action, target) };
    return null;
}

// ─── Using actions ──────────────────────────────────────────────────────────

/** { ok, reason } — can this combatant use this action now? */
export function canUse(actor, action) {
    if (!actor || !action) return { ok: false, reason: 'No such action' };
    if (actor.down) return { ok: false, reason: 'Down' };
    if (action.kind === 'item' && !(action.qty > 0)) return { ok: false, reason: 'None left' };
    if (action.manaCost > 0 && actor.mana !== null && actor.mana < action.manaCost) return { ok: false, reason: 'Not enough Mana' };
    const cd = actor.cooldowns[action.id] || 0;
    if (cd > 0) return { ok: false, reason: `Ready in ${cd} turn${cd === 1 ? '' : 's'}` };
    return { ok: true, reason: '' };
}

/** Who an action can be aimed at, as combatant ids (empty: no choice needed). */
export function validTargets(state, actor, action) {
    const t = action.profile.target;
    const own = actor.side;
    if (t === 'enemy') return state.combatants.filter(c => c.side === opposite(own) && !c.down).map(c => c.id);
    if (t === 'ally') {
        const revive = action.profile.type === 'revive';
        return state.combatants.filter(c => c.side === own && (revive ? c.down : !c.down)).map(c => c.id);
    }
    return [];
}

function resolveTargets(state, actor, action, chosen) {
    const t = action.profile.target;
    if (t === 'self') return [actor];
    if (t === 'enemies') return alive(state, opposite(actor.side));
    if (t === 'allies') return alive(state, actor.side);
    const ids = validTargets(state, actor, action);
    const pick = ids.includes(chosen) ? chosen : ids[0];
    const target = pick ? getCombatant(state, pick) : null;
    return target ? [target] : [];
}

function spend(actor, action) {
    if (action.manaCost > 0 && actor.mana !== null) actor.mana = Math.max(0, actor.mana - action.manaCost);
    if (action.cooldown > 0) actor.cooldowns[action.id] = action.cooldown;
    if (action.kind === 'item') action.qty = Math.max(0, (action.qty || 0) - 1);
    actor.guard = false;
}

/**
 * Uses an action. Returns the events (and moves nothing along: call
 * advance() afterwards to end the turn). `targetId` is the chosen target for
 * single-target actions.
 */
export function performAction(state, actorId, actionId, targetId = null) {
    const events = [];
    if (state.phase !== 'active') return events;
    const actor = getCombatant(state, actorId);
    const action = actor?.actions.find(a => a.id === actionId);
    const check = canUse(actor, action);
    if (!check.ok) {
        push(state, events, { type: 'info', text: `${actor?.name || 'Someone'} cannot do that: ${check.reason}.` });
        return events;
    }
    const targets = resolveTargets(state, actor, action, targetId);
    if (!targets.length) {
        push(state, events, { type: 'info', text: 'There is no valid target.' });
        return events;
    }
    spend(actor, action);
    const p = action.profile;
    const verb = `${actor.name} uses ${action.label}`;
    const aoe = p.target === 'enemies';

    if (p.type === 'damage') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb}${aoe ? '' : ` on ${targets[0].name}`}.` });
        for (const t of targets) {
            if (nextRandom(state) >= hitChance(actor, t, p)) {
                push(state, events, { type: 'miss', actor: actor.id, target: t.id, text: `${t.name} avoids it.` });
                continue;
            }
            const crit = nextRandom(state) < TUNING.critChance;
            const roll = TUNING.varMin + nextRandom(state) * (TUNING.varMax - TUNING.varMin);
            const o = damageOutcome(actor, action, t, { roll, crit, aoe });
            const el = o.element ? ` ${ELEMENTS[o.element].icon}` : '';
            if (o.kind === 'bounce') {
                push(state, events, { type: 'bounce', actor: actor.id, target: t.id, text: `${t.name}'s armour turns the blow aside — it needs Penetration or an element. 🛡️` });
                continue;
            }
            if (o.kind === 'immune') {
                push(state, events, { type: 'immune', actor: actor.id, target: t.id, text: `${t.name} is immune to ${ELEMENTS[o.element].name}${el}.` });
                continue;
            }
            if (o.kind === 'absorb') {
                const gain = Math.min(o.amount, t.maxHp - t.hp);
                t.hp += gain;
                push(state, events, { type: 'absorb', actor: actor.id, target: t.id, amount: gain, text: `${t.name} absorbs ${ELEMENTS[o.element].name}${el} and recovers ${gain} HP 💚` });
                continue;
            }
            const dmg = o.amount;
            const note = o.kind === 'weak' ? ' Weak point!' : o.kind === 'resist' ? ' Resisted.' : '';
            takeDamage(state, events, t, dmg, `${t.name} takes ${dmg}${el} damage${crit ? ' (critical!)' : ''}.${note}`, { actor: actor.id, crit, affinity: o.kind });
            if (p.status && !t.down && nextRandom(state) < statusChanceOf(p)) applyStatus(state, events, actor, t, p.status, statusTurnsOf(p));
        }
    } else if (p.type === 'heal') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb}${p.target === 'allies' ? '' : ` on ${targets[0].name}`}.` });
        for (const t of targets) {
            const amount = Math.min(healAmount(actor, action, t), t.maxHp - t.hp);
            t.hp += amount;
            push(state, events, { type: 'heal', actor: actor.id, target: t.id, amount, text: `${t.name} recovers ${amount} HP 💚` });
        }
    } else if (p.type === 'status') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb}${p.target === 'self' || p.target === 'allies' || p.target === 'enemies' ? '' : ` on ${targets[0].name}`}.` });
        const bad = STATUSES[p.status]?.bad;
        for (const t of targets) {
            if (bad && t.side !== actor.side && nextRandom(state) >= hitChance(actor, t, p)) {
                push(state, events, { type: 'miss', actor: actor.id, target: t.id, text: `${t.name} resists.` });
                continue;
            }
            applyStatus(state, events, actor, t, p.status, statusTurnsOf(p));
        }
    } else if (p.type === 'mana') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb} on ${targets[0].name}.` });
        for (const t of targets) {
            if (t.mana === null) { push(state, events, { type: 'info', text: `${t.name} has no Mana.` }); continue; }
            const amount = Math.min(TUNING.itemMana[powerOf(p)], 100 - t.mana);
            t.mana += amount;
            push(state, events, { type: 'mana', actor: actor.id, target: t.id, amount, text: `${t.name} regains ${amount} Mana 💧` });
        }
    } else if (p.type === 'cure') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb} on ${targets[0].name}.` });
        for (const t of targets) {
            const before = t.statuses.length;
            t.statuses = t.statuses.filter(s => !STATUSES[s.id]?.bad);
            push(state, events, { type: 'cure', actor: actor.id, target: t.id, text: before !== t.statuses.length ? `${t.name} is cleansed ✨` : `${t.name} had nothing to cure.` });
        }
    } else if (p.type === 'revive') {
        push(state, events, { type: 'use', actor: actor.id, text: `${verb} on ${targets[0].name}.` });
        for (const t of targets) {
            if (!t.down) { push(state, events, { type: 'info', text: `${t.name} is already up.` }); continue; }
            t.down = false;
            t.hp = Math.max(1, Math.round(t.maxHp * TUNING.revivePct[powerOf(p)]));
            if (!state.order.includes(t.id)) state.order.push(t.id);
            push(state, events, { type: 'heal', actor: actor.id, target: t.id, amount: t.hp, text: `${t.name} is back on their feet! ✨` });
        }
    }
    checkEnd(state, events);
    return events;
}

/** Guard for the round: incoming damage is halved until the next turn. */
export function defend(state, actorId) {
    const events = [];
    const actor = getCombatant(state, actorId);
    if (state.phase !== 'active' || !actor || actor.down) return events;
    actor.guard = true;
    push(state, events, { type: 'defend', actor: actor.id, text: `${actor.name} braces for impact 🛡️` });
    return events;
}

export function fleeChance(state) {
    const avg = (side) => { const l = alive(state, side); return l.length ? l.reduce((s, c) => s + attrValue(c, 'dex'), 0) / l.length : 10; };
    let p = TUNING.fleeBase + (avg('party') - avg('enemy')) * TUNING.fleePerDex;
    if (state.combatants.some(c => c.side === 'enemy' && !c.down && c.tier === 'boss')) p -= TUNING.fleeBossPenalty;
    return clamp(p, TUNING.fleeMin, TUNING.fleeMax);
}

/** Tries to run. Success ends the fight as 'fled'. */
export function attemptFlee(state, actorId) {
    const events = [];
    const actor = getCombatant(state, actorId);
    if (state.phase !== 'active' || !actor || actor.down) return events;
    actor.guard = false;
    if (nextRandom(state) < fleeChance(state)) {
        push(state, events, { type: 'flee', actor: actor.id, text: `${actor.name} leads the retreat — the party escapes! 🏃` });
        state.phase = 'ended';
        state.result = 'fled';
    } else {
        push(state, events, { type: 'flee', actor: actor.id, text: `${actor.name} tries to run, but is cut off!` });
    }
    return events;
}

// ─── Turns ──────────────────────────────────────────────────────────────────

/** Why the fight is over, or null. */
export function checkEnd(state, events = []) {
    if (state.phase !== 'active') return state.result;
    if (!alive(state, 'enemy').length) {
        state.phase = 'ended'; state.result = 'victory';
        push(state, events, { type: 'end', text: 'Victory! 🎉' });
    } else if (!alive(state, 'party').length) {
        state.phase = 'ended'; state.result = 'defeat';
        push(state, events, { type: 'end', text: 'The party has fallen…' });
    }
    return state.result;
}

/** Start of a turn: damage/healing over time, cooldowns, a stunned turn is skipped. */
function beginTurn(state, events) {
    for (let guard = 0; guard < state.order.length * 2 + 2 && state.phase === 'active'; guard++) {
        const actor = currentActor(state);
        if (!actor || actor.down) { stepIndex(state, events); continue; }
        actor.guard = false;
        for (const id of Object.keys(actor.cooldowns)) {
            if (actor.cooldowns[id] > 0) actor.cooldowns[id]--;
            if (actor.cooldowns[id] <= 0) delete actor.cooldowns[id];
        }
        if (actor.stunImmune > 0) actor.stunImmune--;
        for (const s of [...actor.statuses]) {
            const def = STATUSES[s.id];
            if (def?.dot) {
                const dmg = Math.max(2, Math.round(actor.maxHp * TUNING.dotPct[s.id]));
                takeDamage(state, events, actor, dmg, `${actor.name} suffers ${dmg} damage from ${def.name.toLowerCase()} ${def.icon}`, { dot: true });
            } else if (s.id === 'regen') {
                const heal = Math.min(Math.max(2, Math.round(actor.maxHp * TUNING.regenPct)), actor.maxHp - actor.hp);
                if (heal > 0) { actor.hp += heal; push(state, events, { type: 'heal', target: actor.id, amount: heal, text: `${actor.name} regenerates ${heal} HP 💚` }); }
            }
        }
        if (checkEnd(state, events)) return;
        if (actor.down) { stepIndex(state, events); continue; }
        if (hasStatus(actor, 'stun')) {
            push(state, events, { type: 'skip', actor: actor.id, text: `${actor.name} is stunned and loses the turn 💫` });
            actor.statuses = actor.statuses.filter(s => s.id !== 'stun');
            actor.stunImmune = 2;
            tickStatuses(actor);
            stepIndex(state, events);
            continue;
        }
        return;
    }
}

function tickStatuses(actor) {
    for (const s of actor.statuses) s.turns--;
    actor.statuses = actor.statuses.filter(s => s.turns > 0);
}

function stepIndex(state, events) {
    // The order may have gained a revived member; keep it, skip the fallen.
    state.turn++;
    if (state.turn >= state.order.length) {
        state.turn = 0;
        state.round++;
        push(state, events, { type: 'info', text: `Round ${state.round}` });
    }
}

/** Ends the current turn and opens the next one. Returns the events. */
export function advance(state) {
    const events = [];
    if (state.phase !== 'active') return events;
    const actor = currentActor(state);
    if (actor && !actor.down) tickStatuses(actor);
    if (checkEnd(state, events)) return events;
    stepIndex(state, events);
    beginTurn(state, events);
    return events;
}

// ─── Enemy behaviour ────────────────────────────────────────────────────────

/** Would this attack do nothing at all to the target? */
function nullifies(attacker, action, defender) {
    const k = damageOutcome(attacker, action, defender).kind;
    return k === 'bounce' || k === 'immune' || k === 'absorb';
}

/** Can this fighter hurt an armoured enemy (Penetration, an element, or a spell)? */
export function canBreakArmour(c) {
    return (c.actions || []).some(a => {
        const p = a.profile;
        return p && p.type === 'damage' && (p.pierce || p.element || !PHYSICAL.has(p.stat));
    });
}

/** What an enemy does this turn: { actionId, targetId } or { defend: true }. */
export function chooseEnemyAction(state, enemy) {
    const usable = enemy.actions.filter(a => canUse(enemy, a).ok);
    const foes = alive(state, opposite(enemy.side));
    const allies = alive(state, enemy.side);
    const weights = [];
    for (const a of usable) {
        const p = a.profile;
        let w = a.id === 'basic' ? 1 : 2;
        if (p.type === 'heal') {
            const hurt = allies.some(c => c.hp / c.maxHp < 0.4);
            w = hurt ? 4 : 0;
        } else if (p.type === 'status') {
            const bad = STATUSES[p.status]?.bad;
            const pool = bad ? foes : allies;
            w = pool.every(c => hasStatus(c, p.status)) ? 0 : 2;
        } else if (p.type === 'mana' || p.type === 'cure' || p.type === 'revive' || p.type === 'gear' || p.type === 'none') {
            w = 0;
        }
        if (p.type === 'damage' && foes.length && foes.every(f => nullifies(enemy, a, f))) w = 0;
        if (w > 0) weights.push({ a, w });
    }
    if (!weights.length) weights.push({ a: enemy.actions[0], w: 1 });
    let total = weights.reduce((s, x) => s + x.w, 0);
    let r = nextRandom(state) * total;
    let chosen = weights[0].a;
    for (const x of weights) { r -= x.w; if (r <= 0) { chosen = x.a; break; } }
    let targetId = null;
    const p = chosen.profile;
    if (p.target === 'enemy') {
        // Hurt targets attract attacks; the rest are picked at random.
        const open = p.type === 'damage' ? foes.filter(f => !nullifies(enemy, chosen, f)) : foes;
        const pool = (open.length ? open : foes).map(c => ({ c, w: 1 + (c.hp / c.maxHp < 0.35 ? 1.5 : 0) }));
        total = pool.reduce((s, x) => s + x.w, 0);
        r = nextRandom(state) * total;
        targetId = pool[0]?.c.id ?? null;
        for (const x of pool) { r -= x.w; if (r <= 0) { targetId = x.c.id; break; } }
    } else if (p.target === 'ally') {
        const hurt = [...allies].sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        targetId = hurt?.id ?? enemy.id;
    }
    return { actionId: chosen.id, targetId };
}

/** Plays the current enemy's turn (without ending it). */
export function runEnemyTurn(state) {
    const enemy = currentActor(state);
    if (!enemy || enemy.side !== 'enemy') return [];
    const { actionId, targetId } = chooseEnemyAction(state, enemy);
    return performAction(state, enemy.id, actionId, targetId);
}

// ─── Ending ─────────────────────────────────────────────────────────────────

/** hit points → the Health bar (0–100); the fallen keep 1%. */
export function hpToHealthPct(c) {
    if (c.down || c.hp <= 0) return 1;
    return clamp(Math.round((c.hp / c.maxHp) * 100), 1, 100);
}

/** What each party member carries out of the fight. */
export function partyOutcome(state) {
    return state.combatants.filter(c => c.side === 'party').map(c => ({
        id: c.id,
        name: c.name,
        isUser: c.isUser,
        healthPct: hpToHealthPct(c),
        manaPct: c.mana,
        down: c.down,
        statuses: c.statuses.filter(s => STATUSES[s.id]?.bad && s.turns > 0).map(s => ({ id: s.id, name: STATUSES[s.id].name, icon: STATUSES[s.id].icon })),
        // What was used up: { actionId: qty left } for items.
        itemsLeft: Object.fromEntries(c.actions.filter(a => a.kind === 'item').map(a => [a.id, a.qty])),
    }));
}

/**
 * XP, money and loot for the enemies that fell (nothing unless the party won).
 * `tierXp` is the XP table ({ small, medium, large, epic }); `partyLevel` the
 * party's average level.
 */
export function computeRewards(state, { tierXp = { small: 10, medium: 25, large: 50, epic: 100 }, partyLevel = 1 } = {}) {
    const out = { xp: 0, money: 0, items: [], defeated: [] };
    if (state.result !== 'victory') return out;
    for (const e of state.combatants.filter(c => c.side === 'enemy' && c.down)) {
        const tier = TUNING.tiers[e.tier] || TUNING.tiers.normal;
        const factor = clamp(e.level / Math.max(1, partyLevel), 0.5, 2);
        const xp = Math.round((tierXp[tier.xp] ?? 0) * factor);
        out.xp += xp;
        const asked = isNum(e.loot?.money) ? e.loot.money : null;
        const money = asked !== null ? clamp(Math.round(asked * 100) / 100, 0, tier.moneyCap) : Math.round(tier.money * factor);
        out.money += money;
        const items = Array.isArray(e.loot?.items) ? e.loot.items.filter(x => typeof x === 'string' && x.trim()).slice(0, 2) : [];
        out.items.push(...items.map(s => s.trim().slice(0, 40)));
        out.defeated.push({ name: e.name, tier: e.tier || 'normal', xp, money });
    }
    out.money = Math.round(out.money * 100) / 100;
    out.items = [...new Set(out.items)].slice(0, 4);
    return out;
}

/** A compact record of the fight for the AI that tells the story. */
export function summarizeForNarration(state, rewards = null) {
    const party = state.combatants.filter(c => c.side === 'party');
    const enemies = state.combatants.filter(c => c.side === 'enemy');
    const notable = state.log.filter(e => e.crit || e.type === 'down' || e.type === 'flee' || e.type === 'status' || e.type === 'heal').slice(-14).map(e => e.text);
    return {
        result: state.result,
        rounds: state.round,
        environment: state.environment || '',
        party: party.map(c => ({ name: c.name, hp: `${c.hp}/${c.maxHp}`, down: c.down })),
        enemies: enemies.map(c => ({ name: c.name, defeated: c.down })),
        highlights: notable,
        rewards: rewards ? { xp: rewards.xp, money: rewards.money, items: rewards.items } : null,
    };
}
