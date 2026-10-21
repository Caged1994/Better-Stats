/**
 * Stats Panel — live view of a character's stats.
 *
 * Opened from the portrait right-click menu ("Stats"). Shows the states as
 * rings and the attributes as score tiles for the open chat's current
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
import { getEquipment, addItem, updateItem, removeItem, isEquipmentEnabled, needsStartingGear, requestStartingGear, cancelStartingGear, describeEffects } from '../features/characterEquipment.js';
import { getConditions, addCondition, updateCondition, removeCondition, isConditionsEnabled } from '../features/characterConditions.js';
import {
    getAbilities, addAbility, updateAbility, removeAbility, isAbilitiesEnabled, activeManaTiers,
    needsStartingAbilities, requestStartingAbilities, cancelStartingAbilities,
} from '../features/characterAbilities.js';
import { ABILITY_EMOJI, DEFAULT_SPELL_ICON, DEFAULT_ABILITY_ICON } from '../../utils/abilityModel.js';
import { getMemories, updateMemory, deleteMemory, getRecentLimit, isMemoriesEnabled, MEMORIES_CHANGED_EVENT } from '../features/characterMemories.js';
import { fadedIds } from '../../utils/memoryModel.js';
import { getEffectiveStatValues } from '../features/characterModifiers.js';
import { ITEM_EMOJI, DEFAULT_ICON, normalizeItem } from '../../utils/equipmentModel.js';
import { CONDITION_EMOJI, DEFAULT_CONDITION_ICON } from '../../utils/conditionModel.js';
import {
    isProgressEnabled, isXpEnabled, getProgress, getLevelInfo, hasLevel, getXpSettings,
    isPartyMember, setPartyMember, awardXpTo, removeLogEntry, setLevel, setUnspentPoints,
    spendPoint, refundPoint,
} from '../features/characterProgress.js';
import { formatXpAmount, MAX_LEVEL } from '../../utils/xpModel.js';
import { isRpgModeActive, toggleRpgModeHere, rpgModeSource } from '../features/rpgMode.js';
import { isMoneyEnabled, getMoney, setMoney, hasPurse, formatAmount, getCurrency } from '../features/characterMoney.js';
import { isAffinityEnabled, getAffinityRecord, setAffinity } from '../features/characterAffinity.js';
import { isDungeonEnabled, hasLiveDungeon } from '../features/dungeon.js';
import { isSphereEnabled } from '../features/sphereGrid.js';
import { isCombatEnabled, getLiveEncounter, getActionProfile, setActionProfile, describeProfile } from '../features/combat.js';
import {
    isChecksEnabled, getCheckAttributes, checkChance, rollCheckFor, getPendingCheck, dismissPendingCheck, pendingActor, getRecentChecks,
} from '../features/characterChecks.js';
import { DIFFICULTIES, resolveDifficulty, degreeLabel, rollText, MAX_BONUS } from '../../utils/checkModel.js';
import { STATUSES as COMBAT_STATUSES, STATUS_IDS as COMBAT_STATUS_IDS, ATTRIBUTE_IDS as COMBAT_ATTRS } from '../../utils/combatModel.js';
import { affinityTier } from '../../utils/affinityModel.js';

const PANEL_ID = 'dooms-stats-panel';
const POPOUT_NAME = 'dooms-stats-popout';
const RING_R = 34;
const RING_C = 2 * Math.PI * RING_R;

let selected = null;          // { name, isUser }
let popoutWin = null;         // Window | null
let listenersBound = false;
let pendingRender = false;    // a repaint skipped while a value was being typed
// The "Add item" / "Add condition" form survives repaints (an AI update can
// land while typing). kind: 'item' | 'condition'; only one is open at a time.
// editId: the entry being edited (null = adding a new one).
const FORM_DEFAULTS = { open: false, kind: 'item', editId: null, icon: '', name: '', desc: '', effects: '', qty: '1', equipped: false, aiCanRemove: true, type: 'spell', cost: '', error: '', atk: '', def: '', gearTouched: false, cbType: '', cbPower: '', cbStat: '', cbTarget: '', cbStatus: '', cbStatusTurns: '', cbStatusChance: '', cbAuto: null };
const itemForm = { ...FORM_DEFAULTS };
// The roll form (🎲 in the header), kept across repaints; `last` is the result just rolled.
const checkForm = { open: false, stat: '', difficulty: 'medium', bonus: '0', reason: '', last: null };

// Section tabs inside the panel. The last one used is remembered.
const SECTIONS = [
    { id: 'stats', label: 'Stats', icon: 'fa-heart-pulse' },
    { id: 'attributes', label: 'Attributes', icon: 'fa-dumbbell' },
    { id: 'equipment', label: 'Equipment', icon: 'fa-shield-halved' },
    { id: 'abilities', label: 'Abilities', icon: 'fa-wand-sparkles' },
    { id: 'memories', label: 'Memories', icon: 'fa-brain' },
    { id: 'xp', label: 'Level', icon: 'fa-ranking-star' },
];
const FORM_SECTION = { item: 'equipment', ability: 'abilities' };
function getSection() {
    const s = extensionSettings.statsPanelSection;
    return SECTIONS.some(x => x.id === s) ? s : 'stats';
}
function setSection(id) {
    if (extensionSettings.statsPanelSection === id) return;
    extensionSettings.statsPanelSection = id;
    try { saveSettings(); } catch (e) {}
}
function resetForm() { Object.assign(itemForm, FORM_DEFAULTS); }
// The manual XP form (XP tab), kept across repaints.
const xpForm = { amount: '', reason: '' };

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

function attrHtml(stat, base, value = base, mod = null, prog = null) {
    const tier = attrTier(value);
    const total = mod?.total || 0;
    const from = total ? (mod.parts || []).map(p => `${p.label} ${p.value > 0 ? '+' : '−'}${Math.abs(p.value)}`).join(', ') : '';
    const tip = `${stat.name} ${value} (${tier.label})${total ? ` = ${base} base, ${from}` : ''}${stat.description ? ` — ${stat.description}` : ''}`;
    // The bar fills at the human peak; superhuman values glow instead.
    const width = Math.max(3, Math.min(100, (value / HUMAN_PEAK) * 100));
    return `
        <div class="dsp-attr${tier.cls}" data-stat="${escapeHtml(stat.id)}" title="${escapeHtml(tip)}">
            <div class="dsp-attr-head">
                <span class="dsp-attr-abbr">${escapeHtml(stat.abbr || stat.name)}</span>
                ${aiBadge(stat)}
            </div>
            <div class="dsp-attr-line">
                <button type="button" class="dsp-value dsp-attr-value" data-stat="${escapeHtml(stat.id)}" title="${total ? `Base ${base} — click to edit the base value` : 'Click to edit'}">${value}</button>
                ${total ? `<span class="dsp-mod ${total > 0 ? 'is-up' : 'is-down'}" title="${escapeHtml(from)}">${total > 0 ? '+' : '−'}${Math.abs(total)}</span>` : ''}
                ${pointButtons(stat, base, prog)}
            </div>
            <div class="dsp-attr-bar"><span style="width:${width.toFixed(1)}%"></span></div>
            ${stat.abbr ? `<span class="dsp-attr-name">${escapeHtml(stat.name)}</span>` : ''}
        </div>`;
}

/** The + (spend a level point) and ↶ (take it back) buttons of an attribute tile. */
function pointButtons(stat, base, prog) {
    if (!prog) return '';
    const spent = prog.spent[stat.id] || 0;
    const canAdd = prog.points > 0 && base < stat.max;
    if (!canAdd && !spent) return '';
    return `<div class="dsp-points">
        ${spent ? `<button type="button" class="dsp-point-btn is-refund" data-point="refund" data-stat="${escapeHtml(stat.id)}" title="Take back a point (${spent} assigned from levels)">↶ ${spent}</button>` : ''}
        ${canAdd ? `<button type="button" class="dsp-point-btn" data-point="spend" data-stat="${escapeHtml(stat.id)}" title="Spend a level point: ${escapeHtml(stat.name)} +1">+</button>` : ''}
    </div>`;
}

