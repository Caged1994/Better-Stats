/**
 * Visual themes for the Stats panel and the combat, dungeon and sphere grid
 * windows. 'default' is the original look and loads nothing extra; the
 * others add styles/themes.css and their fonts, and switch on with a
 * data-des-theme attribute on each window's root element.
 */
import { extensionSettings } from './state.js';
import { saveSettings } from './persistence.js';
import { ensureCss } from './cssLoader.js';

const GF = 'https://fonts.googleapis.com/css2?family=';

export const THEMES = {
    default: { label: 'Classic', hint: 'The original look, following SillyTavern\'s colours.', fonts: '' },
    grimoire: {
        label: 'Grimoire', hint: 'Dark parchment, gold and ink.',
        fonts: `${GF}Cinzel:wght@500;700&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap`,
    },
    terminal: {
        label: 'Tactical terminal', hint: 'Cyan and amber HUD on near-black, with cut corners.',
        fonts: `${GF}Chakra+Petch:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap`,
    },
    paper: {
        label: 'Paper and ink', hint: 'Light rice paper, black ink and vermilion stamps.',
        fonts: `${GF}Shippori+Mincho:wght@500;700;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap`,
    },
};
export const THEME_IDS = Object.keys(THEMES);

export function getUiThemeId() {
    const id = extensionSettings.uiTheme;
    return THEME_IDS.includes(id) ? id : 'default';
}

/** The stylesheet links a theme needs (for a pop-out window, which loads its own). */
export function themeFontUrl(id = getUiThemeId()) {
    return THEMES[id]?.fonts || '';
}

function ensureFont(id) {
    const url = themeFontUrl(id);
    if (!url || document.getElementById(`dooms-font-${id}`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.id = `dooms-font-${id}`;
    link.href = url;
    document.head.appendChild(link);
}

/** Loads what the current theme needs; resolves when its styles are in. */
export async function uiThemeReady() {
    const id = getUiThemeId();
    if (id === 'default') return;
    ensureFont(id);
    try { await ensureCss('themes'); } catch (e) { /* the default look still works */ }
}

/** Puts the current theme on a window's root element. */
export function applyUiTheme(el) {
    if (!el) return;
    const id = getUiThemeId();
    if (id === 'default') el.removeAttribute('data-des-theme');
    else el.setAttribute('data-des-theme', id);
}

/** Changes the theme and restyles whatever is open. */
export async function setUiTheme(id) {
    extensionSettings.uiTheme = THEME_IDS.includes(id) ? id : 'default';
    saveSettings();
    await uiThemeReady();
    document.querySelectorAll('.dcb, .dooms-stats').forEach(applyUiTheme);
    document.dispatchEvent(new CustomEvent('dooms-theme-changed'));
}
