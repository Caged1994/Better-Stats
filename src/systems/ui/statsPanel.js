/**
 * Stats Panel — live view of a character's stats.
 *
 * Opened from the portrait right-click menu ("Stats"). Shows the states as
 * rings and the attributes as score tiles for the active campaign's current
 * values, with a tab per character in the scene (the player's persona
 * first). Values can be edited by clicking them.
 *
 * The panel floats over SillyTavern and can be popped out into its own
 * browser window. The pop-out is a same-origin about:blank window that this
 * module renders into directly, so both views share one state and repaint
 * together on every STATS_CHANGED_EVENT — no messaging layer needed.
 */
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { ensureCss } from '../../core/cssLoader.js';
import { extensionFolderPath } from '../../core/config.js';
import { escapeHtml } from '../../utils/html.js';
import { ringColor, activeStats, HUMAN_AVERAGE, HUMAN_PEAK } from '../../utils/statsModel.js';
import {
    STATS_CHANGED_EVENT,
    getStatSheet,
    getCurrentStatValues,
    setCurrentStatValue,
    resetCurrentStatValues,
    currentCampaignKey,
    isStatGenerationPending,
    getPersonaName,
} from '../features/characterStats.js';
import { getCharacterList, resolveActiveUserName, resolvePortrait } from './portraitBar.js';
import { getEquipment, addItem, updateItem, removeItem, isEquipmentEnabled } from '../features/characterEquipment.js';
import { ITEM_EMOJI, DEFAULT_ICON } from '../../utils/equipmentModel.js';

const PANEL_ID = 'dooms-stats-panel';
const POPOUT_NAME = 'dooms-stats-popout';
const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

let selected = null;          // { name, isUser }
let popoutWin = null;         // Window | null
let listenersBound = false;
let pendingRender = false;    // a repaint skipped while a value was being typed
// The "Add item" form survives repaints (an AI update can land while typing).
const itemForm = { open: false, icon: '', name: '', desc: '', aiCanRemove: true, error: '' };

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Opens the Stats panel on a character. If the pop-out window is open, the
 * character is shown there instead and the window is focused.
 * @param {string} name
 * @param {boolean} [isUser]
 */
export async function openStatsPanel(name, isUser = false) {
    if (!name) return;
    selected = { name, isUser: !!isUser };
    bindGlobalListeners();
    if (isPopoutOpen()) {
        renderAll();
        try { popoutWin.focus(); } catch (e) {}
        return;
    }
    try { await ensureCss('stats-panel'); } catch (e) { /* render unstyled rather than not at all */ }
    const panel = ensureInlinePanel();
    panel.hidden = false;
    renderAll();
}

export function closeStatsPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
}

// ─── Data for a render ──────────────────────────────────────────────────────

/** Persona first, then present NPCs, then whoever is selected if missing. */
function characterTabs() {
    const tabs = [];
    const seen = new Set();
    const push = (name, isUser) => {
        const k = `${isUser ? 'u' : 'n'}:${String(name).toLowerCase()}`;
        if (!name || seen.has(k)) return;
        seen.add(k);
        tabs.push({ name, isUser });
    };
    let persona = null;
    try { persona = resolveActiveUserName() || getPersonaName(); } catch (e) {}
    if (persona) push(persona, true);
    try {
        for (const c of getCharacterList()) {
            if (c && c.present && !c.isUser) push(c.name, false);
        }
    } catch (e) { /* portrait bar not ready */ }
    if (selected) push(selected.name, selected.isUser);
    return tabs;
}

function campaignLabel() {
    const key = currentCampaignKey();
    const c = extensionSettings.lorebook?.campaigns?.[key];
    return c ? c.name : '';
}

/** Absolute URL so the pop-out (about:blank) resolves it the same way. */
function absoluteUrl(src) {
    if (!src) return '';
    if (/^(data:|blob:|https?:)/i.test(src)) return src;
    try { return new URL(src, document.baseURI).href; } catch (e) { return src; }
}