/** Money (persona and party) and affinity toward the persona (NPCs), under the name. */
function heroExtrasHtml() {
    const parts = [];
    if (isMoneyEnabled() && hasPurse(selected.name, selected.isUser)) {
        const m = getMoney(selected.name, selected.isUser);
        const cur = getCurrency();
        parts.push(`<button type="button" class="dsp-chip dsp-money" data-edit="money" title="${cur ? `Money (${escapeHtml(cur.name)})` : 'Money — set the currency for this card in Settings → RPG & Stats'} — click to change">💰 ${m === null ? '—' : escapeHtml(formatAmount(m))}</button>`);
    }
    if (isAffinityEnabled() && !selected.isUser) {
        const rec = getAffinityRecord(selected.name);
        if (rec) {
            const t = affinityTier(rec.value);
            const pct = (rec.value + 100) / 2;
            parts.push(`<button type="button" class="dsp-chip dsp-affinity" data-edit="affinity" style="--dsp-aff:${t.color}" title="Feelings toward your character: ${rec.value > 0 ? '+' : ''}${rec.value} (${t.label})${rec.reason ? ` — last change: ${escapeHtml(rec.reason)}` : ''}. Click to change.">
                <span class="dsp-aff-heart">❤</span><span class="dsp-aff-bar"><span style="width:${pct}%"></span></span><span>${rec.value > 0 ? '+' : ''}${rec.value} ${t.label}</span></button>`);
        } else {
            parts.push('<span class="dsp-chip is-dim" title="The AI gives a starting value in its next reply">❤ —</span>');
        }
    }
    return parts.length ? `<span class="dsp-hero-extras">${parts.join('')}</span>` : '';
}

/** Level badge + XP bar in the hero. */
function heroLevelHtml() {
    if (!isProgressEnabled() || !hasLevel(selected.name, selected.isUser)) return '';
    const info = getLevelInfo(selected.name, selected.isUser);
    const earns = selected.isUser || isPartyMember(selected.name);
    const bar = earns && isXpEnabled()
        ? `<span class="dsp-xpbar" title="${info.into} / ${info.needed} XP to level ${info.level + 1}"><span style="width:${info.pct}%"></span></span>`
        : '';
    return `<span class="dsp-hero-level"><span class="dsp-lv" title="Level ${info.level}">Lv ${info.level}</span>${bar}</span>`;
}

function rpgOffHtml(head) {
    const from = { chat: 'this chat', card: 'this card', default: 'the default setting' }[rpgModeSource()];
    return head + `<div class="dsp-empty dsp-rpg-off">
        <i class="fa-solid fa-dice-d20"></i>
        <p>RPG mode is off for ${from}: stats, levels, equipment and the rest are not used here.</p>
        <button type="button" class="dsp-text-btn is-primary" data-action="rpg-on"><i class="fa-solid fa-power-off"></i> Turn RPG mode on</button>
        <p class="dsp-section-hint">Settings → RPG &amp; Stats has the per-card and per-chat switches.</p>
    </div>`;
}


// ─── Checks (🎲) ────────────────────────────────────────────────────────────

const signedNum = (n) => (n > 0 ? `+${n}` : String(n));

function checkResultHtml(r, { compact = false } = {}) {
    const good = r.success;
    const cls = `dsp-check-result ${good ? 'is-good' : 'is-bad'}${r.degree.startsWith('critical') ? ' is-crit' : ''}${compact ? ' is-compact' : ''}`;
    const by = r.degree.startsWith('critical') ? '' : (r.success ? (r.margin > 0 ? ` by ${r.margin}` : '') : ` by ${Math.abs(r.margin)}`);
    return `<div class="${cls}" title="${escapeHtml(`${r.name} · ${r.statLabel} · ${r.difficultyLabel} — ${rollText(r)}`)}">
        <span class="dsp-check-die">${r.die}</span>
        <span class="dsp-check-text"><strong>${escapeHtml(degreeLabel(r.degree))}${by}</strong>
            <small>${escapeHtml(r.name)} · ${escapeHtml(r.statLabel)} ${escapeHtml(String(r.difficultyLabel))} · ${escapeHtml(rollText(r))}${r.reason ? ` · ${escapeHtml(r.reason)}` : ''}</small></span>
    </div>`;
}

/** The AI's suggested check and the roll form, at the top of the panel. */
function checkPanelHtml() {
    if (!isChecksEnabled() || !selected) return '';
    let html = '';
    const pending = getPendingCheck();
    if (pending) {
        const actor = pendingActor(pending);
        const diff = pending.difficulty ? resolveDifficulty(pending.difficulty) : resolveDifficulty(pending.dc);
        const attr = actor ? getCheckAttributes(actor.name, actor.isUser).find(a => a.id.toLowerCase() === String(pending.stat).toLowerCase() || String(a.abbr).toLowerCase() === String(pending.stat).toLowerCase()) : null;
        if (actor && attr) {
            const chance = checkChance(actor.name, actor.isUser, attr.id, diff.dc);
            html += `<div class="dsp-check-ask">
                <span class="dsp-check-ask-icon">🎲</span>
                <span class="dsp-check-ask-text"><strong>The story asks for a check</strong>
                    <small>${escapeHtml(actor.name)} · ${escapeHtml(String(attr.abbr).toUpperCase())} ${escapeHtml(diff.id ? diff.label : `DC ${diff.dc}`)} (needs ${diff.dc}) · ${Math.round((chance ?? 0) * 100)}% to succeed${pending.reason ? ` · ${escapeHtml(pending.reason)}` : ''}</small></span>
                <button type="button" class="dsp-text-btn is-primary" data-action="check-roll-pending">Roll</button>
                <button type="button" class="dsp-icon-btn" data-action="check-dismiss" title="Not now" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
            </div>`;
        }
    }
    if (checkForm.open) {
        const attrs = getCheckAttributes(selected.name, selected.isUser);
        if (!attrs.some(a => a.id === checkForm.stat)) checkForm.stat = attrs[0]?.id || '';
        const diff = resolveDifficulty(checkForm.difficulty);
        const bonus = Math.max(-MAX_BONUS, Math.min(MAX_BONUS, Math.round(Number(checkForm.bonus) || 0)));
        const chance = checkForm.stat ? checkChance(selected.name, selected.isUser, checkForm.stat, diff.dc, bonus) : null;
        const recent = getRecentChecks(4).filter(r => !checkForm.last || r.id !== checkForm.last.id);
        html += `<div class="dsp-check-form">
            <div class="dsp-check-row">
                <label>Attribute <select class="dsp-chk" data-chk="stat">${attrs.map(a => `<option value="${escapeHtml(a.id)}"${a.id === checkForm.stat ? ' selected' : ''}>${escapeHtml(String(a.abbr).toUpperCase())} ${a.value} (${signedNum(a.modifier)})</option>`).join('')}</select></label>
                <label>Difficulty <select class="dsp-chk" data-chk="difficulty">${DIFFICULTIES.map(d => `<option value="${d.id}"${d.id === diff.id ? ' selected' : ''}>${d.label} · ${d.dc}</option>`).join('')}</select></label>
                <label>Bonus <input type="number" class="dsp-chk-bonus" data-chk="bonus" value="${escapeHtml(String(checkForm.bonus))}" min="${-MAX_BONUS}" max="${MAX_BONUS}" step="1" title="A favourable (+) or awkward (−) situation"></label>
            </div>
            <div class="dsp-check-row">
                <input type="text" class="dsp-chk-reason" data-chk="reason" value="${escapeHtml(checkForm.reason)}" placeholder="What is attempted (optional, the AI reads it)" maxlength="100">
                <span class="dsp-check-chance" title="Natural 20 always succeeds, natural 1 always fails">${chance === null ? '' : `${Math.round(chance * 100)}%`}</span>
                <button type="button" class="dsp-text-btn is-primary" data-action="check-roll" ${attrs.length ? '' : 'disabled'}><i class="fa-solid fa-dice-d20"></i> Roll</button>
            </div>
            ${checkForm.last ? checkResultHtml(checkForm.last) + '<p class="dsp-section-hint">The result goes into the AI\'s next reply: write what you do and it will follow the roll.</p>' : ''}
            ${recent.length ? `<div class="dsp-check-recent">${recent.map(r => checkResultHtml(r, { compact: true })).join('')}</div>` : ''}
        </div>`;
    }
    return html ? `<section class="dsp-check-wrap">${html}</section>` : '';
}

function doRoll(name, isUser, o) {
    const r = rollCheckFor(name, isUser, o);
    if (r) {
        checkForm.last = r;
        checkForm.open = true;
        checkForm.reason = '';
        selected = characterTabs().find(t => t.isUser === !!isUser && t.name.toLowerCase() === String(name).toLowerCase()) || selected;
    }
    renderAll();
}

