/**
 * Settings → Stats: one switch per built-in stat. A switched-off stat is
 * hidden from the Stats panel and the Workshop and never sent to the AI, for
 * every character (see characterStats.setStatEnabled).
 */
import { escapeHtml } from '../../utils/html.js';
import { builtinStatList } from '../../utils/statsModel.js';
import { getDisabledStatIds, setStatEnabled } from '../features/characterStats.js';

function rowHtml(stat, on) {
    const id = `rpg-stat-toggle-${stat.id}`;
    const tag = stat.kind === 'state'
        ? `<span class="rpg-stat-toggle-dot" style="background:${escapeHtml(stat.color || '#888')}"></span>`
        : `<span class="rpg-stat-toggle-abbr">${escapeHtml(stat.abbr || '')}</span>`;
    return `
        <div class="rpg-setting-row">
            <div class="rpg-setting-label-group">
                <span class="rpg-setting-label">${tag}${escapeHtml(stat.name)}</span>
                <span class="rpg-setting-hint">${escapeHtml(stat.description || '')}</span>
            </div>
            <label class="rpg-toggle-switch" for="${id}">
                <input type="checkbox" id="${id}" class="rpg-stat-toggle" data-stat="${escapeHtml(stat.id)}"${on ? ' checked' : ''} />
                <span class="rpg-toggle-slider"></span>
            </label>
        </div>`;
}

/** Fills the two lists from the current settings. Safe to call again. */
export function renderStatsSettings() {
    const off = new Set(getDisabledStatIds());
    const all = builtinStatList();
    const states = document.getElementById('rpg-stats-toggle-states');
    const attrs = document.getElementById('rpg-stats-toggle-attributes');
    if (states) states.innerHTML = all.filter(s => s.kind === 'state').map(s => rowHtml(s, !off.has(s.id))).join('');
    if (attrs) attrs.innerHTML = all.filter(s => s.kind === 'attribute').map(s => rowHtml(s, !off.has(s.id))).join('');
}

let bound = false;

/** Renders the switches and wires them up (once). */
export function initStatsSettings() {
    renderStatsSettings();
    if (bound) return;
    bound = true;
    document.addEventListener('change', (e) => {
        const input = e.target;
        if (!input || !input.classList || !input.classList.contains('rpg-stat-toggle')) return;
        setStatEnabled(input.getAttribute('data-stat'), input.checked);
    });
}
