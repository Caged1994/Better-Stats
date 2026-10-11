/**
 * Affinity — pure model.
 *
 * How each NPC feels about the player's character, from −100 (sworn enemy)
 * to +100 (would die for them). The AI gives a starting value when an NPC
 * first appears, then moves it in small steps when the player's character
 * does something that matters to them.
 *
 * Record: { value, reason, at }  (reason/at: the last change)
 */

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
/** The most one reply can move an NPC's affinity (a starting value is free). */
export const MAX_AFFINITY_STEP = 10;

/** Tiers, from the bottom; each covers values up to and including `max`. */
export const AFFINITY_TIERS = [
    { id: 'hostile', label: 'Hostile', max: -60, color: '#e5534b' },
    { id: 'wary', label: 'Wary', max: -20, color: '#e0915a' },
    { id: 'neutral', label: 'Neutral', max: 19, color: '#a8a8b3' },
    { id: 'friendly', label: 'Friendly', max: 59, color: '#6cc18a' },
    { id: 'close', label: 'Close', max: 100, color: '#e86fa4' },
];

export function clampAffinity(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return null;
    return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, n));
}

export function affinityTier(value) {
    const v = clampAffinity(value) ?? 0;
    return AFFINITY_TIERS.find(t => v <= t.max) || AFFINITY_TIERS[AFFINITY_TIERS.length - 1];
}

/** "Elena 35 (friendly)" */
export function formatAffinity(name, value) {
    return `${name} ${value > 0 ? '+' : ''}${value} (${affinityTier(value).id})`;
}

function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const m = v.replace(/[−–]/g, '-').match(/[-+]?\d+(\.\d+)?/);
        return m ? Number(m[0]) : null;
    }
    return null;
}

/**
 * The AI's "affinity" value → [{ name, set?, delta?, reason }].
 * Accepts {"Elena": 5}, {"Elena": "-3"}, {"Elena": {"change": 5, "reason": "…"}},
 * {"Elena": {"set": 30}} (a starting value) and [{"name": "Elena", …}].
 */
export function normalizeAIAffinity(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    const out = [];
    const push = (name, val) => {
        if (typeof name !== 'string' || !name.trim()) return;
        const reasonOf = (o) => {
            const r = o && typeof o === 'object' ? (o.reason ?? o.why ?? o.because ?? o.note) : '';
            return typeof r === 'string' ? r.trim().slice(0, 100) : '';
        };
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const set = num(val.set ?? val.start ?? val.initial ?? val.value);
            const delta = num(val.change ?? val.delta ?? val.add ?? val.by);
            if (set !== null && delta === null) out.push({ name: name.trim(), set, reason: reasonOf(val) });
            else if (delta !== null) out.push({ name: name.trim(), delta, reason: reasonOf(val) });
            return;
        }
        const d = num(val);
        if (d !== null) out.push({ name: name.trim(), delta: d, reason: '' });
    };
    if (Array.isArray(data)) {
        for (const e of data) if (e && typeof e === 'object') push(e.name ?? e.character, e);
    } else {
        for (const [k, v] of Object.entries(data)) push(k, v);
    }
    return out;
}

/**
 * The value after one AI change. A starting value is taken as given; a
 * change is capped at ±MAX_AFFINITY_STEP.
 */
export function applyAffinityChange(current, change) {
    if (change.set !== undefined && change.set !== null) return clampAffinity(change.set);
    const step = Math.max(-MAX_AFFINITY_STEP, Math.min(MAX_AFFINITY_STEP, Math.round(change.delta || 0)));
    return clampAffinity((current ?? 0) + step);
}

/**
 * The prompt section.
 * @param {string} player - the player's character
 * @param {Array<{name, value}>} known - scene NPCs with a value
 * @param {string[]} needStart - scene NPCs that still need a starting value
 */
export function buildAffinityPrompt({ player, known = [], needStart = [], compact = true, standalone = false } = {}) {
    if (!player || (!known.length && !needStart.length)) return '';
    const where = standalone ? 'start your reply with ONE JSON code block with' : 'add to the same tracker JSON object';
    let out = compact
        ? `AFFINITY toward ${player} (−100 hostile … +100 close):`
        : `AFFINITY — how each character feels about ${player}, from −100 (hostile) to +100 (close):`;
    out += known.length ? ' ' + known.map(k => formatAffinity(k.name, k.value)).join(', ') + '.\n' : '\n';
    out += compact
        ? `When ${player} does something that matters to one of them, ${where} "affinity": {"Name": 5} (a change, at most ±${MAX_AFFINITY_STEP}; it can go down). Let it shape how they treat ${player}. Most replies change nothing: leave the key out.`
        : `Let these values shape how each of them talks to and treats ${player}. When ${player} does something that genuinely matters to one of them — help, a gift, a kindness, a betrayal, an insult, a threat — ${where} "affinity": {"Name": 5}, a change of at most ±${MAX_AFFINITY_STEP} per reply (negative to lower it). Most replies change nothing; then leave the key out.`;
    if (needStart.length) {
        out += compact
            ? `\nSTARTING AFFINITY: give ${needStart.join(', ')} a value from who they are and what they know of ${player}: "affinity": {${needStart.map(n => `"${n}": {"set": 0}`).join(', ')}}.`
            : `\nSTARTING AFFINITY: ${needStart.join(', ')} ${needStart.length === 1 ? 'has' : 'have'} no value yet. Give each a starting value that fits their history with ${player} and their nature (a stranger is around 0, an old friend 50, a rival −30) with "set": "affinity": {${needStart.map(n => `"${n}": {"set": 0}`).join(', ')}}.`;
    }
    return out.trim();
}