function buildHtml({ popout }) {
    const tabs = characterTabs();
    if (!selected && tabs.length) selected = tabs[0];
    const campaign = campaignLabel();
    const head = `
        <header class="dsp-head" data-drag-handle>
            <span class="dsp-title"><i class="fa-solid fa-chart-simple"></i> Stats</span>
            ${campaign ? `<span class="dsp-campaign" title="Active campaign — portraits and descriptions follow it; values belong to this chat">${escapeHtml(campaign)}</span>` : ''}
            <span class="dsp-spacer"></span>
            ${isChecksEnabled() ? `<button type="button" class="dsp-icon-btn${checkForm.open || getPendingCheck() ? ' is-on' : ''}" data-action="check-toggle" title="${getPendingCheck() ? 'The story asks for a check' : 'Roll a check'}"><i class="fa-solid fa-dice-d20"></i></button>` : ''}
            ${isCombatEnabled() ? `<button type="button" class="dsp-icon-btn${getLiveEncounter() ? ' is-on' : ''}" data-action="combat" title="${getLiveEncounter() ? 'A fight is in progress — resume it' : 'Start a turn-based fight'}"><i class="fa-solid fa-khanda"></i></button>` : ''}
            ${isDungeonEnabled() ? `<button type="button" class="dsp-icon-btn${hasLiveDungeon() ? ' is-on' : ''}" data-action="dungeon" title="${hasLiveDungeon() ? 'An expedition is waiting — resume it' : 'Explore a dungeon'}"><i class="fa-solid fa-dungeon"></i></button>` : ''}
            <button type="button" class="dsp-icon-btn${isRpgModeActive() ? ' is-on' : ''}" data-action="${isRpgModeActive() ? 'rpg-off' : 'rpg-on'}" title="RPG mode is ${isRpgModeActive() ? 'on — click to turn it off for this card' : 'off — click to turn it on'}"><i class="fa-solid fa-power-off"></i></button>
            ${popout
                ? '<button type="button" class="dsp-icon-btn" data-action="dock" title="Back into SillyTavern"><i class="fa-solid fa-down-left-and-up-right-to-center"></i></button>'
                : '<button type="button" class="dsp-icon-btn" data-action="popout" title="Open in a separate window"><i class="fa-solid fa-up-right-from-square"></i></button>'}
            ${popout ? '' : '<button type="button" class="dsp-icon-btn" data-action="close" title="Close"><i class="fa-solid fa-xmark"></i></button>'}
        </header>`;

    if (!isRpgModeActive()) return rpgOffHtml(head);
    if (!selected) {
        return head + '<div class="dsp-empty">No characters in the scene yet.</div>';
    }
    const levelsOn = isProgressEnabled();

    const tabsHtml = tabs.length > 1 ? `
        <nav class="dsp-tabs" role="tablist" aria-label="Characters">
            ${tabs.map(t => {
                const on = t.name === selected.name && t.isUser === selected.isUser;
                return `<button type="button" role="tab" class="dsp-tab${on ? ' is-active' : ''}" aria-selected="${on}"
                    data-name="${escapeHtml(t.name)}" data-user="${t.isUser ? '1' : '0'}" title="${escapeHtml(t.name)}">
                    ${avatarHtml(t.name, 'dsp-tab-avatar')}
                    <span class="dsp-tab-name">${escapeHtml(t.name)}</span>
                    ${levelsOn && hasLevel(t.name, t.isUser) ? `<span class="dsp-tab-lv">${getProgress(t.name, t.isUser).level}</span>` : ''}
                    ${t.isUser ? '<span class="dsp-you">YOU</span>' : ''}
                </button>`;
            }).join('')}
        </nav>` : '';

    // Stats switched off in Settings are not shown.
    const stats = activeStats(getStatSheet(selected.name, selected.isUser));
    const cur = getCurrentStatValues(selected.name, selected.isUser, stats);
    const eff = getEffectiveStatValues(selected.name, selected.isUser, stats);
    const states = stats.filter(s => s.kind === 'state');
    const attrs = stats.filter(s => s.kind === 'attribute');

    // Which sections exist for this character, with a count where useful.
    const sections = [];
    if (states.length) sections.push({ id: 'stats' });
    if (attrs.length) sections.push({ id: 'attributes' });
    if (isEquipmentEnabled()) sections.push({ id: 'equipment', count: getEquipment(selected.name, selected.isUser).length });
    if (isAbilitiesEnabled()) sections.push({ id: 'abilities', count: getAbilities(selected.name, selected.isUser).length });
    if (!selected.isUser && isMemoriesEnabled()) sections.push({ id: 'memories', count: getMemories(selected.name).length });
    const prog = levelsOn ? getProgress(selected.name, selected.isUser) : null;
    if (levelsOn) sections.push({ id: 'xp', dot: prog.points > 0 });
    let section = getSection();
    if (!sections.some(x => x.id === section)) section = sections[0]?.id || 'stats';
    // Modifiers in effect, shown as a hint on the Attributes tab.
    const boosted = attrs.filter(s => eff.modifiers[s.id]?.total).length;

    const sectionBar = sections.length > 1 ? `
        <nav class="dsp-sections" role="tablist" aria-label="Sections">
            ${sections.map(sec => {
                const def = SECTIONS.find(x => x.id === sec.id);
                const on = sec.id === section;
                const badge = sec.dot ? '<span class="dsp-sec-dot is-up" title="Points to assign"></span>'
                    : sec.id === 'attributes' && prog?.points ? '<span class="dsp-sec-dot is-up" title="Points to assign"></span>'
                    : sec.id === 'attributes' && boosted ? '<span class="dsp-sec-dot" title="Bonuses in effect"></span>'
                    : (sec.count ? `<span class="dsp-sec-count">${sec.count}</span>` : '');
                return `<button type="button" role="tab" class="dsp-sec${on ? ' is-active' : ''}" aria-selected="${on}" data-section="${sec.id}" title="${def.label}">
                    <i class="fa-solid ${def.icon}"></i><span class="dsp-sec-label">${def.label}</span>${badge}</button>`;
            }).join('')}
        </nav>` : '';

    let content = '';
    if (section === 'stats') {
        content = `<section class="dsp-section">
            <div class="dsp-rings">${states.map(s => ringHtml(s, cur[s.id])).join('')}</div>
        </section>`;
    } else if (section === 'attributes') {
        content = `<section class="dsp-section">
            <p class="dsp-section-hint">${HUMAN_AVERAGE} average · ${HUMAN_PEAK} human peak · bonuses from equipped items, conditions and passive abilities are shown as +N</p>
            ${prog && prog.points ? `<div class="dsp-levelup"><i class="fa-solid fa-arrow-up"></i><span>Level up! <b>${prog.points}</b> point${prog.points === 1 ? '' : 's'} to assign — press + on an attribute.</span></div>` : ''}
            <div class="dsp-attrs">${attrs.map(s => attrHtml(s, cur[s.id], eff.values[s.id], eff.modifiers[s.id], prog)).join('')}</div>
        </section>`;
    } else if (section === 'equipment') {
        content = equipmentHtml();
    } else if (section === 'abilities') {
        content = abilitiesHtml();
    } else if (section === 'memories') {
        content = memoriesHtml();
    } else if (section === 'xp') {
        content = xpHtml(prog);
    }
    if (!sections.length) content = '<div class="dsp-empty">Everything is switched off in Settings → RPG &amp; Stats.</div>';

    return `
        ${head}
        ${tabsHtml}
        <div class="dsp-body">
            <section class="dsp-hero">
                ${avatarHtml(selected.name, 'dsp-hero-avatar')}
                <div class="dsp-hero-text">
                    <span class="dsp-hero-name">${escapeHtml(selected.name)}${heroLevelHtml()}</span>
                    <span class="dsp-hero-sub">${selected.isUser ? 'Your character' : 'Character'}${campaign ? ` · ${escapeHtml(campaign)}` : ''}</span>
                    ${heroExtrasHtml()}
                </div>
                <button type="button" class="dsp-text-btn" data-action="reset" title="Put every stat back to the starting values set in the Workshop">
                    <i class="fa-solid fa-rotate-left"></i> Reset
                </button>
            </section>
            ${checkPanelHtml()}
            ${isStatGenerationPending(selected.name, selected.isUser) ? `
            <div class="dsp-pending"><i class="fa-solid fa-wand-magic-sparkles"></i>
                The AI will generate ${escapeHtml(selected.name)}'s stats to fit who they are in their next reply. Until then these are placeholders.</div>` : ''}
            ${prog && prog.points && section !== 'attributes' ? `<button type="button" class="dsp-levelup is-link" data-section-go="attributes"><i class="fa-solid fa-arrow-up"></i><span>Level up! <b>${prog.points}</b> point${prog.points === 1 ? '' : 's'} to assign</span></button>` : ''}
            ${isConditionsEnabled() ? conditionsHtml() : ''}
            ${sectionBar}
            <div class="dsp-section-body" data-section="${section}">${content}</div>
            <p class="dsp-foot">Click a value or a name to change it. <i class="fa-solid fa-robot"></i> the AI updates it &middot; <i class="fa-solid fa-lock"></i> only you do.</p>
        </div>`;
}

// ─── Level & XP ─────────────────────────────────────────────────────────────

function xpHtml(prog) {
    const who = selected;
    const info = getLevelInfo(who.name, who.isUser);
    const xpOn = isXpEnabled();
    const party = who.isUser || prog.party;
    const { perLevel } = getXpSettings();
    const log = [...prog.log].reverse();
    const srcIcon = { ai: 'fa-robot', quest: 'fa-scroll', user: 'fa-user-pen' };
    const partyRow = who.isUser
        ? '<p class="dsp-section-hint">Your character always earns the party\'s XP.</p>'
        : `<label class="dsp-check dsp-party"><input type="checkbox" class="dsp-party-toggle"${prog.party ? ' checked' : ''}> In the party — earns the same XP as you</label>`;
    return `
        <section class="dsp-section dsp-xp">
            <div class="dsp-xp-top">
                <div class="dsp-xp-level">
                    <span class="dsp-xp-label">Level</span>
                    <button type="button" class="dsp-value dsp-xp-big" data-edit="level" title="Click to set the level (XP moves to the start of it)">${info.level}</button>
                </div>
                <div class="dsp-xp-progress">
                    ${party && xpOn ? `
                    <div class="dsp-xpbar is-big"><span style="width:${info.pct}%"></span></div>
                    <div class="dsp-xp-nums"><span>${info.into} / ${info.needed} XP</span><span>${info.level >= MAX_LEVEL ? 'max level' : `to level ${info.level + 1}`}</span></div>
                    <div class="dsp-xp-nums is-dim"><span>${info.xp} XP in total</span><span>${perLevel} × level per level</span></div>`
                    : `<div class="dsp-xp-nums is-dim"><span>${xpOn ? 'Not in the party: earns no XP.' : 'Experience is off in Settings.'}</span></div>`}
                </div>
                <div class="dsp-xp-level">
                    <span class="dsp-xp-label">Points</span>
                    <button type="button" class="dsp-value dsp-xp-big${prog.points ? ' is-up' : ''}" data-edit="points" title="Attribute points still to assign (click to change)">${prog.points}</button>
                </div>
            </div>
            ${partyRow}
            ${isSphereEnabled() ? `<div class="dsp-xp-add"><button type="button" class="dsp-text-btn" data-action="sphere" title="Spend points on ${escapeHtml(who.name)}'s growth grid"><i class="fa-solid fa-diagram-project"></i> Sphere grid${prog.points ? ` — ${prog.points} point${prog.points === 1 ? '' : 's'} to spend` : ''}</button></div>` : ''}
            ${xpOn && party ? `
            <div class="dsp-xp-add">
                <input type="number" class="dsp-xp-in-amount" data-xp-field="amount" value="${escapeHtml(xpForm.amount)}" placeholder="XP" step="1" aria-label="XP to add (negative to take away)">
                <input type="text" class="dsp-xp-in-reason" data-xp-field="reason" value="${escapeHtml(xpForm.reason)}" placeholder="Reason (optional)" maxlength="120" aria-label="Reason">
                <button type="button" class="dsp-text-btn" data-action="xp-add" title="Give ${escapeHtml(who.name)} this XP (just them)"><i class="fa-solid fa-plus"></i> Add</button>
            </div>` : ''}
            <div class="dsp-subhead"><i class="fa-solid fa-scroll"></i> Experience log <span>${log.length || ''}</span></div>
            ${log.length ? `<div class="dsp-xplog">${log.map(e => `
                <div class="dsp-xplog-row${e.amount < 0 ? ' is-neg' : ''}" data-id="${escapeHtml(e.id)}">
                    <i class="fa-solid ${srcIcon[e.source] || 'fa-star'} dsp-xplog-src" title="${e.source === 'ai' ? 'From the story' : e.source === 'quest' ? 'Quest completed' : 'Added by you'}"></i>
                    <span class="dsp-xplog-amt">${escapeHtml(formatXpAmount(e.amount))}</span>
                    <span class="dsp-xplog-reason">${escapeHtml(e.reason || '—')}${e.level ? ` <span class="dsp-xplog-lv">→ Lv ${e.level}</span>` : ''}</span>
                    <button type="button" class="dsp-item-remove dsp-xplog-del" title="Delete this entry and take its XP back (the level stays)"><i class="fa-solid fa-xmark"></i></button>
                </div>`).join('')}</div>`
            : '<div class="dsp-items-empty is-small">Nothing earned yet. The AI awards XP for real accomplishments; completing a quest in the Quests panel does too.</div>'}
        </section>`;
}

/** Inline number edit for the level and the unspent points. */
function startProgressEdit(button) {
    if (!selected) return;
    const field = button.getAttribute('data-edit');
    const prog = getProgress(selected.name, selected.isUser);
    const doc = button.ownerDocument;
    const input = doc.createElement('input');
    input.type = 'number';
    const range = {
        level: ['1', String(MAX_LEVEL), '1', prog.level],
        points: ['0', '999', '1', prog.points],
        money: ['0', '', '0.01', getMoney(selected.name, selected.isUser) ?? 0],
        affinity: ['-100', '100', '1', getAffinityRecord(selected.name)?.value ?? 0],
    }[field];
    input.min = range[0];
    if (range[1]) input.max = range[1];
    input.step = range[2];
    input.value = String(range[3]);
    input.className = field === 'level' || field === 'points' ? 'dsp-value-input dsp-xp-big' : 'dsp-value-input dsp-chip-input';
    button.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const who = { ...selected };
    const finish = (commit) => {
        if (done) return;
        done = true;
        const raw = Number(input.value);
        const n = Math.round(raw);
        if (commit && Number.isFinite(raw) && input.value !== '') {
            if (field === 'level' && n !== prog.level) setLevel(who.name, who.isUser, n);
            else if (field === 'points' && n !== prog.points) setUnspentPoints(who.name, who.isUser, n);
            else if (field === 'money' && raw !== range[3]) setMoney(who.name, who.isUser, raw);
            else if (field === 'affinity' && n !== range[3]) setAffinity(who.name, n);
        }
        input.blur();
        renderAll();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
}

function submitXpForm() {
    if (!selected) return;
    const n = Math.round(Number(xpForm.amount));
    if (!Number.isFinite(n) || !n) return;
    awardXpTo(selected.name, selected.isUser, n, { reason: xpForm.reason || 'Added by hand', source: 'user' });
    xpForm.amount = '';
    xpForm.reason = '';
    renderAll();
}

// ─── Memories (NPCs) ────────────────────────────────────────────────────────

function memoriesHtml() {
    const list = getMemories(selected.name);
    const faded = fadedIds(list, getRecentLimit());
    if (!list.length) {
        return '<div class="dsp-items-empty">No memories yet. The AI adds one when something important happens to them — or add them in the Workshop\'s Memories tab.</div>';
    }
    return `
        <section class="dsp-section dsp-memories">
            <p class="dsp-section-hint">Newest first · ★ always remembered · faded ones are kept but no longer sent · add or rewrite them in the Workshop</p>
            <div class="dsp-mems">
                ${[...list].reverse().map(m => `
                <div class="dsp-mem${m.important ? ' is-important' : ''}${faded.has(m.id) ? ' is-faded' : ''}" data-id="${escapeHtml(m.id)}">
                    <button type="button" class="dsp-mem-star" title="${m.important ? 'Important — click to make it a normal memory' : 'Make it important'}">${m.important ? '★' : '☆'}</button>
                    <span class="dsp-mem-text">${escapeHtml(m.text)}</span>
                    ${faded.has(m.id) ? '<span class="dsp-mem-tag">faded</span>' : ''}
                    <button type="button" class="dsp-item-remove dsp-mem-del" title="Delete memory"><i class="fa-solid fa-xmark"></i></button>
                </div>`).join('')}
            </div>
        </section>`;
}

// ─── Equipment ──────────────────────────────────────────────────────────────

function effectText(effects) {
    return effects && Object.keys(effects).length ? describeEffects(selected.name, selected.isUser, effects) : '';
}

/** What an item or a spell counts for in a fight, as a short chip (only when Combat is on). */
function combatChip(kind, entry, idle = false) {
    if (!selected || !isCombatEnabled()) return '';
    const { profile } = getActionProfile(selected.name, selected.isUser, kind, entry);
    if (!profile || (kind === 'item' && profile.type === 'none')) return '';
    const txt = profile.type === 'gear'
        ? (profile.atk || profile.def ? [profile.atk ? `⚔${profile.atk}` : '', profile.def ? `🛡${profile.def}` : ''].filter(Boolean).join(' ') : '')
        : describeProfile(profile);
    if (!txt) return '';
    return `<span class="dsp-item-eff dsp-item-gear${idle ? ' is-idle' : ''}" title="In a fight: ${escapeHtml(describeProfile(profile))}${idle ? ' (when equipped)' : ''}">${escapeHtml(txt)}</span>`;
}

function itemHtml(raw) {
    const item = normalizeItem({ ...raw });
    const locked = item.aiCanRemove === false;
    const eff = effectText(item.effects);
    const tip = [item.name + (item.qty > 1 ? ` ×${item.qty}` : ''), item.desc, eff && `${eff}${item.equipped ? '' : ' (when equipped)'}`].filter(Boolean).join(' — ');
    return `
        <div class="dsp-item${locked ? ' is-locked' : ''}${item.equipped ? ' is-equipped' : ''}" data-id="${escapeHtml(item.id)}" data-tip="${escapeHtml(tip)}">
            <span class="dsp-item-icon" tabindex="0" aria-label="${escapeHtml(tip)}">${escapeHtml(item.icon || DEFAULT_ICON)}</span>
            <span class="dsp-item-main dsp-edit-open" title="Click to edit">
                <span class="dsp-item-name">${escapeHtml(item.name)}</span>
                ${eff ? `<span class="dsp-item-eff${item.equipped ? '' : ' is-idle'}">${escapeHtml(eff)}</span>` : ''}
                ${combatChip('item', item, !item.equipped)}
            </span>
            <span class="dsp-qty" title="Quantity">
                <button type="button" class="dsp-qty-btn" data-qty="-1" title="One less">−</button>
                <span class="dsp-qty-n">${item.qty}</span>
                <button type="button" class="dsp-qty-btn" data-qty="1" title="One more">+</button>
            </span>
            <button type="button" class="dsp-item-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="dsp-item-equip" aria-pressed="${item.equipped}"
                title="${item.equipped ? 'Equipped — click to put it in the backpack' : 'In the backpack — click to equip it'}">
                <i class="fa-solid ${item.equipped ? 'fa-hand-fist' : 'fa-box-archive'}"></i></button>
            <button type="button" class="dsp-item-lock" aria-pressed="${locked}"
                title="${locked ? 'Locked: the AI cannot remove it. Click to let the AI remove it' : 'The AI can remove it. Click to lock it'}">
                <i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
            <button type="button" class="dsp-item-remove" title="Remove ${escapeHtml(item.name)}"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

const CB_TYPES = [
    ['damage', 'Damage'], ['heal', 'Heals'], ['status', 'Status effect'], ['mana', 'Restores Mana'],
    ['cure', 'Cures bad statuses'], ['revive', 'Revives a fallen ally'],
];
const CB_TARGETS = {
    damage: [['enemy', 'One enemy'], ['enemies', 'All enemies']],
    heal: [['ally', 'One ally'], ['allies', 'All allies'], ['self', 'Self']],
    mana: [['ally', 'One ally'], ['allies', 'All allies'], ['self', 'Self']],
    cure: [['ally', 'One ally'], ['allies', 'All allies'], ['self', 'Self']],
    status: [['self', 'Self'], ['ally', 'One ally'], ['allies', 'All allies'], ['enemy', 'One enemy'], ['enemies', 'All enemies']],
};

function cbSelect(field, options, value) {
    return `<select class="dsp-cb" data-cb="${field}">${options.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>`;
}

/** The "Combat" part of an item / spell / skill form: what it does in a fight. */
function combatBlockHtml(kind) {
    if ((kind !== 'item' && kind !== 'ability') || !isCombatEnabled()) return '';
    const f = itemForm;
    const types = [['', `Automatic${f.cbAuto ? ` — ${describeProfile(f.cbAuto)}` : ''}`]];
    if (kind === 'item') types.push(['gear', 'Weapon / armour']);
    types.push(...CB_TYPES, ['none', kind === 'item' ? 'Nothing in a fight' : 'Passive — not used in a fight']);
    const rows = [`<label>Effect ${cbSelect('cbType', types, f.cbType)}</label>`];
    const t = f.cbType;
    const power = [['light', 'Light'], ['medium', 'Medium'], ['heavy', 'Heavy']];
    const stats = [...COMBAT_ATTRS.map(a => [a, a.toUpperCase()]), ['none', 'Fixed']];
    if (['damage', 'heal', 'mana', 'revive'].includes(t)) rows.push(`<label>Power ${cbSelect('cbPower', power, f.cbPower)}</label>`);
    if (t === 'damage' || t === 'heal') rows.push(`<label>Scales with ${cbSelect('cbStat', stats, f.cbStat || 'str')}</label>`);
    if (CB_TARGETS[t]) rows.push(`<label>Target ${cbSelect('cbTarget', CB_TARGETS[t], f.cbTarget)}</label>`);
    if (t === 'damage') rows.push(`<label>May cause ${cbSelect('cbStatus', [['', 'Nothing'], ...COMBAT_STATUS_IDS.map(id => [id, `${COMBAT_STATUSES[id].icon} ${COMBAT_STATUSES[id].name}`])], f.cbStatus)}</label>`);
    if (t === 'status') rows.push(`<label>Status ${cbSelect('cbStatus', COMBAT_STATUS_IDS.map(id => [id, `${COMBAT_STATUSES[id].icon} ${COMBAT_STATUSES[id].name}`]), f.cbStatus || 'shield')}</label>`);
    if ((t === 'damage' || t === 'status') && f.cbStatus) {
        rows.push(`<label>Lasts ${cbSelect('cbStatusTurns', [['', COMBAT_STATUSES[f.cbStatus]?.id === 'stun' ? '1 turn (always)' : 'Standard (3 turns)'], ...[1, 2, 3, 4, 5].map(n => [String(n), `${n} turn${n === 1 ? '' : 's'}`])], f.cbStatusTurns)}</label>`);
    }
    if (t === 'damage' && f.cbStatus) {
        rows.push(`<label>Chance ${cbSelect('cbStatusChance', [['', 'Standard (60%)'], ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => [String(n), `${n}%`])], f.cbStatusChance)}</label>`);
    }
    if (t === 'gear') {
        rows.push(`<label>Attack <input type="number" class="dsp-item-in-atk" data-field="atk" data-gear="1" value="${escapeHtml(f.atk)}" placeholder="0" min="0" max="15" step="1"></label>`);
        rows.push(`<label>Defence <input type="number" class="dsp-item-in-def" data-field="def" data-gear="1" value="${escapeHtml(f.def)}" placeholder="0" min="0" max="15" step="1"></label>`);
    }
    const hint = !t ? 'Left on Automatic, the AI labels it (or its name decides) the first time a fight starts.'
        : t === 'gear' ? 'Counts while equipped: Attack adds to physical attacks, Defence to armour.'
            : t === 'none' ? 'It stays out of the fight.' : '';
    return `<div class="dsp-item-form-row dsp-gear-row">
        <span class="dsp-gear-label">⚔ In combat</span>${rows.join('')}
        ${hint ? `<span class="dsp-gear-note">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

/** Sensible starting values when the effect type is chosen (the automatic ones if they match). */
function applyCombatDefaults() {
    const f = itemForm;
    const t = f.cbType;
    if (!t) return;
    const auto = f.cbAuto && f.cbAuto.type === t ? f.cbAuto : null;
    const spell = f.kind === 'ability' && f.type === 'spell';
    f.cbPower = auto?.power || 'medium';
    f.cbStat = auto && auto.stat !== 'none' ? auto.stat : (t === 'damage' ? (spell ? 'int' : 'str') : t === 'heal' ? (spell ? 'wis' : 'str') : 'none');
    f.cbStatus = auto?.status || (t === 'status' ? 'shield' : '');
    f.cbStatusTurns = auto?.statusTurns ? String(auto.statusTurns) : '';
    f.cbStatusChance = auto?.statusChance ? String(Math.round(auto.statusChance * 100)) : '';
    f.cbTarget = auto?.target || (t === 'damage' ? 'enemy' : t === 'status' ? (COMBAT_STATUSES[f.cbStatus]?.bad ? 'enemy' : 'ally') : 'ally');
    f.atk = String(auto?.atk ?? 0);
    f.def = String(auto?.def ?? 0);
}

/** Fills the form's combat fields from what the fight would use for this entry. */
function loadCombatFields(kind, entry) {
    const f = itemForm;
    const { stored, profile } = getActionProfile(selected.name, selected.isUser, kind, entry);
    f.cbAuto = stored ? null : profile;
    if (stored) {
        Object.assign(f, {
            cbType: profile.type, cbPower: profile.power, cbStat: profile.stat, cbTarget: profile.target,
            cbStatus: profile.status || '', atk: String(profile.atk ?? 0), def: String(profile.def ?? 0),
            cbStatusTurns: profile.statusTurns ? String(profile.statusTurns) : '',
            cbStatusChance: profile.statusChance ? String(Math.round(profile.statusChance * 100)) : '',
        });
    } else {
        f.cbType = '';
    }
}

function formHtml(kind) {
    const f = itemForm;
    if (!f.open || f.kind !== kind) return '';
    const isItem = kind === 'item';
    const isAbility = kind === 'ability';
    const emoji = isItem ? ITEM_EMOJI : (isAbility ? ABILITY_EMOJI : CONDITION_EMOJI);
    const mana = isAbility ? activeManaTiers() : null;
    const iconPh = isItem ? DEFAULT_ICON : (isAbility ? (f.type === 'spell' ? DEFAULT_SPELL_ICON : DEFAULT_ABILITY_ICON) : DEFAULT_CONDITION_ICON);
    const namePh = isItem ? 'Item name' : (isAbility ? 'Name (e.g. Fireball, Lockpicking)' : 'Condition (e.g. Poisoned)');
    const effPh = isItem ? 'Effects while equipped, e.g. STR +2, DEX -1 (optional)'
        : isAbility ? 'Passive effects, always on, e.g. CON +1 (optional)'
            : 'Effects while it lasts, e.g. DEX -3 (optional)';
    return `
        <div class="dsp-item-form${f.editId ? ' is-edit' : ''}">
            ${f.editId ? `<div class="dsp-form-title"><i class="fa-solid fa-pen"></i> Edit</div>` : ''}
            <div class="dsp-item-form-row">
                <input type="text" class="dsp-item-in-icon" data-field="icon" value="${escapeHtml(f.icon)}" placeholder="${iconPh}" maxlength="8" aria-label="Icon (emoji)">
                <input type="text" class="dsp-item-in-name" data-field="name" value="${escapeHtml(f.name)}" placeholder="${namePh}" maxlength="40" aria-label="Name">
                ${isItem ? `<input type="number" class="dsp-item-in-qty" data-field="qty" value="${escapeHtml(f.qty)}" min="1" max="999" step="1" aria-label="Quantity" title="Quantity">` : ''}
                ${isAbility ? `<select class="dsp-item-in-type" aria-label="Type">
                    <option value="spell"${f.type === 'spell' ? ' selected' : ''}>Spell</option>
                    <option value="ability"${f.type !== 'spell' ? ' selected' : ''}>Ability</option></select>` : ''}
                ${isAbility && f.type === 'spell' && mana ? `<select class="dsp-item-in-cost" aria-label="Mana cost" title="Mana cost">
                    <option value=""${!f.cost ? ' selected' : ''}>Free</option>
                    ${['light', 'medium', 'heavy'].map(t => `<option value="${t}"${f.cost === t ? ' selected' : ''}>${t[0].toUpperCase() + t.slice(1)} · ${mana[t]} Mana</option>`).join('')}
                    </select>` : ''}
            </div>
            <div class="dsp-emoji-grid" role="listbox" aria-label="Pick an icon">
                ${emoji.map(e => `<button type="button" class="dsp-emoji${f.icon === e ? ' is-on' : ''}" data-emoji="${escapeHtml(e)}">${e}</button>`).join('')}
            </div>
            <input type="text" class="dsp-item-in-desc" data-field="desc" value="${escapeHtml(f.desc)}" placeholder="Very short description (shown on hover)" maxlength="120" aria-label="Description">
            <input type="text" class="dsp-item-in-eff" data-field="effects" value="${escapeHtml(f.effects)}" placeholder="${effPh}" maxlength="80" aria-label="Effects">
            ${combatBlockHtml(kind)}
            <div class="dsp-item-form-row">
                ${isItem ? `<label class="dsp-check"><input type="checkbox" class="dsp-item-in-equipped" ${f.equipped ? 'checked' : ''}> Equipped</label>` : ''}
                ${isItem || isAbility ? `<label class="dsp-check"><input type="checkbox" class="dsp-item-in-ai" ${f.aiCanRemove ? 'checked' : ''}> AI can remove</label>` : ''}
                <span class="dsp-item-error" role="alert">${escapeHtml(f.error)}</span>
                <button type="button" class="dsp-text-btn" data-action="item-cancel">Cancel</button>
                <button type="button" class="dsp-text-btn is-primary" data-action="item-add">${f.editId ? 'Save' : 'Add'}</button>
            </div>
        </div>`;
}

/** Opens the form on an existing entry, filled in. */
function openEdit(kind, id) {
    if (!selected) return;
    const list = kind === 'item' ? getEquipment(selected.name, selected.isUser)
        : kind === 'ability' ? getAbilities(selected.name, selected.isUser)
            : getConditions(selected.name, selected.isUser);
    const e = list.find(x => x.id === id);
    if (!e) return;
    resetForm();
    if (FORM_SECTION[kind]) setSection(FORM_SECTION[kind]);
    Object.assign(itemForm, {
        open: true, kind, editId: id,
        icon: e.icon || '', name: e.name || '', desc: e.desc || '',
        effects: e.effects && Object.keys(e.effects).length ? effectText(e.effects) : '',
        qty: String(e.qty || 1), equipped: !!e.equipped,
        aiCanRemove: e.aiCanRemove !== false, type: e.type === 'spell' ? 'spell' : 'ability',
        cost: e.cost || '',
    });
    if (kind === 'item' || kind === 'ability') loadCombatFields(kind === 'item' ? 'item' : (e.type === 'spell' ? 'spell' : 'ability'), e);
    renderAll();
}

function equipmentHtml() {
    const items = getEquipment(selected.name, selected.isUser);
    const f = itemForm;
    const on = items.filter(i => i.equipped);
    const pack = items.filter(i => !i.equipped);
    const seeding = needsStartingGear(selected.name, selected.isUser);
    const seedNote = seeding
        ? `<div class="dsp-gear-note"><i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>In its next reply the AI will add what ${escapeHtml(selected.name)} already carries, from ${selected.isUser ? 'your persona description' : 'their description'} and the scene.</span>
                <button type="button" class="dsp-text-btn" data-action="gear-cancel" title="Don't ask">Cancel</button></div>`
        : '';
    const formOpen = f.open && f.kind === 'item';
    return `
        <section class="dsp-section dsp-equip">
            <h3 class="dsp-section-title"><span class="dsp-title-text">Equipment <span class="dsp-scale">${items.length || ''}</span></span>
                ${seeding ? '' : '<button type="button" class="dsp-text-btn dsp-item-new dsp-gear-btn" data-action="gear-request" title="Ask the AI, in its next reply, to add what this character already carries"><i class="fa-solid fa-wand-magic-sparkles"></i> Starting gear</button>'}
                ${formOpen ? '' : `<button type="button" class="dsp-text-btn dsp-item-new${seeding ? '' : ' is-second'}" data-action="item-open" data-kind="item"><i class="fa-solid fa-plus"></i> Add item</button>`}</h3>
            ${seedNote}
            ${items.length ? `
                <div class="dsp-subhead"><i class="fa-solid fa-hand-fist"></i> Equipped <span>${on.length || ''}</span></div>
                ${on.length ? `<div class="dsp-items">${on.map(itemHtml).join('')}</div>` : '<div class="dsp-items-empty is-small">Nothing equipped — click <i class="fa-solid fa-box-archive"></i> on an item to equip it.</div>'}
                <div class="dsp-subhead"><i class="fa-solid fa-box-archive"></i> Backpack <span>${pack.length || ''}</span></div>
                ${pack.length ? `<div class="dsp-items">${pack.map(itemHtml).join('')}</div>` : '<div class="dsp-items-empty is-small">Empty.</div>'}`
            : (formOpen ? '' : '<div class="dsp-items-empty">Nothing yet. The AI adds what is picked up, bought, given or shown being used — or add it yourself.</div>')}
            ${formHtml('item')}
        </section>`;
}

function conditionsHtml() {
    const list = getConditions(selected.name, selected.isUser);
    const formOpen = itemForm.open && itemForm.kind === 'condition';
    if (!list.length && !formOpen) {
        return `<div class="dsp-cond-bar is-empty"><span>No conditions</span>
            <button type="button" class="dsp-text-btn dsp-cond-add" data-action="item-open" data-kind="condition"><i class="fa-solid fa-plus"></i> Condition</button></div>`;
    }
    return `
        <section class="dsp-section dsp-conditions">
            <h3 class="dsp-section-title">Conditions
                ${formOpen ? '' : '<button type="button" class="dsp-text-btn dsp-item-new" data-action="item-open" data-kind="condition"><i class="fa-solid fa-plus"></i> Add</button>'}</h3>
            ${list.length ? `<div class="dsp-conds">${list.map(c => {
                const eff = effectText(c.effects);
                const auto = c.source === 'auto';
                const tip = [c.name, c.desc, eff, auto && 'automatic: ends by itself when the bar recovers'].filter(Boolean).join(' — ');
                return `<span class="dsp-cond${auto ? ' is-auto' : ''}" data-id="${escapeHtml(c.id)}" data-tip="${escapeHtml(tip)}" tabindex="0" aria-label="${escapeHtml(tip)}">
                    <span class="dsp-cond-icon">${escapeHtml(c.icon || DEFAULT_CONDITION_ICON)}</span>
                    <span class="dsp-cond-name${auto ? '' : ' dsp-edit-open'}" title="${auto ? 'Follows a low stat bar' : 'Click to edit'}">${escapeHtml(c.name)}</span>
                    ${eff ? `<span class="dsp-cond-eff">${escapeHtml(eff)}</span>` : ''}
                    ${auto ? '<span class="dsp-cond-auto" title="Automatic — follows a low stat bar">auto</span>' : `<button type="button" class="dsp-cond-remove" title="End ${escapeHtml(c.name)}"><i class="fa-solid fa-xmark"></i></button>`}
                </span>`;
            }).join('')}</div>` : ''}
            ${formHtml('condition')}
        </section>`;
}

function abilityRowHtml(a) {
    const locked = a.aiCanRemove === false;
    const eff = effectText(a.effects);
    const mana = activeManaTiers();
    const cost = mana && a.type === 'spell' && a.cost ? mana[a.cost] : null;
    const tip = [a.name, a.desc, cost !== null && `${cost} Mana (${a.cost})`, eff && `${eff} (passive)`].filter(Boolean).join(' — ');
    return `
        <div class="dsp-item dsp-ability${locked ? ' is-locked' : ''}" data-id="${escapeHtml(a.id)}" data-tip="${escapeHtml(tip)}">
            <span class="dsp-item-icon" tabindex="0" aria-label="${escapeHtml(tip)}">${escapeHtml(a.icon)}</span>
            <span class="dsp-item-main dsp-edit-open" title="Click to edit">
                <span class="dsp-item-name">${escapeHtml(a.name)}</span>
                ${eff ? `<span class="dsp-item-eff">${escapeHtml(eff)}</span>` : ''}
                ${combatChip(a.type === 'spell' ? 'spell' : 'ability', a)}
            </span>
            ${cost !== null ? `<span class="dsp-mana-cost" title="${cost} Mana (${escapeHtml(a.cost)})">💧${cost}</span>` : ''}
            <button type="button" class="dsp-item-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="dsp-item-lock" aria-pressed="${locked}"
                title="${locked ? 'Locked: the AI cannot remove it. Click to let the AI remove it' : 'The AI can remove it. Click to lock it'}">
                <i class="fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
            <button type="button" class="dsp-item-remove" title="Remove ${escapeHtml(a.name)}"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
}

function abilitiesHtml() {
    const list = getAbilities(selected.name, selected.isUser);
    const spells = list.filter(a => a.type === 'spell');
    const skills = list.filter(a => a.type !== 'spell');
    const formOpen = itemForm.open && itemForm.kind === 'ability';
    const seeding = needsStartingAbilities(selected.name, selected.isUser);
    const seedNote = seeding
        ? `<div class="dsp-gear-note"><i class="fa-solid fa-wand-magic-sparkles"></i>
                <span>In its next reply the AI will add the spells and abilities ${escapeHtml(selected.name)} already knows, from ${selected.isUser ? 'your persona description' : 'their description'} and the scene.</span>
                <button type="button" class="dsp-text-btn" data-action="abl-cancel" title="Don't ask">Cancel</button></div>`
        : '';
    return `
        <section class="dsp-section dsp-equip dsp-abilities">
            <h3 class="dsp-section-title"><span class="dsp-title-text">Spells &amp; Abilities <span class="dsp-scale">${list.length || ''}</span></span>
                ${seeding ? '' : '<button type="button" class="dsp-text-btn dsp-item-new" data-action="abl-request" title="Ask the AI, in its next reply, to add what this character already knows"><i class="fa-solid fa-wand-magic-sparkles"></i> Starting</button>'}
                ${formOpen ? '' : `<button type="button" class="dsp-text-btn dsp-item-new${seeding ? '' : ' is-second'}" data-action="item-open" data-kind="ability"><i class="fa-solid fa-plus"></i> Add</button>`}</h3>
            ${seedNote}
            ${list.length ? `
                ${spells.length ? `<div class="dsp-subhead"><i class="fa-solid fa-hat-wizard"></i> Spells <span>${spells.length}</span></div>
                <div class="dsp-items">${spells.map(abilityRowHtml).join('')}</div>` : ''}
                ${skills.length ? `<div class="dsp-subhead"><i class="fa-solid fa-star"></i> Abilities <span>${skills.length}</span></div>
                <div class="dsp-items">${skills.map(abilityRowHtml).join('')}</div>` : ''}`
            : (formOpen ? '' : '<div class="dsp-items-empty">Nothing yet. The AI adds what is learned or shown being used — or add it yourself.</div>')}
            ${formHtml('ability')}
        </section>`;
}

function submitItemForm() {
    if (!selected) return;
    const f = itemForm;
    const who = [selected.name, selected.isUser];
    let res;
    if (f.editId) {
        if (f.kind === 'condition') res = updateCondition(...who, f.editId, { icon: f.icon, name: f.name, desc: f.desc, effects: f.effects });
        else if (f.kind === 'ability') res = updateAbility(...who, f.editId, { icon: f.icon, name: f.name, desc: f.desc, effects: f.effects, type: f.type, cost: f.cost || null, aiCanRemove: f.aiCanRemove });
        else res = updateItem(...who, f.editId, { icon: f.icon, name: f.name, desc: f.desc, effects: f.effects, qty: f.qty, equipped: f.equipped, aiCanRemove: f.aiCanRemove });
    } else if (f.kind === 'condition') {
        res = addCondition(...who, { icon: f.icon, name: f.name, desc: f.desc, effects: f.effects });
    } else if (f.kind === 'ability') {
        res = addAbility(...who, { icon: f.icon, name: f.name, desc: f.desc, effects: f.effects, type: f.type, cost: f.cost || null, aiCanRemove: f.aiCanRemove });
    } else {
        res = addItem(...who, {
            icon: f.icon, name: f.name, desc: f.desc, effects: f.effects,
            qty: f.qty, equipped: f.equipped, aiCanRemove: f.aiCanRemove,
        });
    }
    if (res && res.error) { f.error = res.error; renderAll(); return; }
    if ((f.kind === 'item' || f.kind === 'ability') && f.gearTouched && isCombatEnabled()) {
        const num = (v) => Math.max(0, Math.min(15, Math.round(Number(v)) || 0));
        const kind = f.kind === 'item' ? 'item' : (f.type === 'spell' ? 'spell' : 'ability');
        setActionProfile(selected.name, selected.isUser, kind, f.name.trim(), f.cbType ? {
            type: f.cbType, power: f.cbPower || 'medium', stat: f.cbStat || 'none', target: f.cbTarget,
            status: f.cbStatus || undefined, atk: num(f.atk), def: num(f.def),
            statusTurns: f.cbStatus && f.cbStatusTurns ? Number(f.cbStatusTurns) : undefined,
            statusChance: f.cbStatus && f.cbType === 'damage' && f.cbStatusChance ? Number(f.cbStatusChance) / 100 : undefined,
        } : null);
    }
    resetForm();
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
            resetForm();
            renderAll();
            return;
        }
        const sec = e.target.closest('.dsp-sec');
        if (sec) {
            setSection(sec.getAttribute('data-section'));
            if (itemForm.open) resetForm();
            renderAll();
            const body = root.querySelector('.dsp-body');
            const bar = root.querySelector('.dsp-sections');
            if (body && bar && body.scrollTop > bar.offsetTop) body.scrollTop = bar.offsetTop;
            return;
        }
        const mem = e.target.closest('.dsp-mem');
        if (mem && selected) {
            const id = mem.getAttribute('data-id');
            if (e.target.closest('.dsp-mem-star')) {
                const m = getMemories(selected.name).find(x => x.id === id);
                if (m) updateMemory(selected.name, id, { important: !m.important });
                return;
            }
            if (e.target.closest('.dsp-mem-del')) { deleteMemory(selected.name, id); return; }
        }
        const emoji = e.target.closest('.dsp-emoji');
        if (emoji) { itemForm.icon = emoji.getAttribute('data-emoji'); renderAll(); return; }
        const ablRow = e.target.closest('.dsp-ability');
        if (ablRow && selected) {
            const id = ablRow.getAttribute('data-id');
            const a = getAbilities(selected.name, selected.isUser).find(x => x.id === id);
            if (!a) return;
            if (e.target.closest('.dsp-item-edit, .dsp-edit-open')) { openEdit('ability', id); return; }
            if (e.target.closest('.dsp-item-lock')) { updateAbility(selected.name, selected.isUser, id, { aiCanRemove: a.aiCanRemove === false }); return; }
            if (e.target.closest('.dsp-item-remove')) { removeAbility(selected.name, selected.isUser, id); return; }
            return;
        }
        const itemRow = e.target.closest('.dsp-item');
        if (itemRow && selected) {
            const id = itemRow.getAttribute('data-id');
            const item = getEquipment(selected.name, selected.isUser).find(i => i.id === id);
            if (!item) return;
            if (e.target.closest('.dsp-item-edit, .dsp-edit-open')) { openEdit('item', id); return; }
            if (e.target.closest('.dsp-item-lock')) { updateItem(selected.name, selected.isUser, id, { aiCanRemove: item.aiCanRemove === false }); return; }
            if (e.target.closest('.dsp-item-equip')) { updateItem(selected.name, selected.isUser, id, { equipped: !item.equipped }); return; }
            const qtyBtn = e.target.closest('.dsp-qty-btn');
            if (qtyBtn) {
                const next = item.qty + Number(qtyBtn.getAttribute('data-qty'));
                if (next <= 0 && !(root.ownerDocument.defaultView || window).confirm(`Remove ${item.name}?`)) return;
                updateItem(selected.name, selected.isUser, id, { qty: next });
                return;
            }
            if (e.target.closest('.dsp-item-remove')) { removeItem(selected.name, selected.isUser, id); return; }
        }
        const cond = e.target.closest('.dsp-cond');
        if (cond && selected && e.target.closest('.dsp-cond-remove')) {
            removeCondition(selected.name, selected.isUser, cond.getAttribute('data-id'));
            return;
        }
        if (cond && selected && e.target.closest('.dsp-edit-open')) { openEdit('condition', cond.getAttribute('data-id')); return; }
        const pointBtn = e.target.closest('.dsp-point-btn');
        if (pointBtn && selected) {
            const id = pointBtn.getAttribute('data-stat');
            if (pointBtn.getAttribute('data-point') === 'spend') spendPoint(selected.name, selected.isUser, id);
            else refundPoint(selected.name, selected.isUser, id);
            return;
        }
        const go = e.target.closest('[data-section-go]');
        if (go) { setSection(go.getAttribute('data-section-go')); resetForm(); renderAll(); return; }
        const logRow = e.target.closest('.dsp-xplog-row');
        if (logRow && selected && e.target.closest('.dsp-xplog-del')) {
            removeLogEntry(selected.name, selected.isUser, logRow.getAttribute('data-id'));
            return;
        }
        const progEdit = e.target.closest('button.dsp-value[data-edit], button.dsp-chip[data-edit]');
        if (progEdit) { startProgressEdit(progEdit); return; }
        const value = e.target.closest('button.dsp-value');
        if (value) { startEdit(value); return; }
        const action = e.target.closest('[data-action]')?.getAttribute('data-action');
        if (action === 'item-open') {
            const kind = e.target.closest('[data-kind]')?.getAttribute('data-kind') || 'item';
            if (!itemForm.open || itemForm.kind !== kind) { resetForm(); itemForm.kind = kind; }
            itemForm.open = true;
            itemForm.error = '';
            renderAll();
            root.querySelector('.dsp-item-in-name')?.focus();
            return;
        }
        if (action === 'item-cancel') { resetForm(); renderAll(); return; }
        if (action === 'item-add') { submitItemForm(); return; }
        if (action === 'xp-add') { submitXpForm(); return; }
        if (action === 'check-toggle') { checkForm.open = !checkForm.open; if (!checkForm.open) checkForm.last = null; renderAll(); return; }
        if (action === 'check-roll' && selected) {
            // Some browsers do not focus a button on click: leave the text field so the repaint is not held back.
            try { root.ownerDocument.activeElement?.blur?.(); } catch (err) { /* no focus */ }
            const diff = resolveDifficulty(checkForm.difficulty);
            doRoll(selected.name, selected.isUser, { stat: checkForm.stat, difficulty: diff.id || diff.dc, bonus: Number(checkForm.bonus) || 0, reason: checkForm.reason, source: 'player' });
            return;
        }
        if (action === 'check-roll-pending') {
            try { root.ownerDocument.activeElement?.blur?.(); } catch (err) { /* no focus */ }
            const p = getPendingCheck();
            const actor = pendingActor(p);
            if (p && actor) doRoll(actor.name, actor.isUser, { stat: p.stat, difficulty: p.difficulty || p.dc, bonus: 0, reason: p.reason, source: 'ai' });
            return;
        }
        if (action === 'check-dismiss') { dismissPendingCheck(); renderAll(); return; }
        if (action === 'sphere') { import('./sphereModal.js').then(m => m.openSphereGrid(selected?.name, !!selected?.isUser)).catch(e => console.error('[Dooms Tracker] Sphere grid failed to open', e)); return; }
        if (action === 'dungeon') { import('./dungeonModal.js').then(m => m.openDungeon()).catch(e => console.error('[Dooms Tracker] Dungeon window failed to open', e)); return; }
        if (action === 'combat') { import('./combatModal.js').then(m => m.openCombat()).catch(e => console.error('[Dooms Tracker] Combat window failed to open', e)); return; }
        if (action === 'rpg-on') { toggleRpgModeHere(true); return; }
        if (action === 'rpg-off') {
            const ok = (root.ownerDocument.defaultView || window).confirm('Turn RPG mode off for this card?\n\nStats, levels, equipment and the rest stop being sent to the AI and updated in its chats. Nothing is deleted; turn it back on any time.');
            if (ok) toggleRpgModeHere(false);
            return;
        }
        if (action === 'gear-request' && selected) { requestStartingGear(selected.name, selected.isUser); return; }
        if (action === 'abl-request' && selected) { requestStartingAbilities(selected.name, selected.isUser); return; }
        if (action === 'abl-cancel' && selected) { cancelStartingAbilities(selected.name, selected.isUser); return; }
        if (action === 'gear-cancel' && selected) { cancelStartingGear(selected.name, selected.isUser); return; }
        if (action === 'close') closeStatsPanel();
        else if (action === 'popout') openPopout();
        else if (action === 'dock') dockPopout();
        else if (action === 'reset' && selected) {
            const ok = (root.ownerDocument.defaultView || window).confirm(
                `Reset ${selected.name}'s stats to their starting values in this chat?`,
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
        const xpField = e.target.getAttribute && e.target.getAttribute('data-xp-field');
        if (xpField) { xpForm[xpField] = e.target.value; return; }
        const chk = e.target.getAttribute && e.target.getAttribute('data-chk');
        if (chk && (chk === 'bonus' || chk === 'reason')) { checkForm[chk] = e.target.value; return; }
        const field = e.target.getAttribute && e.target.getAttribute('data-field');
        if (field) { itemForm[field] = e.target.value; itemForm.error = ''; if (e.target.getAttribute('data-gear')) itemForm.gearTouched = true; }
    });
    root.addEventListener('change', (e) => {
        if (e.target.classList && e.target.classList.contains('dsp-item-in-ai')) itemForm.aiCanRemove = e.target.checked;
        if (e.target.classList && e.target.classList.contains('dsp-item-in-equipped')) itemForm.equipped = e.target.checked;
        if (e.target.classList && e.target.classList.contains('dsp-item-in-type')) { itemForm.type = e.target.value; renderAll(); }
        const chkSel = e.target.getAttribute && e.target.getAttribute('data-chk');
        if (chkSel) { checkForm[chkSel] = e.target.value; renderAll(); return; }
        const cb = e.target.getAttribute && e.target.getAttribute('data-cb');
        if (cb) {
            itemForm[cb] = e.target.value;
            itemForm.gearTouched = true;
            itemForm.error = '';
            if (cb === 'cbType') applyCombatDefaults();
            if (cb === 'cbStatus' && !e.target.value) { itemForm.cbStatusTurns = ''; itemForm.cbStatusChance = ''; }
            if (cb === 'cbStatus' && itemForm.cbType === 'status') itemForm.cbTarget = COMBAT_STATUSES[e.target.value]?.bad ? 'enemy' : 'ally';
            renderAll();
        }
        if (e.target.classList && e.target.classList.contains('dsp-item-in-cost')) { itemForm.cost = e.target.value; }
        if (e.target.classList && e.target.classList.contains('dsp-party-toggle') && selected && !selected.isUser) setPartyMember(selected.name, e.target.checked);
    });
    root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.closest && e.target.closest('.dsp-xp-add')) {
            e.preventDefault();
            submitXpForm();
            return;
        }
        if (e.key === 'Enter' && e.target.closest && e.target.closest('.dsp-item-form') && e.target.matches('input[type=text], input[type=number]')) {
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
    window.addEventListener(MEMORIES_CHANGED_EVENT, () => requestAnimationFrame(() => renderAll()));
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
