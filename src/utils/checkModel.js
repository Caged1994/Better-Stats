/**
 * Checks — pure model.
 *
 * A check is "d20 + the attribute's modifier + a situational bonus" against a
 * difficulty. The attribute scale is the one used everywhere else: 10 is an
 * ordinary person, 20 the peak a human can reach.
 *
 *   modifier = floor((value − 10) / 2)      10 → 0, 14 → +2, 20 → +5, 40 → +15
 *   a natural 20 always succeeds, a natural 1 always fails
 *
 * The AI only says what is being attempted, with which attribute and how
 * hard it is; the number is rolled here, so it cannot decide the outcome.
 */

export const DIFFICULTIES = [
    { id: 'easy', label: 'Easy', dc: 8 },
    { id: 'medium', label: 'Medium', dc: 12 },
    { id: 'hard', label: 'Hard', dc: 16 },
    { id: 'extreme', label: 'Extreme', dc: 20 },
];
export const DEFAULT_DIFFICULTY = 'medium';
export const MIN_DC = 4;
export const MAX_DC = 30;
/** What the player can add by hand for a favourable or awkward situation. */
export const MAX_BONUS = 10;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** The bonus (or penalty) an attribute value gives to a roll. */
export function attributeModifier(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return 0;
    return Math.floor((v - 10) / 2);
}

/**
 * A difficulty from an id ("hard"), a label, or a number (the target itself).
 * @returns {{ id: string|null, label: string, dc: number }}
 */
export function resolveDifficulty(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const dc = clamp(Math.round(raw), MIN_DC, MAX_DC);
        const hit = DIFFICULTIES.find(d => d.dc === dc);
        return hit ? { ...hit } : { id: null, label: `DC ${dc}`, dc };
    }
    const text = String(raw ?? '').toLowerCase().trim();
    if (/^\d+$/.test(text)) return resolveDifficulty(Number(text));
    const aliases = { trivial: 'easy', simple: 'easy', routine: 'easy', normal: 'medium', moderate: 'medium', average: 'medium', difficult: 'hard', tough: 'hard', 'very hard': 'extreme', veryhard: 'extreme', nearly_impossible: 'extreme', impossible: 'extreme', heroic: 'extreme' };
    const id = aliases[text] || text;
    const d = DIFFICULTIES.find(x => x.id === id) || DIFFICULTIES.find(x => x.label.toLowerCase() === text);
    return { ...(d || DIFFICULTIES.find(x => x.id === DEFAULT_DIFFICULTY)) };
}

/** How many of the 20 faces succeed, as 0–1 (natural 20 always, natural 1 never). */
export function successChance(modifier, dc) {
    let wins = 0;
    for (let face = 1; face <= 20; face++) {
        if (face === 20 || (face !== 1 && face + modifier >= dc)) wins++;
    }
    return wins / 20;
}

/**
 * Rolls a check.
 * @param {object} o
 * @param {number} o.value - the attribute's current value (with bonuses)
 * @param {number} [o.bonus] - situational bonus or penalty
 * @param {number} o.dc
 * @param {() => number} [o.rng] - returns [0, 1)
 * @returns {{ die, modifier, bonus, total, dc, margin, success, degree }}
 */
export function rollCheck({ value, bonus = 0, dc, rng = Math.random } = {}) {
    const die = clamp(Math.floor(rng() * 20) + 1, 1, 20);
    const modifier = attributeModifier(value);
    const extra = clamp(Math.round(Number(bonus) || 0), -MAX_BONUS, MAX_BONUS);
    const target = clamp(Math.round(Number(dc) || 12), MIN_DC, MAX_DC);
    const total = die + modifier + extra;
    const margin = total - target;
    const success = die === 20 || (die !== 1 && total >= target);
    const degree = die === 20 ? 'critical-success' : die === 1 ? 'critical-failure' : success ? 'success' : 'failure';
    return { die, modifier, bonus: extra, total, dc: target, margin, success, degree };
}

const DEGREE_LABEL = {
    'critical-success': 'CRITICAL SUCCESS',
    success: 'SUCCESS',
    failure: 'FAILURE',
    'critical-failure': 'CRITICAL FAILURE',
};

