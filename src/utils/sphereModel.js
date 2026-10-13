/**
 * Sphere grid — pure model.
 *
 * A growth grid in the spirit of Final Fantasy X: a character has a map of
 * nodes, starts on one of them and can unlock only the nodes next to ones they
 * already own, spending the points that levels give. What a node gives:
 *   attr     +1 to an attribute (clusters by region, so the map has "areas");
 *   ability  a spell or skill, with its combat effect already decided here;
 *   passive  a small bonus to one or two attributes, kept as a passive skill.
 * The program lays the map out and decides every number; the AI may only name
 * and describe the spells, skills and passives (see sphereGrid.js).
 *
 * A grid is plain data, so it is saved in the chat as it is:
 *   { v, seed, size, theme, dressed, start, nodes: { id: node }, unlocked: [ids] }
 *   node = { id, x, y, type, links, depth, cost, stat?, amount?, slot?, name?, desc?, icon? }
 *   slot (abilities) = { kind: 'spell'|'ability', profile, cost? (Mana tier), role }
 */
import { nextRandom } from './dungeonModel.js';

export const GRID_SIZES = {
    small: { label: 'Small', cols: 6, rows: 6, nodes: 30, abilities: 5, passives: 4 },
    medium: { label: 'Medium', cols: 8, rows: 7, nodes: 44, abilities: 8, passives: 6 },
    large: { label: 'Large', cols: 9, rows: 8, nodes: 58, abilities: 11, passives: 8 },
};
export const DEFAULT_SIZE = 'medium';

export const NODE_TYPES = {
    start: { icon: '⭐', label: 'Start' },
    attr: { icon: '🔷', label: 'Attribute' },
    ability: { icon: '✨', label: 'Spell or skill' },
    passive: { icon: '🛡️', label: 'Passive' },
};

