/**
 * Money — a currency per card, balances per chat.
 *
 * - Currency: extensionSettings.currencyByCard[cardKey] = { name, symbol }
 *   (cardKey from rpgMode.currentCardKey). Set it in Settings → RPG & Stats;
 *   when a card has none, the AI is asked to pick one fitting the setting
 *   ("currency" key) and its choice is kept.
 * - Balances, for the persona and the party members, in the open chat:
 *   chat_metadata.dooms_tracker.betterStats.characterMoney["user:Name"|"npc:Name"] = amount
 *   The AI gives a starting amount once and then changes it ("money" key);
 *   the user can set it in the Stats panel. A swipe puts back what the
 *   replaced reply changed (chat_metadata.dooms_tracker.moneyUndo).
 */
import { chat, chat_metadata } from '../../../../../../../script.js';
import { extensionSettings } from '../../core/state.js';
import { saveSettings, saveChatData } from '../../core/persistence.js';
import { isRpgModeActive, currentCardKey } from './rpgMode.js';
import { chatStore, saveChatScope, CHAT_SCOPE } from './chatScope.js';
import { statKey, notifyStatsChanged } from './characterStats.js';
import { resolveTarget } from './characterEquipment.js';
import { getPartyMembers } from './characterProgress.js';
import {
    roundMoney,
    normalizeCurrency,
    normalizeAIMoney,
    applyMoneyChange,
    buildMoneyPrompt,
    formatMoney,
} from '../../utils/moneyModel.js';

export function isMoneyEnabled() {
    return isRpgModeActive() && extensionSettings.characterMoneyEnabled !== false;
}