export function degreeLabel(degree) {
    return DEGREE_LABEL[degree] || String(degree || '').toUpperCase();
}

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

/** "rolled 12 +2 = 14 against 16" */
export function rollText(r) {
    const parts = [`${r.die}`];
    if (r.modifier) parts.push(signed(r.modifier));
    if (r.bonus) parts.push(signed(r.bonus));
    return `rolled ${parts.join(' ')}${parts.length > 1 ? ` = ${r.total}` : ''} against ${r.dc}`;
}

/**
 * One line of fact for the AI: "Mastera, DEX check (hard): rolled 12 +2 = 14
 * against 16 — FAILURE by 2 (jump the gap)."
 */
export function describeResult(entry) {
    const r = entry;
    const how = r.success ? (r.margin > 0 ? ` by ${r.margin}` : '') : ` by ${Math.abs(r.margin)}`;
    const natural = r.degree === 'critical-success' ? ' (natural 20)' : r.degree === 'critical-failure' ? ' (natural 1)' : '';
    return `${r.name}, ${r.statLabel} check (${r.difficultyLabel || `DC ${r.dc}`}): ${rollText(r)} — ${degreeLabel(r.degree)}${r.degree.startsWith('critical') ? natural : how}${r.reason ? ` (${r.reason})` : ''}.`;
}

/**
 * The AI's "check" request → { who?, stat, difficulty, reason } or null.
 * Accepts {"stat": "dex", "difficulty": "hard", "reason": "…"}, also
 * "attribute", "dc", "character" / "who" / "name".
 */
export function normalizeCheckRequest(raw) {
    let data = raw;
    if (typeof data === 'string') {
        const t = data.trim();
        if (!t) return null;
        try { data = JSON.parse(t); } catch (e) { return null; }
    }
    if (Array.isArray(data)) data = data[0];
    if (!data || typeof data !== 'object') return null;
    const stat = String(data.stat ?? data.attribute ?? data.skill ?? '').trim();
    if (!stat) return null;
    const diffRaw = data.difficulty ?? data.dc ?? data.level;
    const d = resolveDifficulty(diffRaw);
    const who = String(data.who ?? data.character ?? data.name ?? '').trim();
    return {
        who: who || null,
        stat,
        difficulty: d.id,
        dc: d.dc,
        reason: String(data.reason ?? data.action ?? data.task ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
    };
}

/**
 * Instructions for the AI: how to ask for a check, and the outcome of the
 * last one.
 * @param {object} o
 * @param {string} o.player
 * @param {string[]} o.statIds - attribute ids the AI may name
 * @param {string} [o.note] - the outcome of the last check (a describeResult line)
 */
export function buildChecksPrompt({ player, statIds = [], note = '', compact = true, standalone = false } = {}) {
    if (!statIds.length && !note) return '';
    const where = standalone ? 'start your reply with ONE JSON code block with' : 'add to the same tracker JSON object';
    const ids = statIds.join('|');
    let out = '';
    if (statIds.length) {
        out += compact
            ? `CHECKS: when ${player || 'the player'} is about to try something risky whose outcome is uncertain and matters, ${where} "check": {"stat": "${ids}", "difficulty": "easy|medium|hard|extreme", "reason": "short"}. The player rolls it, so do not decide the outcome. Rarely, one at a time; leave it out for easy, safe or impossible actions.`
            : `CHECKS: when ${player || 'the player'} is about to attempt something risky whose outcome is genuinely uncertain and would matter (forcing a lock, leaping a gap, persuading a guard), ${where} "check": {"stat": "${ids}", "difficulty": "easy|medium|hard|extreme", "reason": "what is attempted, in a few words"}. The player rolls the dice, so never decide the outcome yourself. Use it rarely and one at a time, and leave the key out for trivial, safe or impossible actions.`;
    }
    if (note) out += `${out ? '\n' : ''}LAST CHECK (rolled by the game, not by you): ${note} This outcome is fixed: write what happens next to match it.`;
    return out.trim();
}
