/**
 * Character Equipment — pure model.
 *
 * Every character (persona and NPCs) carries a list of items shown in the
 * Stats panel: an emoji icon, a name and a very short description. The AI
 * can add items and remove the ones the user allows it to (aiCanRemove);
 * items the user locked can only be removed by the user.
 *
 * Item shape: { id, icon, name, desc, aiCanRemove, source: 'ai'|'user', createdAt }
 */

export const ITEM_NAME_MAX = 40;
export const ITEM_DESC_MAX = 120;
export const DEFAULT_ICON = '📦';
export const LOCK_MARK = '🔒';
export const MAX_ITEMS = 40;

/** Emoji offered in the panel's quick picker. */
export const ITEM_EMOJI = [
    '🗡️', '⚔️', '🏹', '🪓', '🔨', '🛡️', '🪖', '🥾', '🧥', '👕', '💍', '📿',
    '🎒', '👜', '💰', '🪙', '🗝️', '🔑', '📜', '📖', '🗺️', '🧭', '🔦', '🕯️',
    '🧪', '💊', '🩹', '🍞', '🍖', '🍎', '💧', '🍷', '🔫', '💣', '📱', '💻',
    '🔮', '🪄', '💎', '🎵', '🧰', '🪢', '⛺', '🔥', '🐎', '✉️', '🎫', '📦',
];

let idCounter = 0;
export function newItemId() {
    idCounter = (idCounter + 1) % 1000;
    return 'itm_' + Date.now().toString(36) + '_' + idCounter.toString(36) + Math.random().toString(36).slice(2, 5);
}

function clip(text, max) {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/** The first emoji-ish glyph of the input, or the default box. */
export function cleanIcon(icon) {
    const s = String(icon ?? '').trim();
    if (!s) return DEFAULT_ICON;
    // Keep one grapheme (emoji + variation selector / ZWJ sequence).
    let out = '';
    try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        const first = seg.segment(s)[Symbol.iterator]().next().value;
        out = first ? first.segment : '';
    } catch (e) {
        out = Array.from(s).slice(0, 2).join('');
    }
    // Letters are not icons.
    if (!out || /^[\p{L}\p{N}]/u.test(out)) return DEFAULT_ICON;
    return out;
}

/** Comparison key for item names. */
export function itemKey(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

export function findItem(list, name) {
    const k = itemKey(splitLeadingEmoji(name).name);
    if (!k) return null;
    return (list || []).find(i => itemKey(i.name) === k) || null;
}

/**
 * "⚡ Electric stone" → { icon: '⚡', name: 'Electric stone' }. A name that
 * does not start with an emoji is returned unchanged with no icon.
 */
export function splitLeadingEmoji(text) {
    const s = String(text ?? '').trim();
    const m = s.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.*)$/u);
    if (m && m[2]) return { icon: m[1], name: m[2] };
    return { icon: '', name: s };
}

/** Builds an item, or null without a name. */
export function makeItem({ icon, name, desc, aiCanRemove = true, source = 'user' } = {}) {
    // An emoji written in front of the name becomes the icon.
    const split = splitLeadingEmoji(name);
    const n = clip(split.name, ITEM_NAME_MAX);
    if (!n) return null;
    return {
        id: newItemId(),
        icon: cleanIcon(String(icon ?? '').trim() ? icon : split.icon),
        name: n,
        desc: clip(desc, ITEM_DESC_MAX),
        aiCanRemove: aiCanRemove !== false,
        source,
        createdAt: Date.now(),
    };
}

/**
 * Normalises the AI's "equipment" value into [{ name, add: [...], remove: [...] }].
 * Accepts, per character:
 *   { "add": [{icon,name,desc} | "⚡ name"], "remove": ["name"] }   (the asked-for shape)
 *   ["⚡ name", {icon,name,desc}, ...]                              (a plain list → added)
 *   { "items" | "inventory" | "equipment" | "carries": [...] }       (→ added)
 * and the list form [{ "name": "Name", "add": [...], "remove": [...] }].
 * Lists are only ever ADDED: an item missing from a list is never removed,
 * because a list may be partial.
 */
export function normalizeAIEquipment(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    const toAdd = (v) => {
        if (typeof v === 'string') return { name: v };
        if (v && typeof v === 'object') return { icon: v.icon ?? v.emoji, name: v.name ?? v.item ?? v.title, desc: v.desc ?? v.description ?? v.note };
        return null;
    };
    const toName = (v) => {
        const raw = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.name ?? v.item) : null);
        return typeof raw === 'string' ? splitLeadingEmoji(raw).name : null;
    };
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
    const out = [];
    const push = (name, val) => {
        if (typeof name !== 'string' || !name.trim() || !val || typeof val !== 'object') return;
        if (Array.isArray(val)) val = { add: val };
        const listed = val.add ?? val.added ?? val.gain ?? val.gained ?? val.items ?? val.inventory ?? val.equipment ?? val.carries ?? val.carried;
        const add = arr(listed).map(toAdd).filter(a => a && typeof a.name === 'string' && a.name.trim());
        const remove = arr(val.remove ?? val.removed ?? val.lose).map(toName).filter(n => typeof n === 'string' && n.trim());
        if (add.length || remove.length) out.push({ name: name.trim(), add, remove });
    };
    if (Array.isArray(data)) {
        for (const item of data) if (item && typeof item === 'object') push(item.name, item);
        return out;
    }
    for (const [name, val] of Object.entries(data)) push(name, val);
    return out;
}