function portraitFor(name) {
    try { return absoluteUrl(resolvePortrait(name)); } catch (e) { return ''; }
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

// ─── Markup ─────────────────────────────────────────────────────────────────

function avatarHtml(name, cls) {
    const src = portraitFor(name);
    // A portrait that fails to load falls back to the initials.
    const fallback = "const s=this.ownerDocument.createElement('span');s.className=this.className+' is-initials';s.textContent=this.dataset.initials;this.replaceWith(s);";
    return src
        ? `<img class="${cls}" src="${escapeHtml(src)}" alt="" draggable="false" data-initials="${escapeHtml(initials(name))}" onerror="${escapeHtml(fallback)}">`
        : `<span class="${cls} is-initials">${escapeHtml(initials(name))}</span>`;
}

function aiBadge(stat) {
    return stat.ai
        ? '<span class="dsp-ai" title="The AI updates this stat"><i class="fa-solid fa-robot"></i></span>'
        : '<span class="dsp-ai is-manual" title="Changed by hand only — the AI just reads it"><i class="fa-solid fa-lock"></i></span>';
}

function ringHtml(stat, value) {
    const pct = Math.max(0, Math.min(100, value));
    const color = ringColor(stat, value);
    const offset = RING_C * (1 - pct / 100);
    const low = color !== stat.color ? ' is-low' : '';
    const tip = stat.description ? `${stat.name}: ${stat.description}` : stat.name;
    return `
        <div class="dsp-ring${low}" data-stat="${escapeHtml(stat.id)}" style="--dsp-color:${escapeHtml(color)}" title="${escapeHtml(tip)}">
            <svg viewBox="0 0 84 84" aria-hidden="true">
                <circle class="dsp-ring-track" cx="42" cy="42" r="${RING_R}"></circle>
                <circle class="dsp-ring-fill" cx="42" cy="42" r="${RING_R}"
                    stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
            </svg>
            <div class="dsp-ring-center">
                <span class="dsp-ring-name">${escapeHtml(stat.name)}</span>
                <button type="button" class="dsp-value" data-stat="${escapeHtml(stat.id)}" title="Click to edit">${value}%</button>
            </div>
            ${aiBadge(stat)}
        </div>`;
}

/** Where an attribute sits on the human scale. */
function attrTier(value) {
    if (value > HUMAN_PEAK) return { cls: ' is-super', label: 'superhuman' };
    if (value === HUMAN_PEAK) return { cls: ' is-peak', label: 'human peak' };
    if (value < HUMAN_AVERAGE) return { cls: ' is-weak', label: 'below average' };
    return { cls: '', label: value === HUMAN_AVERAGE ? 'average' : 'above average' };
}

function attrHtml(stat, value) {
    const tier = attrTier(value);
    const tip = `${stat.name} ${value} (${tier.label})${stat.description ? ` — ${stat.description}` : ''}`;
    // The bar fills at the human peak; superhuman values glow instead.
    const width = Math.max(3, Math.min(100, (value / HUMAN_PEAK) * 100));
    return `
        <div class="dsp-attr${tier.cls}" data-stat="${escapeHtml(stat.id)}" title="${escapeHtml(tip)}">
            <div class="dsp-attr-head">
                <span class="dsp-attr-abbr">${escapeHtml(stat.abbr || stat.name)}</span>
                ${aiBadge(stat)}
            </div>
            <button type="button" class="dsp-value dsp-attr-value" data-stat="${escapeHtml(stat.id)}" title="Click to edit">${value}</button>
            <div class="dsp-attr-bar"><span style="width:${width.toFixed(1)}%"></span></div>
            ${stat.abbr ? `<span class="dsp-attr-name">${escapeHtml(stat.name)}</span>` : ''}
        </div>`;
}

function buildHtml({ popout }) {
    const tabs = characterTabs();
    if (!selected && tabs.length) selected = tabs[0];
    const campaign = campaignLabel();
    const head = `
        <header class="dsp-head" data-drag-handle>
            <span class="dsp-title"><i class="fa-solid fa-chart-simple"></i> Stats</span>
            ${campaign ? `<span class="dsp-campaign" title="Current values belong to the active campaign">${escapeHtml(campaign)}</span>` : ''}
            <span class="dsp-spacer"></span>
            ${popout
                ? '<button type="button" class="dsp-icon-btn" data-action="dock" title="Back into SillyTavern"><i class="fa-solid fa-down-left-and-up-right-to-center"></i></button>'
                : '<button type="button" class="dsp-icon-btn" data-action="popout" title="Open in a separate window"><i class="fa-solid fa-up-right-from-square"></i></button>'}
            ${popout ? '' : '<button type="button" class="dsp-icon-btn" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>'}
        </header>`;

    if (!selected) {
        return head + '<div class="dsp-empty">No characters in the scene yet.</div>';
    }

    const tabsHtml = tabs.length > 1 ? `
        <nav class="dsp-tabs" role="tablist" aria-label="Characters">
            ${tabs.map(t => {
                const on = t.name === selected.name && t.isUser === selected.isUser;
                return `<button type="button" role="tab" class="dsp-tab${on ? ' is-active' : ''}" aria-selected="${on}"
                    data-name="${escapeHtml(t.name)}" data-user="${t.isUser ? '1' : '0'}" title="${escapeHtml(t.name)}">
                    ${avatarHtml(t.name, 'dsp-tab-avatar')}
                    <span class="dsp-tab-name">${escapeHtml(t.name)}</span>
                    ${t.isUser ? '<span class="dsp-you">YOU</span>' : ''}
                </button>`;
            }).join('')}
        </nav>` : '';

    // Stats switched off in Settings are not shown.
    const stats = activeStats(getStatSheet(selected.name, selected.isUser));
    const cur = getCurrentStatValues(selected.name, selected.isUser, stats);
    const states = stats.filter(s => s.kind === 'state');
    const attrs = stats.filter(s => s.kind === 'attribute');

    return `
        ${head}
        ${tabsHtml}
        <div class="dsp-body">
            <section class="dsp-hero">
                ${avatarHtml(selected.name, 'dsp-hero-avatar')}
                <div class="dsp-hero-text">
                    <span class="dsp-hero-name">${escapeHtml(selected.name)}</span>
                    <span class="dsp-hero-sub">${selected.isUser ? 'Your character' : 'Character'}${campaign ? ` · ${escapeHtml(campaign)}` : ''}</span>
                </div>
                <button type="button" class="dsp-text-btn" data-action="reset" title="Put every value back to the starting values set in the Workshop">
                    <i class="fa-solid fa-rotate-left"></i> Reset
                </button>
            </section>
            ${isStatGenerationPending(selected.name, selected.isUser) ? `
            <div class="dsp-pending"><i class="fa-solid fa-wand-magic-sparkles"></i>
                The AI will generate ${escapeHtml(selected.name)}'s stats to fit who they are in their next reply. Until then these are placeholders.</div>` : ''}
            ${states.length ? `<section class="dsp-section">
                <h3 class="dsp-section-title">Stats</h3>
                <div class="dsp-rings">${states.map(s => ringHtml(s, cur[s.id])).join('')}</div>
            </section>` : ''}
            ${attrs.length ? `<section class="dsp-section">
                <h3 class="dsp-section-title">Attributes <span class="dsp-scale">${HUMAN_AVERAGE} average · ${HUMAN_PEAK} human peak</span></h3>
                <div class="dsp-attrs">${attrs.map(s => attrHtml(s, cur[s.id])).join('')}</div>
            </section>` : ''}
            ${!states.length && !attrs.length ? '<div class="dsp-empty">Every stat is switched off in Settings → Stats.</div>' : ''}
            ${isEquipmentEnabled() ? equipmentHtml() : ''}
            <p class="dsp-foot">Click a value to change it. <i class="fa-solid fa-robot"></i> the AI updates it &middot; <i class="fa-solid fa-lock"></i> only you do. Stats, starting values and AI permissions are set in the Workshop.</p>
        </div>`;
}

// ─── Equipment ──────────────────────────────────────────────────────────────

function itemHtml(item) {
    const locked = item.aiCanRemove === false;
    const tip = item.desc ? `${item.name} — ${item.desc}` : item.name;
    return `
        <div class="dsp-item${locked ? ' is-locked' : ''}" data-id="${escapeHtml(item.id)}" data-tip="${escapeHtml(tip)}">
            <span class="dsp-item-icon" tabindex="0" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">${escapeHtml(item.icon || DEFAULT_ICON)}</span>
            <span class="dsp-item-name">${escapeHtml(item.name)}</span>
            <button type="button" class="dsp-item-lock" aria-pressed="${locked}"
                title="${locked ? 'Locked: the AI cannot remove it. Click to let the AI remove it' : 'The AI can remove it. Click to lock it'}">
                <i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
            <button type="button" class="dsp-item-remove" title="Remove ${escapeHtml(item.name)}"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

function equipmentHtml() {
    const items = getEquipment(selected.name, selected.isUser);
    const f = itemForm;
    const form = f.open ? `
        <div class="dsp-item-form">
            <div class="dsp-item-form-row">
                <input type="text" class="dsp-item-in-icon" data-field="icon" value="${escapeHtml(f.icon)}" placeholder="${DEFAULT_ICON}" maxlength="8" aria-label="Icon (emoji)">
                <input type="text" class="dsp-item-in-name" data-field="name" value="${escapeHtml(f.name)}" placeholder="Name" maxlength="40" aria-label="Item name">
            </div>
            <div class="dsp-emoji-grid" role="listbox" aria-label="Pick an icon">
                ${ITEM_EMOJI.map(e => `<button type="button" class="dsp-emoji${f.icon === e ? ' is-on' : ''}" data-emoji="${escapeHtml(e)}">${e}</button>`).join('')}
            </div>
            <input type="text" class="dsp-item-in-desc" data-field="desc" value="${escapeHtml(f.desc)}" placeholder="Very short description (shown on hover)" maxlength="120" aria-label="Description">
            <div class="dsp-item-form-row">
                <label class="dsp-check"><input type="checkbox" class="dsp-item-in-ai" ${f.aiCanRemove ? 'checked' : ''}> The AI can remove it</label>
                <span class="dsp-item-error" role="alert">${escapeHtml(f.error)}</span>
                <button type="button" class="dsp-text-btn" data-action="item-cancel">Cancel</button>
                <button type="button" class="dsp-text-btn is-primary" data-action="item-add">Add</button>
            </div>
        </div>` : '';
    return `
        <section class="dsp-section dsp-equip">
            <h3 class="dsp-section-title">Equipment <span class="dsp-scale">${items.length || ''}</span>
                ${f.open ? '' : '<button type="button" class="dsp-text-btn dsp-item-new" data-action="item-open"><i class="fa-solid fa-plus"></i> Add item</button>'}</h3>
            ${items.length ? `<div class="dsp-items">${items.map(itemHtml).join('')}</div>` : (f.open ? '' : '<div class="dsp-items-empty">Nothing yet. The AI adds what is picked up, bought or given — or add it yourself.</div>')}
            ${form}
        </section>`;
}

function submitItemForm() {
    if (!selected) return;
    const res = addItem(selected.name, selected.isUser, {
        icon: itemForm.icon, name: itemForm.name, desc: itemForm.desc, aiCanRemove: itemForm.aiCanRemove,
    });
    if (res && res.error) { itemForm.error = res.error; renderAll(); return; }
    Object.assign(itemForm, { open: false, icon: '', name: '', desc: '', aiCanRemove: true, error: '' });
    renderAll();
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function isEditing(root) {
    const active = root?.ownerDocument?.activeElement;
    return !!(active && root.contains(active) && active.matches('input[type=number], input[type=text], textarea'));
}

function renderInto(root, opts) {
    if (!root) return;
    if (isEditing(root)) { pendingRender = true; return; }
    const scroller = root.querySelector('.dsp-body');
    const tabsEl = root.querySelector('.dsp-tabs');
    const scrollTop = scroller ? scroller.scrollTop : 0;
    const tabsLeft = tabsEl ? tabsEl.scrollLeft : 0;
    root.innerHTML = buildHtml(opts);
    const newScroller = root.querySelector('.dsp-body');
    if (newScroller) newScroller.scrollTop = scrollTop;
    const newTabs = root.querySelector('.dsp-tabs');
    if (newTabs) newTabs.scrollLeft = tabsLeft;
    root.setAttribute('data-theme', extensionSettings?.theme || 'default');
}

function renderAll() {
    pendingRender = false;
    const panel = document.getElementById(PANEL_ID);
    if (panel && !panel.hidden && !isPopoutOpen()) renderInto(panel, { popout: false });
    if (isPopoutOpen()) {
        const root = popoutWin.document.getElementById('dooms-stats-root');
        renderInto(root, { popout: true });
        try { popoutWin.document.title = selected ? `${selected.name} — Stats` : 'Stats'; } catch (e) {}
    }
}

// ─── Inline panel ───────────────────────────────────────────────────────────

function ensureInlinePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'dooms-stats';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Character stats');
    panel.hidden = true;
    document.body.appendChild(panel);
    applySavedPosition(panel);
    bindRootListeners(panel);
    bindDrag(panel);
    return panel;
}

function applySavedPosition(panel) {
    const pos = extensionSettings.statsPanelPosition;
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    if (window.innerWidth <= 700) return; // phones use the docked sheet layout
    const left = Math.max(0, Math.min(window.innerWidth - 120, pos.left));
    const top = Math.max(0, Math.min(window.innerHeight - 60, pos.top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
}

function bindDrag(panel) {
    let start = null;
    panel.addEventListener('pointerdown', (e) => {
        if (window.innerWidth <= 700) return;
        const handle = e.target.closest('[data-drag-handle]');
        if (!handle || e.target.closest('button')) return;
        const rect = panel.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
        panel.setPointerCapture(e.pointerId);
        panel.classList.add('is-dragging');
    });
    panel.addEventListener('pointermove', (e) => {
        if (!start) return;
        const left = Math.max(0, Math.min(window.innerWidth - 120, start.left + e.clientX - start.x));
        const top = Math.max(0, Math.min(window.innerHeight - 60, start.top + e.clientY - start.y));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = 'auto';
    });
    const end = (e) => {
        if (!start) return;
        start = null;
        panel.classList.remove('is-dragging');
        try { panel.releasePointerCapture(e.pointerId); } catch (err) {}
        const rect = panel.getBoundingClientRect();
        extensionSettings.statsPanelPosition = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveSettings();
    };
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
}

// ─── Pop-out window ─────────────────────────────────────────────────────────

function isPopoutOpen() {
    try { return !!(popoutWin && !popoutWin.closed && popoutWin.document.getElementById('dooms-stats-root')); }
    catch (e) { return false; }
}

/** The theme colours SillyTavern exposes, copied so the pop-out matches. */
function themeVarsStyle() {
    const names = ['--SmartThemeBodyColor', '--SmartThemeQuoteColor', '--SmartThemeBlurTintColor', '--SmartThemeBorderColor', '--SmartThemeEmColor'];
    try {
        const cs = getComputedStyle(document.documentElement);
        return names.map(n => {
            const v = cs.getPropertyValue(n).trim();
            return v ? `${n}: ${v};` : '';
        }).join(' ');
    } catch (e) { return ''; }
}

function stylesheetLinks() {
    const links = [];
    const css = absoluteUrl(`/${extensionFolderPath}/styles/stats-panel.css`);
    links.push(`<link rel="stylesheet" href="${escapeHtml(css)}">`);
    // Font Awesome, from whatever SillyTavern loaded.
    document.querySelectorAll('link[rel="stylesheet"]').forEach(l => {
        const href = l.href || '';
        if (/font-?awesome|fontawesome/i.test(href)) links.push(`<link rel="stylesheet" href="${escapeHtml(href)}">`);
    });
    return links.join('\n');
}

function openPopout() {
    let win = null;
    try {
        win = window.open('', POPOUT_NAME, 'popup=yes,width=460,height=780');
    } catch (e) { win = null; }
    if (!win) {
        if (window.toastr) window.toastr.warning('The browser blocked the pop-up window. Allow pop-ups for SillyTavern and try again.', 'Stats', { timeOut: 5000 });
        return;
    }
    popoutWin = win;
    const doc = win.document;
    // Always (re)write the document: a window left over from before a page
    // reload still has the markup but its listeners died with the old page.
    {
        doc.open();
        doc.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stats</title>
${stylesheetLinks()}
<style>:root { ${themeVarsStyle()} }</style>
</head>
<body class="dooms-stats-popout-body">
<div id="dooms-stats-root" class="dooms-stats is-popout"></div>
</body>
</html>`);
        doc.close();
        const root = doc.getElementById('dooms-stats-root');
        bindRootListeners(root);
        // Closing the window just ends the pop-out; reopening from the menu
        // brings the floating panel back.
        win.addEventListener('pagehide', () => {
            if (popoutWin === win) popoutWin = null;
        });
    }
    closeStatsPanel();
    renderAll();
    try { win.focus(); } catch (e) {}
}

function dockPopout() {
    const win = popoutWin;
    popoutWin = null;
    try { win?.close(); } catch (e) {}
    const panel = ensureInlinePanel();
    ensureCss('stats-panel').catch(() => {}).finally(() => {
        panel.hidden = false;
        renderAll();
    });
}

// ─── Interaction ────────────────────────────────────────────────────────────

function startEdit(button) {
    if (!selected) return;
    const id = button.getAttribute('data-stat');
    const stat = getStatSheet(selected.name, selected.isUser).find(s => s.id === id);
    if (!stat) return;
    const cur = getCurrentStatValues(selected.name, selected.isUser)[id];
    const doc = button.ownerDocument;
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = String(stat.min);
    input.max = String(stat.max);
    input.step = '1';
    input.value = String(cur);
    input.className = 'dsp-value-input';
    input.setAttribute('aria-label', `${stat.name} value`);
    input.dataset.stat = id;
    button.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
        if (done) return;
        done = true;
        if (commit && selected) setCurrentStatValue(selected.name, selected.isUser, id, input.value);
        input.blur();
        renderAll();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
}

function bindRootListeners(root) {
    root.addEventListener('click', (e) => {
        const tab = e.target.closest('.dsp-tab');
        if (tab) {
            selected = { name: tab.getAttribute('data-name'), isUser: tab.getAttribute('data-user') === '1' };
            Object.assign(itemForm, { open: false, error: '' });
            renderAll();
            return;
        }
        const emoji = e.target.closest('.dsp-emoji');
        if (emoji) { itemForm.icon = emoji.getAttribute('data-emoji'); renderAll(); return; }
        const itemRow = e.target.closest('.dsp-item');
        if (itemRow && selected) {
            const id = itemRow.getAttribute('data-id');
            if (e.target.closest('.dsp-item-lock')) {
                const item = getEquipment(selected.name, selected.isUser).find(i => i.id === id);
                if (item) updateItem(selected.name, selected.isUser, id, { aiCanRemove: item.aiCanRemove === false });
                return;
            }
            if (e.target.closest('.dsp-item-remove')) { removeItem(selected.name, selected.isUser, id); return; }
        }
        const value = e.target.closest('button.dsp-value');
        if (value) { startEdit(value); return; }
        const action = e.target.closest('[data-action]')?.getAttribute('data-action');
        if (action === 'item-open') { itemForm.open = true; itemForm.error = ''; renderAll(); root.querySelector('.dsp-item-in-name')?.focus(); return; }
        if (action === 'item-cancel') { Object.assign(itemForm, { open: false, icon: '', name: '', desc: '', aiCanRemove: true, error: '' }); renderAll(); return; }
        if (action === 'item-add') { submitItemForm(); return; }
        if (action === 'close') closeStatsPanel();
        else if (action === 'popout') openPopout();
        else if (action === 'dock') dockPopout();
        else if (action === 'reset' && selected) {
            const ok = (root.ownerDocument.defaultView || window).confirm(
                `Reset ${selected.name}'s stats to their starting values${campaignLabel() ? ` in ${campaignLabel()}` : ''}?`,
            );
            if (ok) resetCurrentStatValues(selected.name, selected.isUser);
        }
    });
    // A repaint skipped while typing runs once focus leaves the field
    // (also inside the pop-out window, whose events stay in its document).
    root.addEventListener('focusout', () => {
        if (pendingRender) setTimeout(renderAll, 0);
    });
    // Add-item form fields live in itemForm so a repaint keeps them.
    root.addEventListener('input', (e) => {
        const field = e.target.getAttribute && e.target.getAttribute('data-field');
        if (field) { itemForm[field] = e.target.value; itemForm.error = ''; }
    });
    root.addEventListener('change', (e) => {
        if (e.target.classList && e.target.classList.contains('dsp-item-in-ai')) itemForm.aiCanRemove = e.target.checked;
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest && e.target.closest('.dsp-item-form') && e.target.matches('input[type=text]')) {
            e.preventDefault();
            submitItemForm();
            return;
        }
        if (e.key === 'Escape' && !e.target.closest('.dsp-value-input, .dsp-item-form') && root.id === PANEL_ID) closeStatsPanel();
    });
}

function bindGlobalListeners() {
    if (listenersBound) return;
    listenersBound = true;
    window.addEventListener(STATS_CHANGED_EVENT, () => {
        // Collapse bursts (an AI update changes many values) into one paint.
        requestAnimationFrame(() => renderAll());
    });
    // A finished edit may have deferred a repaint.
    document.addEventListener('focusout', () => {
        if (pendingRender) setTimeout(renderAll, 0);
    });
    // The pop-out lives off this page: close it with the page.
    window.addEventListener('pagehide', () => {
        try { if (popoutWin && !popoutWin.closed) popoutWin.close(); } catch (e) {}
    });
}