export function setMoneyEnabled(on) {
    extensionSettings.characterMoneyEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

// ─── Currency (per card) ────────────────────────────────────────────────────

export function getCurrency(cardKey = currentCardKey()) {
    const map = extensionSettings.currencyByCard;
    const c = cardKey && map && typeof map === 'object' ? map[cardKey] : null;
    return normalizeCurrency(c);
}

/** Sets (or, with null, clears) the current card's currency. */
export function setCurrency(currency, cardKey = currentCardKey()) {
    if (!cardKey) return null;
    if (!extensionSettings.currencyByCard || typeof extensionSettings.currencyByCard !== 'object') extensionSettings.currencyByCard = {};
    const c = currency ? normalizeCurrency(currency) : null;
    if (c) extensionSettings.currencyByCard[cardKey] = c;
    else delete extensionSettings.currencyByCard[cardKey];
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
    return c;
}

export function formatAmount(amount) {
    return formatMoney(amount, getCurrency());
}

// ─── Balances (per chat) ────────────────────────────────────────────────────

function store(create = false) {
    return chatStore('characterMoney', create);
}

function findKey(obj, key) {
    if (!obj || !key) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
    const lower = key.toLowerCase();
    return Object.keys(obj).find(k => k.toLowerCase() === lower);
}

/** The character's money, or null when none is set yet. */
export function getMoney(name, isUser = false) {
    const s = store();
    const k = findKey(s, statKey(name, isUser));
    const v = k !== undefined ? s[k] : null;
    return typeof v === 'number' ? v : null;
}

function write(name, isUser, amount) {
    const s = store(true);
    if (!s) return;
    const key = statKey(name, isUser);
    const k = findKey(s, key);
    if (amount === null) { if (k !== undefined) delete s[k]; return; }
    s[k !== undefined ? k : key] = amount;
}

/** Sets a balance by hand. Returns the stored amount. */
export function setMoney(name, isUser, amount) {
    const v = roundMoney(amount);
    if (v === null || !name) return null;
    write(name, isUser, Math.max(0, v));
    saveChatScope();
    notifyStatsChanged({ source: 'money', name });
    return Math.max(0, v);
}

/** Who has a purse: the persona and the party members. */
export function moneyHolders() {
    return getPartyMembers();
}

export function hasPurse(name, isUser) {
    const lower = String(name).toLowerCase();
    return moneyHolders().some(m => m.isUser === !!isUser && m.name.toLowerCase() === lower);
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export function buildMoneyPromptForGeneration({ compact = true, standalone = false } = {}) {
    if (!isMoneyEnabled()) return '';
    const members = moneyHolders();
    const holders = members.filter(m => getMoney(m.name, m.isUser) !== null).map(m => ({ ...m, amount: getMoney(m.name, m.isUser) }));
    const needStart = members.filter(m => getMoney(m.name, m.isUser) === null).map(m => m.name);
    // No card open: there is nowhere to keep a currency, so don't ask for one.
    const currency = getCurrency() || (currentCardKey() ? null : { name: 'money', symbol: '' });
    return buildMoneyPrompt({ currency, holders, needStart, compact, standalone });
}

export function buildMoneyContextSummary() {
    if (!isMoneyEnabled()) return '';
    const items = moneyHolders().filter(m => getMoney(m.name, m.isUser) !== null)
        .map(m => `${m.name} ${formatAmount(getMoney(m.name, m.isUser))}`);
    return items.length ? 'Money: ' + items.join(', ') : '';
}

// ─── Applying the AI's update ───────────────────────────────────────────────

/** The "currency" a fresh reply proposed, kept only when the card has none. */
export function applyAICurrency(raw) {
    if (!isMoneyEnabled() || raw === null || raw === undefined || getCurrency() || !currentCardKey()) return null;
    const c = normalizeCurrency(raw);
    if (!c) return null;
    console.log(`[Dooms Tracker] Money: currency set to ${c.name}${c.symbol ? ` (${c.symbol})` : ''}`);
    return setCurrency(c);
}

/**
 * Applies the "money" of a fresh reply: a starting amount only for someone
 * without one, a change for someone with one. Only the persona and party
 * members have money.
 * @returns {number} balances changed
 */
export function applyAIMoney(raw, messageIndex) {
    if (!isMoneyEnabled() || raw === null || raw === undefined) return 0;
    const snapshots = [];
    for (const change of normalizeAIMoney(raw)) {
        const target = resolveTarget(change.name);
        if (!target || !hasPurse(target.name, target.isUser)) continue;
        const before = getMoney(target.name, target.isUser);
        if (change.set !== undefined && before !== null) continue; // starting amount only once
        const after = applyMoneyChange(before ?? 0, change);
        if (after === null || after === before) continue;
        write(target.name, target.isUser, after);
        const key = statKey(target.name, target.isUser);
        const prev = snapshots.find(x => x.key === key);
        if (prev) prev.after = after;
        else snapshots.push({ key, name: target.name, isUser: target.isUser, before, after });
    }
    console.log(`[Dooms Tracker] Money: ${snapshots.length} balance(s) changed`);
    if (!snapshots.length) return 0;
    try {
        if (chat_metadata) {
            if (!chat_metadata.dooms_tracker) chat_metadata.dooms_tracker = {};
            const prev = chat_metadata.dooms_tracker.moneyUndo;
            let snaps = snapshots;
            if (prev && prev.messageIndex === messageIndex && Array.isArray(prev.snapshots)) {
                snaps = prev.snapshots.map(p => ({ ...p }));
                for (const sn of snapshots) {
                    const old = snaps.find(x => x.key === sn.key);
                    if (old) old.after = sn.after;
                    else snaps.push(sn);
                }
            }
            chat_metadata.dooms_tracker.moneyUndo = { messageIndex, campaign: CHAT_SCOPE, snapshots: snaps };
        }
    } catch (e) { /* undo is best-effort */ }
    saveChatScope();
    notifyStatsChanged({ source: 'ai' });
    return snapshots.length;
}

export function revertAIMoneyForReplacedMessage(replacedIndex) {
    try {
        const rec = chat_metadata?.dooms_tracker?.moneyUndo;
        if (!rec) return 0;
        const lastIdx = Array.isArray(chat) ? chat.length - 1 : -1;
        const idx = typeof replacedIndex === 'number' ? replacedIndex : lastIdx;
        if (rec.messageIndex !== idx && rec.messageIndex !== idx + 1) return 0;
        delete chat_metadata.dooms_tracker.moneyUndo;
        let n = 0;
        for (const { name, isUser, before, after } of rec.snapshots || []) {
            if (getMoney(name, isUser) !== after) continue;
            write(name, isUser, before);
            n++;
        }
        if (n) {
            saveChatScope();
            notifyStatsChanged({ source: 'undo' });
        }
        saveChatData();
        return n;
    } catch (e) {
        console.warn('[Dooms Tracker] Money: undo failed', e);
        return 0;
    }
}

export function deleteMoney(name, isUser = false) {
    write(name, isUser, null);
}
