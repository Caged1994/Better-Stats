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
    const k = itemKey(name);
    if (!k) return null;
    return (list || []).find(i => itemKey(i.name) === k) || null;
}

/** Builds an item, or null without a name. */
export function makeItem({ icon, name, desc, aiCanRemove = true, source = 'user' } = {}) {
    const n = clip(name, ITEM_NAME_MAX);
    if (!n) return null;
    return {
        id: newItemId(),
        icon: cleanIcon(icon),
        name: n,
        desc: clip(desc, ITEM_DESC_MAX),
        aiCanRemove: aiCanRemove !== false,
        source,
        createdAt: Date.now(),
    };
}

/**
 * Normalises the AI's "equipment" value into [{ name, add: [...], remove: [...] }].
 * Accepts { "Name": { "add": [{icon,name,desc}|"name"], "remove": ["name"] } }
 * and [{ "name": "Name", "add": [...], "remove": [...] }].
 */
export function normalizeAIEquipment(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    const toAdd = (v) => {
        if (typeof v === 'string') return { name: v };
        if (v && typeof v === 'object') return { icon: v.icon ?? v.emoji, name: v.name ?? v.item, desc: v.desc ?? v.description };
        return null;
    };
    const toName = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.name ?? v.item) : null));
    const arr = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
    const out = [];
    const push = (name, val) => {
        if (typeof name !== 'string' || !name.trim() || !val || typeof val !== 'object' || Array.isArray(val)) return;
        const add = arr(val.add ?? val.added ?? val.gain).map(toAdd).filter(a => a && typeof a.name === 'string' && a.name.trim());
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
 * @param {Array<{name: string, isUser: boolean, items: object[], isNew?: boolean}>} entries
 * @param {{compact?: boolean, standalone?: boolean}} [options]
 */
export function buildEquipmentPrompt(entries, { compact = true, standalone = false } = {}) {
    const list = (entries || []).filter(e => e && e.name);
    if (!list.length) return '';
    const lines = list.map(e => `- ${e.name}${e.isUser ? ' (player character)' : ''}: ${e.items.length ? formatItems(e.items) : 'nothing'}`);
    const fresh = list.filter(e => e.isNew).map(e => e.name);
    const example = JSON.stringify({ equipment: { [list[0].name]: { add: [{ icon: '🗡️', name: 'Iron sword', desc: 'Plain soldier\'s blade' }], remove: ['Torch'] } } });
    const where = standalone ? 'start your reply with ONE JSON code block' : 'add an "equipment" key to the same tracker JSON object';
    let out = compact
        ? 'EQUIPMENT (what each carries):\n'
        : 'EQUIPMENT — what each character currently carries or wears:\n';
    out += lines.join('\n') + '\n';
    out += compact
        ? `Only when someone gains or loses an item (picks up, buys, is given, drops, breaks, uses up), ${where}: ${example} — one emoji, a short name, a desc under 8 words. ${LOCK_MARK} items can never be removed. Omit the key when nothing changes.`
        : `EQUIPMENT CHANGES: only when a character gains or loses an item — picks it up, buys it, is given it, drops it, gives it away, breaks it or uses it up — ${where}, like ${example}. Each new item has one emoji icon, a short name and a description under 8 words. Remove items by their exact name. Items marked ${LOCK_MARK} are fixed by the user and must never be removed. Leave the key out entirely when nothing changes.`;
    if (fresh.length) {
        out += compact
            ? `\nNEW: also add the visible gear ${fresh.join(', ')} ${fresh.length === 1 ? 'carries' : 'carry'} (a few items).`
            : `\nNEW CHARACTERS: also add the visible gear ${fresh.join(', ')} ${fresh.length === 1 ? 'carries' : 'carry'} right now (a few key items, not every trinket).`;
    }
    return out.trim();
}
