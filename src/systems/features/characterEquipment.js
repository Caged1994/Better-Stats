/**
 * Character Equipment — storage and AI round-trip.
 *
 * Every character (persona and NPCs) carries items shown in the Stats panel.
 * Like current stat values, equipment belongs to the active Lore Library
 * campaign:
 *   extensionSettings.characterEquipment[campaignKey]["npc:Name"|"user:Name"] = [item, ...]
 *
 * The AI adds and removes items through an "equipment" key in the tracker
 * JSON. It can only remove items whose aiCanRemove is on; the others are
 * locked by the user. Swiping or regenerating a reply undoes its changes
 * (chat_metadata.dooms_tracker.equipmentUndo).
 *
 * The pure logic is in src/utils/equipmentModel.js.
 */
import { getContext } from '../../../../../../extensions.js';
import { chat, chat_metadata } from '../../../../../../../script.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import {
    MAX_ITEMS,
    makeItem,
    findItem,
    normalizeAIEquipment,
    planEquipmentChange,
    buildEquipmentPrompt,
    formatItems,
} from '../../utils/equipmentModel.js';
import {
    currentCampaignKey,
    getStatCharacters,
    statKey,
    isStatGenerationPending,
    notifyStatsChanged,
} from './characterStats.js';

// ─── Settings ───────────────────────────────────────────────────────────────

export function isEquipmentEnabled() {
    return extensionSettings.enabled !== false && extensionSettings.characterEquipmentEnabled !== false;
}