/** Item names already carried, for "is this an add?" checks. */
export function sameItemName(a, b) {
    return itemKey(splitLeadingEmoji(a).name) === itemKey(splitLeadingEmoji(b).name);
}

/**
 * What an AI update does to one character's list.
 * @returns {{ add: object[], remove: object[], blocked: object[] }}
 *   add: new items (not already carried); remove: carried items the AI may
 *   remove; blocked: carried items the AI tried to remove but are locked.
 */
export function planEquipmentChange(list, change) {
    const current = Array.isArray(list) ? list : [];
    const out = { add: [], remove: [], blocked: [] };
    const removing = new Set();
    for (const name of change.remove || []) {
        const item = findItem(current, name);
        if (!item || removing.has(item.id)) continue;
        if (item.aiCanRemove === false) out.blocked.push(item);
        else { out.remove.push(item); removing.add(item.id); }
    }
    const seen = new Set(current.filter(i => !removing.has(i.id)).map(i => itemKey(i.name)));
    for (const a of change.add || []) {
        const item = makeItem({ ...a, source: 'ai', aiCanRemove: true });
        if (!item) continue;
        const k = itemKey(item.name);
        if (!k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.add.push(item);
    }
    return out;
}

/** "🗡️ Iron sword, 🔒🛡️ Oak shield" */
export function formatItems(list) {
    return (list || []).map(i => `${i.aiCanRemove === false ? LOCK_MARK : ''}${i.icon || DEFAULT_ICON} ${i.name}`).join(', ');
}

/**
 * The prompt section for the characters in the scene.
 * Entries with `needsGear` have an empty list nobody has filled yet: the AI
 * is asked, once, to add what they already carry (from their description,
 * the persona description, or the scene).
 * @param {Array<{name: string, isUser: boolean, items: object[], needsGear?: boolean}>} entries
 * @param {{compact?: boolean, standalone?: boolean}} [options]
 */
export function buildEquipmentPrompt(entries, { compact = true, standalone = false } = {}) {
    const list = (entries || []).filter(e => e && e.name);
    if (!list.length) return '';
    const lines = list.map(e => `- ${e.name}${e.isUser ? ' (player character)' : ''}: ${e.items.length ? formatItems(e.items) : 'nothing listed yet'}`);
    const seed = list.filter(e => e.needsGear).map(e => e.name);
    const player = list.find(e => e.isUser)?.name;
    const example = JSON.stringify({ equipment: { [list[0].name]: { add: [{ icon: '🗡️', name: 'Iron sword', desc: 'Plain soldier\'s blade' }], remove: ['Torch'] } } });
    const where = standalone ? 'start your reply with ONE JSON code block' : 'add an "equipment" key to the same tracker JSON object';
    let out = compact
        ? 'EQUIPMENT (what each carries):\n'
        : 'EQUIPMENT — what each character currently carries or wears:\n';
    out += lines.join('\n') + '\n';
    const playerNote = player
        ? (compact
            ? ` — including anything ${player} takes out or uses in the user's message, even if never mentioned before`
            : `. This includes anything ${player} takes out, shows or uses in the user's message, even if it was never mentioned before — the user decides what their character carries`)
        : '';
    out += compact
        ? `Keep the lists true to the story. When someone gains an item (picks up, buys, is given) or is shown already having, wearing or using one that is not listed${playerNote}, or loses one (drops, gives away, breaks, uses up), ${where}: ${example} — one emoji, a short name, a desc under 8 words. ${LOCK_MARK} items can never be removed. Omit the key when nothing changes.`
        : `EQUIPMENT CHANGES: keep these lists true to the story. Add an item when a character gains it — picks it up, buys it, is given it — or when the story shows them already having, wearing or using something that is not listed yet${playerNote}. Remove an item when they drop it, give it away, break it or use it up. Write the change with ${where}, like ${example}. Each new item has one emoji icon, a short name and a description under 8 words. Remove items by their exact name. Items marked ${LOCK_MARK} are fixed by the user and must never be removed. Leave the key out entirely when nothing changes.`;
    if (seed.length) {
        out += compact
            ? `\nSTARTING GEAR: add what ${seed.join(', ')} already ${seed.length === 1 ? 'carries' : 'carry'} and ${seed.length === 1 ? 'wears' : 'wear'} now, from their description and the scene (a few key items).`
            : `\nSTARTING GEAR: ${seed.join(', ')} ${seed.length === 1 ? 'has' : 'have'} no equipment listed yet. Add what they already carry and wear right now, based on their character description (or persona description) and the scene — a few key items, not every trinket.`;
    }
    return out.trim();
}
