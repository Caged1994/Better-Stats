/**
 * Settings → Stats: one row per built-in stat with an on/off switch and, for
 * the ring stats, a colour. Both apply to every character (see
 * characterStats.setStatEnabled / setStatColor). The Workshop's Stats tab
 * edits the same settings, so this list repaints on STATS_CHANGED_EVENT.
 */
import { escapeHtml } from '../../utils/html.js';
import { builtinStatList, isHexColor, CUSTOM_STATE_COLORS } from '../../utils/statsModel.js';
import {
    getDisabledStatIds,
    setStatEnabled,
    getStatColors,
    setStatColor,
    STATS_CHANGED_EVENT,
    getCustomStatDefinitions,
    deleteCustomStat,
} from '../features/characterStats.js';
import { isMemoriesEnabled, setMemoriesEnabled, getRecentLimit, setRecentLimit } from '../features/characterMemories.js';

function sixDigit(color) {
    const c = String(color || '');
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(ch => ch + ch).join('').toLowerCase();
    return '#888888';
}

function rowHtml(stat, on, colors) {
    const id = `rpg-stat-toggle-${stat.id}`;
    const custom = isHexColor(colors[stat.id]);
    const color = custom ? colors[stat.id] : stat.color;
    const tag = stat.kind === 'state'
        ? `<label class="rpg-stat-color-swatch" title="Change the colour of ${escapeHtml(stat.name)}" style="background:${escapeHtml(color || '#888')}">
                <input type="color" class="rpg-stat-color" data-stat="${escapeHtml(stat.id)}" value="${escapeHtml(sixDigit(color))}" aria-label="${escapeHtml(stat.name)} colour">
           </label>`
        : `<span class="rpg-stat-toggle-abbr">${escapeHtml(stat.abbr || '')}</span>`;
    const reset = stat.kind === 'state' && custom && stat.builtin !== false
        ? `<button type="button" class="rpg-stat-color-reset" data-stat="${escapeHtml(stat.id)}" title="Back to the default colour"><i class="fa-solid fa-rotate-left"></i></button>`
        : '';
    const del = stat.builtin === false
        ? `<button type="button" class="rpg-stat-delete" data-stat="${escapeHtml(stat.id)}" data-name="${escapeHtml(stat.name)}" title="Delete ${escapeHtml(stat.name)} for every character"><i class="fa-solid fa-trash"></i></button>`
        : '';
    return `
        <div class="rpg-setting-row rpg-stat-setting-row${on ? '' : ' is-off'}">
            <div class="rpg-setting-label-group">
                <span class="rpg-setting-label">${tag}${escapeHtml(stat.name)}${stat.builtin === false ? ` <span class="rpg-stat-kind">${stat.kind === 'state' ? 'stat' : 'attribute'}</span>` : ''}${reset}${del}</span>
                <span class="rpg-setting-hint">${escapeHtml(stat.description || '')}</span>
            </div>
            <label class="rpg-toggle-switch" for="${id}" title="Use ${escapeHtml(stat.name)}">
                <input type="checkbox" id="${id}" class="rpg-stat-toggle" data-stat="${escapeHtml(stat.id)}"${on ? ' checked' : ''} />
                <span class="rpg-toggle-slider"></span>
            </label>
        </div>`;
}

/** Fills the two lists from the current settings. Safe to call again. */
export function renderStatsSettings() {
    const off = new Set(getDisabledStatIds());
    const colors = getStatColors();
    const all = builtinStatList();
    const states = document.getElementById('rpg-stats-toggle-states');
    const attrs = document.getElementById('rpg-stats-toggle-attributes');
    if (states) states.innerHTML = all.filter(s => s.kind === 'state').map(s => rowHtml(s, !off.has(s.id), colors)).join('');
    if (attrs) attrs.innerHTML = all.filter(s => s.kind === 'attribute').map(s => rowHtml(s, !off.has(s.id), colors)).join('');
    const customHost = document.getElementById('rpg-stats-toggle-custom');
    if (customHost) {
        let i = 0;
        const defs = getCustomStatDefinitions().map(d => ({
            ...d,
            builtin: false,
            abbr: d.kind === 'attribute' ? String(d.name || '').slice(0, 3).toUpperCase() : '',
            color: d.color || (d.kind === 'state' ? CUSTOM_STATE_COLORS[i++ % CUSTOM_STATE_COLORS.length] : ''),
        }));
        customHost.innerHTML = defs.length
            ? defs.map(s => rowHtml(s, !off.has(s.id), colors)).join('')
            : '<p class="rpg-note-text">None yet — add them from the Stats tab of any character in the Workshop.</p>';
    }
}

let bound = false;

/** Renders the rows and wires them up (once). */
export function initStatsSettings() {
    renderStatsSettings();
    const memOn = document.getElementById('rpg-memories-enabled');
    if (memOn) memOn.checked = isMemoriesEnabled();
    const memRecent = document.getElementById('rpg-memories-recent');
    if (memRecent) memRecent.value = String(getRecentLimit());
    if (bound) return;
    bound = true;
    document.addEventListener('change', (e) => {
        const el = e.target;
        if (!el || !el.classList) return;
        if (el.classList.contains('rpg-stat-toggle')) setStatEnabled(el.getAttribute('data-stat'), el.checked);
        else if (el.classList.contains('rpg-stat-color')) setStatColor(el.getAttribute('data-stat'), el.value);
        else if (el.id === 'rpg-memories-enabled') setMemoriesEnabled(el.checked);
        else if (el.id === 'rpg-memories-recent') { setRecentLimit(el.value); el.value = String(getRecentLimit()); }
    });
    document.addEventListener('input', (e) => {
        const el = e.target;
        if (el && el.classList && el.classList.contains('rpg-stat-color')) {
            el.parentElement.style.background = el.value;
        }
    });
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.rpg-stat-color-reset') : null;
        if (btn) { e.preventDefault(); setStatColor(btn.getAttribute('data-stat'), ''); return; }
        const del = e.target && e.target.closest ? e.target.closest('.rpg-stat-delete') : null;
        if (del) {
            e.preventDefault();
            const name = del.getAttribute('data-name') || 'this stat';
            if (window.confirm(`Delete the stat "${name}" for every character?\n\nTheir values for it are deleted too.`)) {
                deleteCustomStat(del.getAttribute('data-stat'));
            }
        }
    });
    // Changes made from the Workshop (or a reset here) repaint the list.
    window.addEventListener(STATS_CHANGED_EVENT, (e) => {
        if (e.detail?.source !== 'settings') return;
        const active = document.activeElement;
        if (active && active.classList && active.classList.contains('rpg-stat-color')) return;
        renderStatsSettings();
    });
}