export function setEquipmentEnabled(on) {
    extensionSettings.characterEquipmentEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

// ─── Storage ────────────────────────────────────────────────────────────────

function bucket(campaignKey = currentCampaignKey(), create = false) {
    if (!extensionSettings.characterEquipment || typeof extensionSettings.characterEquipment !== 'object') {
        if (!create) return null;
        extensionSettings.characterEquipment = {};
    }
    const root = extensionSettings.characterEquipment;
    if (!root[campaignKey] || typeof root[campaignKey] !== 'object') {
        if (!create) return null;
        root[campaignKey] = {};
    }
    return root[campaignKey];
}

function findKey(obj, key) {
    if (!obj || !key) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
    const lower = key.toLowerCase();
    return Object.keys(obj).find(k => k.toLowerCase() === lower);
}

function listByKey(key, create = false) {
    const b = bucket(currentCampaignKey(), create);
    if (!b) return null;
    const k = findKey(b, key);
    if (k !== undefined) return b[k];
    if (!create) return null;
    b[key] = [];
    return b[key];
}

/** The character's items in the active campaign (live array). */
export function getEquipment(name, isUser = false) {
    const list = listByKey(statKey(name, isUser));
    return Array.isArray(list) ? list : [];
}

function changed(detail) {
    saveSettings();
    notifyStatsChanged({ source: 'equipment', ...detail });
}

/** Adds an item by hand. Returns the item or { error }. */
export function addItem(name, isUser, input) {
    const item = makeItem({ ...input, source: 'user' });
    if (!item) return { error: 'Give the item a name.' };
    const list = listByKey(statKey(name, isUser), true);
    if (findItem(list, item.name)) return { error: `${name} already has "${item.name}".` };
    if (list.length >= MAX_ITEMS) return { error: `At most ${MAX_ITEMS} items.` };
    list.push(item);
    changed({ name });
    return item;
}

export function updateItem(name, isUser, id, changes = {}) {
    const item = getEquipment(name, isUser).find(i => i.id === id);
    if (!item) return false;
    if (typeof changes.aiCanRemove === 'boolean') item.aiCanRemove = changes.aiCanRemove;
    if (typeof changes.desc === 'string') item.desc = changes.desc.trim().slice(0, 120);
    if (typeof changes.icon === 'string' && changes.icon.trim()) item.icon = makeItem({ name: 'x', icon: changes.icon }).icon;
    if (typeof changes.name === 'string' && changes.name.trim()) item.name = changes.name.trim().slice(0, 40);
    changed({ name });
    return true;
}

/** The user removes an item — locked or not. */
export function removeItem(name, isUser, id) {
    const list = listByKey(statKey(name, isUser));
    if (!list) return false;
    const i = list.findIndex(x => x.id === id);
    if (i === -1) return false;
    list.splice(i, 1);
    changed({ name });
    return true;
}

/** Forgets a deleted character's equipment, in every campaign. */
export function deleteEquipmentEverywhere(name, isUser = false) {
    const root = extensionSettings.characterEquipment;
    if (!root || !name) return;
    const key = statKey(name, isUser).toLowerCase();
    for (const b of Object.values(root)) {
        for (const k of Object.keys(b || {})) if (k.toLowerCase() === key) delete b[k];
    }
}

export function deleteCampaignEquipment(campaignId) {
    const root = extensionSettings.characterEquipment;
    if (root && campaignId && root[campaignId]) delete root[campaignId];
}

/** An alias merge: the variant's items join the canonical NPC's. */
export function mergeEquipment(canonical, variant) {
    const root = extensionSettings.characterEquipment;
    if (!root || !canonical || !variant) return;
    const vKey = statKey(variant, false);
    const cKey = statKey(canonical, false);
    for (const b of Object.values(root)) {
        const vk = findKey(b, vKey);
        if (vk === undefined) continue;
        const ck = findKey(b, cKey);
        const target = ck !== undefined ? b[ck] : (b[cKey] = []);
        for (const it of b[vk] || []) if (!findItem(target, it.name)) target.push(it);
        if (vk !== (ck ?? cKey)) delete b[vk];
    }
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export function buildEquipmentPromptForGeneration({ compact = true, standalone = false } = {}) {
    if (!isEquipmentEnabled()) return '';
    const entries = getStatCharacters().map(({ name, isUser }) => {
        const items = getEquipment(name, isUser);
        return { name, isUser, items, isNew: !isUser && !items.length && isStatGenerationPending(name, false) };
    });
    return buildEquipmentPrompt(entries, { compact, standalone });
}

export function buildEquipmentContextSummary() {
    if (!isEquipmentEnabled()) return '';
    const lines = getStatCharacters()
        .map(({ name, isUser }) => ({ name, items: getEquipment(name, isUser) }))
        .filter(e => e.items.length)
        .map(e => `${e.name} carries: ${formatItems(e.items)}`);
    return lines.length ? 'Equipment:\n' + lines.join('\n') : '';
}

// ─── Applying the AI's update ───────────────────────────────────────────────

/** Maps a name the AI used to a storage key (persona, alias, scene, or as given). */
function resolveTarget(name) {
    const lower = String(name).trim().toLowerCase();
    if (!lower) return null;
    let userName = '';
    try { userName = String(getContext().name1 || '').toLowerCase(); } catch (e) {}
    const scene = getStatCharacters();
    const persona = scene.find(c => c.isUser);
    if (persona && (persona.name.toLowerCase() === lower || lower === userName)) return { name: persona.name, isUser: true };
    const aliases = extensionSettings.characterAliases || {};
    for (const [canon, list] of Object.entries(aliases)) {
        if (Array.isArray(list) && list.some(a => String(a).toLowerCase() === lower)) return { name: canon, isUser: false };
    }
    const npc = scene.find(c => !c.isUser && c.name.toLowerCase() === lower);
    if (npc) return { name: npc.name, isUser: false };
    if (Object.keys(extensionSettings.userCharacters || {}).some(n => n.toLowerCase() === lower)) return null;
    return { name: String(name).trim(), isUser: false };
}

/**
 * Applies the AI's equipment changes for a fresh reply.
 * @returns {{added: number, removed: number, blocked: Array<{name: string, item: string}>}}
 */
export function applyAIEquipment(raw, messageIndex) {
    const result = { added: 0, removed: 0, blocked: [] };
    if (!isEquipmentEnabled() || raw === null || raw === undefined) return result;
    const undoAdded = [];
    const undoRemoved = [];
    for (const change of normalizeAIEquipment(raw)) {
        const target = resolveTarget(change.name);
        if (!target) continue;
        const key = statKey(target.name, target.isUser);
        const list = listByKey(key, true);
        const plan = planEquipmentChange(list, change);
        for (const item of plan.remove) {
            const i = list.findIndex(x => x.id === item.id);
            if (i === -1) continue;
            list.splice(i, 1);
            undoRemoved.push({ key, item, index: i });
            result.removed++;
        }
        for (const item of plan.add) {
            if (list.length >= MAX_ITEMS) break;
            list.push(item);
            undoAdded.push({ key, id: item.id });
            result.added++;
        }
        for (const item of plan.blocked) result.blocked.push({ name: target.name, item: item.name });
    }
    if (!result.added && !result.removed) return result;
    const campaign = currentCampaignKey();
    try {
        if (chat_metadata) {
            if (!chat_metadata.dooms_tracker) chat_metadata.dooms_tracker = {};
            const prev = chat_metadata.dooms_tracker.equipmentUndo;
            const same = prev && prev.messageIndex === messageIndex && prev.campaign === campaign;
            chat_metadata.dooms_tracker.equipmentUndo = {
                messageIndex,
                campaign,
                added: same ? [...prev.added, ...undoAdded] : undoAdded,
                removed: same ? [...prev.removed, ...undoRemoved] : undoRemoved,
            };
        }
    } catch (e) { /* undo is best-effort */ }
    changed({ source: 'ai' });
    return result;
}

/** Before a swipe/regenerate replaces a reply, undo its equipment changes. */
export function revertAIEquipmentForReplacedMessage(replacedIndex) {
    try {
        const rec = chat_metadata?.dooms_tracker?.equipmentUndo;
        if (!rec) return 0;
        const lastIdx = Array.isArray(chat) ? chat.length - 1 : -1;
        const idx = typeof replacedIndex === 'number' ? replacedIndex : lastIdx;
        if (rec.messageIndex !== idx && rec.messageIndex !== idx + 1) return 0;
        delete chat_metadata.dooms_tracker.equipmentUndo;
        if (rec.campaign !== currentCampaignKey()) return 0;
        let n = 0;
        for (const { key, id } of rec.added || []) {
            const list = listByKey(key);
            const i = list ? list.findIndex(x => x.id === id) : -1;
            if (i !== -1) { list.splice(i, 1); n++; }
        }
        // Put removed items back where they were (unless the user re-added one).
        for (const { key, item, index } of [...(rec.removed || [])].reverse()) {
            const list = listByKey(key, true);
            if (list.some(x => x.id === item.id) || findItem(list, item.name)) continue;
            list.splice(Math.min(index, list.length), 0, item);
            n++;
        }
        if (n) changed({ source: 'undo' });
        saveChatData();
        return n;
    } catch (e) {
        console.warn('[Dooms Tracker] Equipment: undo failed', e);
        return 0;
    }
}

/** Tells the user when the AI tried to take away a locked item. */
export function notifyBlockedRemovals(result) {
    const blocked = result && Array.isArray(result.blocked) ? result.blocked : [];
    if (!blocked.length) return;
    try {
        const list = blocked.map(b => `${b.name}: ${b.item}`).join(', ');
        window.toastr?.info(`The story tried to remove locked items (${list}). They were kept — remove them from the Stats panel if you agree.`, 'Equipment', { timeOut: 6000 });
    } catch (e) {}
}
