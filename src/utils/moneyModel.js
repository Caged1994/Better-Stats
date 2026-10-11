/**
 * Money — pure model.
 *
 * The currency belongs to the card (a fantasy card uses gold crowns, a
 * modern one euros, a sci‑fi one credits): { name, symbol }. Balances are
 * plain numbers with at most two decimals.
 */

export const MONEY_MAX = 1e12;

export function roundMoney(v) {
    let t = v;
    if (typeof t === 'string') {
        t = t.replace(/−/g, '-').replace(/[^\d.,\-+]/g, '');
        t = t.includes('.') ? t.replace(/,/g, '') : t.replace(',', '.');
    }
    if (t === '' || t === '-' || t === '+' || t === null || t === undefined || typeof t === 'boolean') return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.round(Math.max(-MONEY_MAX, Math.min(MONEY_MAX, n)) * 100) / 100;
}

/** A clean { name, symbol } or null. */
export function normalizeCurrency(raw) {
    let v = raw;
    if (typeof v === 'string') {
        const t = v.trim();
        if (t.startsWith('{')) { try { v = JSON.parse(t); } catch (e) { /* keep text */ } }
    }
    if (typeof v === 'string') {
        const name = v.trim().slice(0, 30);
        return name ? { name, symbol: '' } : null;
    }
    if (!v || typeof v !== 'object') return null;
    const name = String(v.name ?? v.currency ?? v.plural ?? '').trim().slice(0, 30);
    const symbol = String(v.symbol ?? v.sign ?? v.abbr ?? '').trim().slice(0, 6);
    if (!name && !symbol) return null;
    return { name: name || symbol, symbol };
}

/** "150 €", "1,250.50 credits" */
export function formatMoney(amount, currency) {
    const n = Number(amount) || 0;
    const num = n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
    if (!currency) return num;
    return currency.symbol ? `${num} ${currency.symbol}` : `${num} ${currency.name}`;
}

/**
 * The AI's "money" value → [{ name, set?, delta?, reason }].
 * {"Mastera": -12}, {"Mastera": "+5.50"}, {"Mastera": {"set": 150}},
 * {"Mastera": {"change": -3, "reason": "Coffee"}}, [{"name": …}].
 */
export function normalizeAIMoney(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) { return []; }
    }
    if (!data || typeof data !== 'object') return [];
    const out = [];
    const push = (name, val) => {
        if (typeof name !== 'string' || !name.trim()) return;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const reason = typeof (val.reason ?? val.for) === 'string' ? String(val.reason ?? val.for).slice(0, 100) : '';
            const set = val.set ?? val.start ?? val.balance ?? val.total;
            const delta = val.change ?? val.delta ?? val.add ?? val.amount;
            if (delta !== undefined && roundMoney(delta) !== null) out.push({ name: name.trim(), delta: roundMoney(delta), reason });
            else if (set !== undefined && roundMoney(set) !== null) out.push({ name: name.trim(), set: roundMoney(set), reason });
            return;
        }
        const d = roundMoney(val);
        if (d !== null) out.push({ name: name.trim(), delta: d, reason: '' });
    };
    if (Array.isArray(data)) {
        for (const e of data) if (e && typeof e === 'object') push(e.name ?? e.character, e);
    } else {
        for (const [k, v] of Object.entries(data)) push(k, v);
    }
    return out;
}

/** New balance after one change (never below 0 by spending). */
export function applyMoneyChange(current, change) {
    if (change.set !== undefined) return Math.max(0, change.set);
    return Math.max(0, roundMoney((current || 0) + (change.delta || 0)));
}

/**
 * The prompt section.
 * @param {{name, symbol}|null} currency - null: the AI is asked to pick one
 * @param {Array<{name, isUser, amount}>} holders - with a balance
 * @param {string[]} needStart - without one yet
 */
export function buildMoneyPrompt({ currency, holders = [], needStart = [], compact = true, standalone = false } = {}) {
    if (!holders.length && !needStart.length) return '';
    const where = standalone ? 'start your reply with ONE JSON code block with' : 'add to the same tracker JSON object';
    const unit = currency ? (currency.symbol ? `${currency.name}, ${currency.symbol}` : currency.name) : '';
    let out = `MONEY${unit ? ` (${unit})` : ''}:`;
    out += holders.length ? ' ' + holders.map(h => `${h.name} ${formatMoney(h.amount, currency)}`).join(', ') + '.\n' : '\n';
    out += compact
        ? `When someone pays, earns, finds, loses or is given money, ${where} "money": {"Name": -12} (the change; a starting amount as {"set": 150}). Nobody spends more than they have. Leave it out when nothing changes.`
        : `When one of them pays for something, earns, finds, wins, loses or is given money, ${where} "money": {"Name": -12} with the CHANGE in the currency above (negative to spend). Prices must fit the setting, and nobody can spend more than they have. Leave the key out when no money changes hands.`;
    if (!currency) {
        out += `\nCURRENCY: none chosen yet — add "currency": {"name": "euro", "symbol": "€"} with the one that fits this setting (euro, dollars, credits, gold crowns…).`;
    }
    if (needStart.length) {
        out += `\nSTARTING MONEY: give ${needStart.join(', ')} what they have now, from their description and the setting: "money": {${needStart.map(n => `"${n}": {"set": 100}`).join(', ')}}.`;
    }
    return out.trim();
}