const COSTS = { attr: 1, ability: 2, abilityDeep: 3, passive: 2, passiveDeep: 3 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rint = (s, n) => Math.floor(nextRandom(s) * n);
const pick = (s, list) => list[rint(s, list.length)];
function shuffle(s, list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = rint(s, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (x, y) => `${x},${y}`;

// ─── What a slot can be ─────────────────────────────────────────────────────

const POWERS = ['light', 'medium', 'heavy'];
const TIER_OF_POWER = { light: 'light', medium: 'medium', heavy: 'heavy' };

/** The recipes for spells and skills; the attribute is the region's. */
function abilitySlot(s, stat, frac, taken) {
    const power = frac < 0.4 ? 'light' : frac < 0.75 ? 'medium' : 'heavy';
    const magic = stat === 'int' || stat === 'wis' || stat === 'cha';
    const options = magic
        ? [
            { kind: 'spell', role: 'bolt', profile: { type: 'damage', power, stat: stat === 'cha' ? 'int' : stat, target: 'enemy' } },
            { kind: 'spell', role: 'heal', profile: { type: 'heal', power, stat: 'wis', target: 'ally' } },
            { kind: 'spell', role: 'ward', profile: { type: 'status', status: 'shield', power: 'light', stat: 'none', target: 'ally' } },
            { kind: 'spell', role: 'hex', profile: { type: 'status', status: pick(s, ['weaken', 'vulnerable', 'stun']), power: 'light', stat: 'none', target: 'enemy' } },
            ...(power !== 'light' ? [{ kind: 'spell', role: 'blast', profile: { type: 'damage', power, stat: stat === 'cha' ? 'int' : stat, target: 'enemies' } }] : []),
        ]
        : [
            { kind: 'ability', role: 'strike', profile: { type: 'damage', power, stat, target: 'enemy' } },
            { kind: 'ability', role: 'rally', profile: { type: 'status', status: 'empower', power: 'light', stat: 'none', target: 'self' } },
            { kind: 'ability', role: 'wound', profile: { type: 'damage', power: power === 'heavy' ? 'medium' : 'light', stat, target: 'enemy', status: pick(s, ['bleed', 'poison']) } },
            { kind: 'ability', role: 'recover', profile: { type: 'status', status: 'regen', power: 'light', stat: 'none', target: 'self' } },
            ...(power !== 'light' ? [{ kind: 'ability', role: 'sweep', profile: { type: 'damage', power, stat, target: 'enemies' } }] : []),
        ];
    const fresh = options.filter(o => !taken.has(o.role));
    const chosen = pick(s, fresh.length ? fresh : options);
    taken.add(chosen.role);
    const slot = { kind: chosen.kind, role: chosen.role, profile: chosen.profile };
    if (chosen.kind === 'spell') slot.cost = TIER_OF_POWER[chosen.profile.power] || 'light';
    return slot;
}

// ─── Generic names (when the AI is not used) ────────────────────────────────

const GENERIC = {
    str: { ability: ['Crushing blow', 'Hard strike', 'Break guard', 'Heavy swing'], passive: ['Strong arms', 'Iron grip'] },
    dex: { ability: ['Quick cut', 'Piercing shot', 'Sly strike', 'Lightning feint'], passive: ['Light feet', 'Steady hand'] },
    con: { ability: ['Second wind', 'Shrug it off', 'Hold the line', 'Stand firm'], passive: ['Thick skin', 'Hardy body'] },
    int: { ability: ['Arcane bolt', 'Mind lance', 'Hex of weakness', 'Mana burst'], passive: ['Sharp mind', 'Deep focus'] },
    wis: { ability: ['Mending light', 'Warding glow', 'Calm spirit', 'Healing touch'], passive: ['Quiet insight', 'Clear sight'] },
    cha: { ability: ['Rousing word', 'Silver tongue', 'Commanding cry', 'Bright charm'], passive: ['Easy presence', 'Warm voice'] },
};
const ROLE_NAMES = {
    bolt: 'Arcane bolt', heal: 'Mending light', ward: 'Warding glow', hex: 'Hex of weakness', blast: 'Wave of force',
    strike: 'Hard strike', rally: 'Battle cry', wound: 'Rending cut', recover: 'Second wind', sweep: 'Sweeping blow',
};
const ROLE_ICONS = { bolt: '🔮', heal: '💚', ward: '🛡️', hex: '🌀', blast: '💥', strike: '🗡️', rally: '📣', wound: '🩸', recover: '💚', sweep: '🌪️' };

// ─── Building the grid ──────────────────────────────────────────────────────

function growCells(s, cols, rows, n) {
    const start = { x: Math.floor((cols - 1) / 2), y: Math.floor((rows - 1) / 2) };
    const cells = [start];
    const set = new Set([key(start.x, start.y)]);
    let guard = 0;
    while (cells.length < n && guard++ < 4000) {
        const from = cells[rint(s, cells.length)];
        for (const [dx, dy] of shuffle(s, DIRS)) {
            const x = from.x + dx, y = from.y + dy;
            if (x < 0 || y < 0 || x >= cols || y >= rows || set.has(key(x, y))) continue;
            cells.push({ x, y });
            set.add(key(x, y));
            break;
        }
    }
    return cells;
}

/**
 * Builds a grid. The same seed (and attributes) give the same grid.
 * @param {{seed?: number, size?: string, attributes: string[], theme?: string}} o
 */
export function generateGrid({ seed = Date.now(), size = DEFAULT_SIZE, attributes = ['str', 'dex', 'con', 'int', 'wis', 'cha'], theme = '' } = {}) {
    const z = GRID_SIZES[size] || GRID_SIZES[DEFAULT_SIZE];
    const attrs = attributes.length ? attributes : ['str'];
    const s = { rng: (seed >>> 0) || 1 };
    const cells = growCells(s, z.cols, z.rows, z.nodes);
    const byCell = {};
    const nodes = {};
    cells.forEach((c, i) => {
        const id = `n${i + 1}`;
        byCell[key(c.x, c.y)] = id;
        nodes[id] = { id, x: c.x, y: c.y, type: 'attr', links: [], depth: 0, cost: COSTS.attr };
    });
    // Every neighbouring pair is joined, apart from a few left out so the map is not a solid block.
    for (const c of cells) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const o = byCell[key(c.x + dx, c.y + dy)];
            if (!o) continue;
            const me = byCell[key(c.x, c.y)];
            if (nodes[me].links.includes(o)) continue;
            nodes[me].links.push(o);
            nodes[o].links.push(me);
        }
    }
    // Drop some links while keeping everything connected.
    const startId = 'n1';
    const connected = () => {
        const seen = new Set([startId]); const q = [startId];
        while (q.length) for (const l of nodes[q.shift()].links) if (!seen.has(l)) { seen.add(l); q.push(l); }
        return seen.size === cells.length;
    };
    const pairs = [];
    for (const n of Object.values(nodes)) for (const l of n.links) if (n.id < l) pairs.push([n.id, l]);
    for (const [a, b] of shuffle(s, pairs).slice(0, Math.floor(pairs.length * 0.28))) {
        nodes[a].links = nodes[a].links.filter(x => x !== b);
        nodes[b].links = nodes[b].links.filter(x => x !== a);
        if (!connected()) { nodes[a].links.push(b); nodes[b].links.push(a); }
    }
    // Distance from the start.
    const depth = { [startId]: 0 };
    const queue = [startId];
    while (queue.length) {
        const id = queue.shift();
        for (const l of nodes[id].links) if (depth[l] === undefined) { depth[l] = depth[id] + 1; queue.push(l); }
    }
    const maxDepth = Math.max(...Object.values(depth), 1);
    for (const id of Object.keys(nodes)) nodes[id].depth = depth[id] ?? 0;
    nodes[startId].type = 'start';
    nodes[startId].cost = 0;

    // Regions: the angle around the start decides the attribute of the area.
    const st = nodes[startId];
    const offset = nextRandom(s) * Math.PI * 2;
    const regionOf = (n) => {
        const ang = (Math.atan2(n.y - st.y, n.x - st.x) + Math.PI * 2 + offset) % (Math.PI * 2);
        return attrs[Math.floor((ang / (Math.PI * 2)) * attrs.length) % attrs.length];
    };
    for (const n of Object.values(nodes)) {
        n.region = n.id === startId ? null : regionOf(n);
        n.stat = n.region && nextRandom(s) < 0.78 ? n.region : pick(s, attrs);
        n.amount = 1;
    }

    // Spells, skills and passives: spread over the regions, never next to the start.
    const free = Object.values(nodes).filter(n => n.id !== startId && n.depth >= 2);
    const byRegion = {};
    for (const n of shuffle(s, free)) (byRegion[n.region] = byRegion[n.region] || []).push(n);
    const takeFrom = (count, spacing = 2) => {
        const out = [];
        let guard = 0;
        const order = shuffle(s, attrs);
        while (out.length < count && guard++ < 400) {
            const region = order[guard % order.length];
            const list = byRegion[region] || [];
            const i = list.findIndex(n => n.type === 'attr' && !out.some(o => Math.abs(o.x - n.x) + Math.abs(o.y - n.y) < spacing));
            if (i === -1) { if (guard > attrs.length * 12) break; continue; }
            out.push(list.splice(i, 1)[0]);
        }
        return out;
    };
    const takenRoles = new Set();
    const abilityNodes = takeFrom(z.abilities, 2);
    for (const n of abilityNodes) {
        const frac = n.depth / maxDepth;
        n.type = 'ability';
        n.slot = abilitySlot(s, n.region || n.stat, frac, takenRoles);
        n.cost = frac > 0.7 ? COSTS.abilityDeep : COSTS.ability;
        if (takenRoles.size >= 8) takenRoles.clear();
    }
    const passiveNodes = takeFrom(z.passives, 2);
    for (const n of passiveNodes) {
        const frac = n.depth / maxDepth;
        const main = n.region || n.stat;
        const deep = frac > 0.7;
        const second = pick(s, attrs.filter(a => a !== main).concat(attrs.length === 1 ? [main] : []));
        n.type = 'passive';
        n.cost = deep ? COSTS.passiveDeep : COSTS.passive;
        n.bonus = deep ? { [main]: 2 } : (second && second !== main ? { [main]: 1, [second]: 1 } : { [main]: 1 });
        n.stat = main;
    }
    const grid = {
        v: 1,
        seed: (seed >>> 0) || 1,
        size: GRID_SIZES[size] ? size : DEFAULT_SIZE,
        theme: String(theme || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        dressed: false,
        start: startId,
        nodes,
        unlocked: [startId],
    };
    return fillNames(grid);
}

/** Gives every spell, skill and passive a plain name where it has none. */
export function fillNames(grid) {
    const used = new Set(Object.values(grid.nodes).map(n => n.name).filter(Boolean));
    const uniq = (base) => { let name = base, i = 2; while (used.has(name)) name = `${base} ${i++}`; used.add(name); return name; };
    for (const n of Object.values(grid.nodes)) {
        if (n.type === 'ability') {
            if (!n.name) n.name = uniq(ROLE_NAMES[n.slot.role] || 'Technique');
            if (!n.icon) n.icon = ROLE_ICONS[n.slot.role] || '✨';
            if (!n.desc) n.desc = '';
        } else if (n.type === 'passive') {
            if (!n.name) n.name = uniq((GENERIC[n.stat]?.passive || ['Hardened']) [0]);
            if (!n.icon) n.icon = '🛡️';
            if (!n.desc) n.desc = '';
        }
    }
    return grid;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export const isUnlocked = (grid, id) => grid.unlocked.includes(id);

/** Nodes next to something already owned, that are not owned yet. */
export function reachable(grid) {
    const own = new Set(grid.unlocked);
    const out = new Set();
    for (const id of own) for (const l of grid.nodes[id]?.links || []) if (!own.has(l)) out.add(l);
    return [...out];
}

/**
 * Whether a node can be unlocked with `points` to spend.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function canUnlock(grid, id, points) {
    const n = grid.nodes[id];
    if (!n) return { ok: false, reason: 'No such node.' };
    if (isUnlocked(grid, id)) return { ok: false, reason: 'Already unlocked.' };
    if (!reachable(grid).includes(id)) return { ok: false, reason: 'It has to be next to something you have unlocked.' };
    if (points < n.cost) return { ok: false, reason: `It costs ${n.cost} point${n.cost === 1 ? '' : 's'}.` };
    return { ok: true };
}

/** What a node gives, as a line. */
export function describeNode(n) {
    if (n.type === 'start') return 'Where it begins.';
    if (n.type === 'attr') return `+${n.amount} ${String(n.stat).toUpperCase()}`;
    if (n.type === 'passive') return Object.entries(n.bonus || {}).map(([k, v]) => `${String(k).toUpperCase()} +${v}`).join(', ');
    if (n.type === 'ability') return n.slot.kind === 'spell' ? `Spell${n.slot.cost ? ` (${n.slot.cost} Mana)` : ''}` : 'Skill';
    return '';
}

/** The effects string of a passive node ("STR +1, CON +1"). */
export function passiveEffects(n) {
    return Object.entries(n.bonus || {}).map(([k, v]) => `${String(k).toUpperCase()} +${v}`).join(', ');
}

/** { unlocked, total, spent } for a summary line. */
export function gridProgress(grid) {
    const nodes = Object.values(grid.nodes);
    const own = nodes.filter(n => grid.unlocked.includes(n.id));
    return { unlocked: own.length, total: nodes.length, spent: own.reduce((a, n) => a + n.cost, 0) };
}

/**
 * Merges the AI's dressing: names, a sentence and an icon for the spells,
 * skills and passives. It cannot change what a node is or does.
 * @param {object} grid
 * @param {object} d - { nodes: { id: { name, description, icon } } }
 * @returns {number} how many nodes were dressed
 */
export function applyDressing(grid, d, cleanIcon = (x) => String(x || '').trim().slice(0, 4)) {
    const src = d && typeof d === 'object' ? (d.nodes && typeof d.nodes === 'object' ? d.nodes : d) : null;
    if (!src) return 0;
    const used = new Set();
    let count = 0;
    for (const n of Object.values(grid.nodes)) {
        if (n.type !== 'ability' && n.type !== 'passive') continue;
        const raw = src[n.id];
        if (!raw || typeof raw !== 'object') continue;
        const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
        if (!name || used.has(name.toLowerCase())) continue;
        used.add(name.toLowerCase());
        n.name = name;
        const desc = raw.description ?? raw.desc;
        if (typeof desc === 'string' && desc.trim()) n.desc = desc.replace(/\s+/g, ' ').trim().slice(0, 120);
        const icon = cleanIcon(raw.icon);
        if (icon) n.icon = icon;
        count++;
    }
    grid.dressed = count > 0;
    return count;
}
