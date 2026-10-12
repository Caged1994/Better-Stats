/**
 * Combat window — the turn-based fight, in three views:
 *   setup  choose who fights, find the enemies (the AI proposes them from the
 *          chat, or add them by hand), then start;
 *   fight  take turns: every party member is played by you, the enemies act
 *          by themselves; the log shows what happened;
 *   end    the result, what was won, and the story the AI tells afterwards.
 *
 * The rules are in src/utils/combatModel.js, the link to the Stats data in
 * src/systems/features/combat.js. The fight is saved in the chat after every
 * turn, so closing the window or reloading the page does not lose it.
 */
import { ensureCss } from '../../core/cssLoader.js';
import { escapeHtml } from '../../utils/html.js';
import { resolvePortrait } from './portraitBar.js';
import * as M from '../../utils/combatModel.js';
import {
    isCombatEnabled, isCombatNarrationOn, partyCandidates, generateEncounterSetup, buildEncounter,
    getLiveEncounter, saveLiveEncounter, clearLiveEncounter, applyOutcome, narrateOutcome,
} from '../features/combat.js';
import { getCurrency } from '../features/characterMoney.js';

const ROOT_ID = 'dooms-combat';
const ENEMY_DELAY = 650;

let root = null;
let view = 'setup';
let setup = null;
let fight = null;
let ui = null;

function freshSetup() {
    const candidates = partyCandidates();
    return {
        candidates: candidates.map(c => ({ ...c, on: c.inParty })),
        situation: '',
        enemies: [],
        environment: '',
        busy: false,
        error: '',
        note: '',
        manual: { name: '', tier: 'normal' },
    };
}

function freshUi() {
    return { menu: 'main', pending: null, busy: false, report: null, narration: '', narrationState: 'idle', narrationError: '' };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isOpen = () => !!root && document.body.contains(root);

// ─── Public API ─────────────────────────────────────────────────────────────

/** Whether a fight is waiting to be resumed in this chat. */
export function hasLiveFight() {
    const st = getLiveEncounter();
    return !!st && st.phase === 'active';
}

export async function openCombat() {
    if (!isCombatEnabled()) {
        try { window.toastr?.info('Combat is off — turn RPG mode on and enable Combat in Settings → RPG & Stats.', 'Combat'); } catch (e) { /* no toastr */ }
        return;
    }
    try { await ensureCss('combat'); } catch (e) { /* render unstyled rather than not at all */ }
    ui = freshUi();
    const live = getLiveEncounter();
    if (live && (live.phase === 'active' || live.phase === 'ended')) {
        fight = live;
        view = 'fight';
    } else {
        if (live) clearLiveEncounter();
        fight = null;
        setup = freshSetup();
        view = 'setup';
    }
    mount();
    render();
    // A fight that ended while the window was closed still has to be settled.
    if (view === 'fight') { if (fight.phase === 'ended') finish(); else pump(); }
}

export function closeCombat() {
    if (root) { root.remove(); root = null; }
}

// ─── Mounting ───────────────────────────────────────────────────────────────

function mount() {
    closeCombat();
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'dcb';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Combat');
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

function portraitSrc(name) {
    try {
        const src = resolvePortrait(name);
        if (!src) return '';
        return /^(data:|blob:|https?:)/i.test(src) ? src : new URL(src, document.baseURI).href;
    } catch (e) { return ''; }
}

function avatarHtml(c) {
    if (c.side === 'enemy') return `<span class="dcb-avatar is-emoji">${escapeHtml(c.icon || '👹')}</span>`;
    const src = portraitSrc(c.name);
    const fallback = "const s=document.createElement('span');s.className='dcb-avatar is-initials';s.textContent=this.dataset.i;this.replaceWith(s);";
    return src
        ? `<img class="dcb-avatar" src="${escapeHtml(src)}" alt="" draggable="false" data-i="${escapeHtml(initials(c.name))}" onerror="${escapeHtml(fallback)}">`
        : `<span class="dcb-avatar is-initials">${escapeHtml(initials(c.name))}</span>`;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render() {
    if (!root) return;
    const keep = root.querySelector('.dcb-log');
    const logTop = keep ? keep.scrollTop : 0;
    const wasBottom = keep ? keep.scrollHeight - keep.clientHeight - keep.scrollTop < 30 : true;
    root.innerHTML = `<div class="dcb-window dcb-view-${view}">${header()}${view === 'setup' ? setupHtml() : view === 'fight' ? fightHtml() : endHtml()}</div>`;
    const log = root.querySelector('.dcb-log');
    if (log) log.scrollTop = wasBottom ? log.scrollHeight : logTop;
}

function header() {
    const sub = view === 'fight' && fight ? `Round ${fight.round}${fight.environment ? ` · ${escapeHtml(fight.environment)}` : ''}` : view === 'end' ? 'Finished' : 'New fight';
    return `<header class="dcb-head">
        <span class="dcb-title"><i class="fa-solid fa-khanda"></i> Combat</span>
        <span class="dcb-sub">${sub}</span>
        <span class="dcb-spacer"></span>
        ${view === 'fight' ? '<button type="button" class="dcb-icon-btn" data-action="leave" title="Abandon the fight (counts as a retreat)"><i class="fa-solid fa-person-running"></i></button>' : ''}
        <button type="button" class="dcb-icon-btn" data-action="close" title="${view === 'fight' ? 'Close — the fight is kept and can be resumed' : 'Close'}"><i class="fa-solid fa-xmark"></i></button>
    </header>`;
}

// ── Setup ──

function difficultyHtml() {
    const r = M.threatRating(setup.enemies.map(e => e.tier), setup.candidates.filter(c => c.on).length);
    return `<p class="dcb-diff is-${r.id}" title="A rough guide from the enemy categories and the size of the party"><i class="fa-solid fa-skull"></i> Difficulty: <strong>${r.label}</strong></p>`;
}

function setupHtml() {
    const s = setup;
    const anyParty = s.candidates.some(c => c.on);
    const party = s.candidates.map((c, i) => `
        <label class="dcb-pick${c.on ? ' is-on' : ''}">
            <input type="checkbox" data-party="${i}" ${c.on ? 'checked' : ''}>
            ${avatarHtml({ side: 'party', name: c.name })}
            <span class="dcb-pick-name">${escapeHtml(c.name)}${c.isUser ? ' <em>you</em>' : ''}</span>
            <span class="dcb-lv">Lv ${c.level}</span>
        </label>`).join('');
    const enemies = s.enemies.map((e, i) => `
        <div class="dcb-enemy-row">
            <span class="dcb-avatar is-emoji">${escapeHtml(e.icon || '👹')}</span>
            <span class="dcb-enemy-main"><strong>${escapeHtml(e.name)}</strong>
                <small>${escapeHtml(e.description || (e.attacks?.length ? e.attacks.map(a => a.name).join(', ') : 'No special attacks'))}</small></span>
            <select data-tier="${i}" title="How dangerous it is">${M.TIERS.map(t => `<option value="${t}"${e.tier === t ? ' selected' : ''}>${M.TUNING.tiers[t].label}</option>`).join('')}</select>
            <button type="button" class="dcb-icon-btn" data-action="enemy-remove" data-i="${i}" title="Remove"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('');
    return `<div class="dcb-body">
        <section>
            <h3>Who fights</h3>
            <div class="dcb-picks">${party || '<p class="dcb-empty">No characters yet.</p>'}</div>
        </section>
        <section>
            <h3>The enemies</h3>
            <textarea class="dcb-text" data-field="situation" rows="2" placeholder="Who are you fighting? (optional — leave empty and the AI works it out from the chat)">${escapeHtml(s.situation)}</textarea>
            <div class="dcb-row">
                <button type="button" class="dcb-btn is-primary" data-action="find" ${s.busy || !anyParty ? 'disabled' : ''}>${s.busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Asking the AI…' : `<i class="fa-solid fa-wand-magic-sparkles"></i> ${s.enemies.length ? 'Find others' : 'Find enemies'}`}</button>
                <span class="dcb-muted">The AI picks who they are; the numbers come from the rules.</span>
            </div>
            ${s.error ? `<p class="dcb-error">${escapeHtml(s.error)}</p>` : ''}
            ${s.note ? `<p class="dcb-note">${escapeHtml(s.note)}</p>` : ''}
            <div class="dcb-enemy-list">${enemies || '<p class="dcb-empty">No enemies yet.</p>'}</div>
            ${s.enemies.length && anyParty ? difficultyHtml() : ''}
            <div class="dcb-row dcb-manual">
                <input type="text" class="dcb-input" data-field="manual-name" placeholder="Add an enemy by hand…" value="${escapeHtml(s.manual.name)}" maxlength="40">
                <select data-field="manual-tier">${M.TIERS.map(t => `<option value="${t}"${s.manual.tier === t ? ' selected' : ''}>${M.TUNING.tiers[t].label}</option>`).join('')}</select>
                <button type="button" class="dcb-btn" data-action="enemy-add"><i class="fa-solid fa-plus"></i> Add</button>
            </div>
            ${s.environment ? `<p class="dcb-muted"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.environment)}</p>` : ''}
        </section>
    </div>
    <footer class="dcb-foot">
        <button type="button" class="dcb-btn" data-action="close">Cancel</button>
        <button type="button" class="dcb-btn is-primary" data-action="start" ${anyParty && s.enemies.length && !s.busy ? '' : 'disabled'}><i class="fa-solid fa-khanda"></i> Start the fight</button>
    </footer>`;
}

// ── Fight ──

function barHtml(cls, value, max, label) {
    const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
    const low = cls === 'is-hp' && pct <= 30 ? ' is-low' : '';
    return `<div class="dcb-bar ${cls}${low}" title="${escapeHtml(label)}"><span style="width:${pct}%"></span><em>${escapeHtml(label)}</em></div>`;
}

function statusesHtml(c) {
    if (!c.statuses?.length && !c.guard) return '';
    const chips = (c.statuses || []).map(s => {
        const d = M.STATUSES[s.id];
        return d ? `<span class="dcb-status${d.bad ? ' is-bad' : ''}" title="${escapeHtml(d.name)} — ${s.turns} turn${s.turns === 1 ? '' : 's'}">${d.icon}<small>${s.turns}</small></span>` : '';
    });
    if (c.guard) chips.push('<span class="dcb-status" title="Guarding">🛡️</span>');
    return `<div class="dcb-statuses">${chips.join('')}</div>`;
}

function cardHtml(c, actor) {
    const targetable = ui.pending && ui.pending.targets.includes(c.id);
    const cls = ['dcb-card', c.side === 'enemy' ? 'is-enemy' : 'is-party'];
    if (c.down) cls.push('is-down');
    if (actor && actor.id === c.id) cls.push('is-active');
    if (targetable) cls.push('is-targetable');
    const tier = c.tier ? `<span class="dcb-tier is-${c.tier}">${M.TUNING.tiers[c.tier]?.label || c.tier}</span>` : '';
    return `<div class="${cls.join(' ')}" ${targetable ? `data-action="target" data-id="${escapeHtml(c.id)}" role="button" tabindex="0"` : ''} title="${escapeHtml(c.description || c.name)}">
        ${avatarHtml(c)}
        <div class="dcb-card-main">
            <div class="dcb-card-name"><span>${escapeHtml(c.name)}</span></div>
            <div class="dcb-card-meta">${tier}<span class="dcb-lv">Lv ${c.level}</span></div>
            ${barHtml('is-hp', c.hp, c.maxHp, c.down ? 'Down' : `${c.hp} / ${c.maxHp}`)}
            ${c.mana !== null && c.side === 'party' ? barHtml('is-mana', c.mana, 100, `Mana ${c.mana}`) : ''}
            ${statusesHtml(c)}
        </div>
    </div>`;
}

function actionButton(actor, a) {
    const check = M.canUse(actor, a);
    const bits = [];
    if (a.manaCost > 0 && actor.mana !== null) bits.push(`<span class="dcb-chip is-mana">💧${a.manaCost}</span>`);
    if (a.kind === 'item') bits.push(`<span class="dcb-chip">×${a.qty}</span>`);
    const cd = actor.cooldowns[a.id] || 0;
    if (cd > 0) bits.push(`<span class="dcb-chip is-wait">⏳${cd}</span>`);
    const tip = describeAction(actor, a, check);
    return `<button type="button" class="dcb-act" data-action="act" data-id="${escapeHtml(a.id)}" ${check.ok ? '' : 'disabled'} title="${escapeHtml(tip)}">
        <span class="dcb-act-icon">${escapeHtml(a.icon || '✨')}</span><span class="dcb-act-name">${escapeHtml(a.label)}</span>${bits.join('')}</button>`;
}

function describeAction(actor, a, check) {
    const p = a.profile;
    const parts = [];
    const foe = M.alive(fight, actor.side === 'party' ? 'enemy' : 'party')[0];
    if (p.type === 'damage') {
        const est = foe ? M.estimateAction(actor, a, foe) : null;
        parts.push(est ? `Damage about ${est.min}–${est.max}, ${est.hit}% to hit` : 'Damage');
        if (p.target === 'enemies') parts.push('hits every enemy');
    } else if (p.type === 'heal') {
        const t = M.alive(fight, actor.side)[0] || actor;
        parts.push(`Heals about ${M.healAmount(actor, a, t)}`);
    } else if (p.type === 'status') {
        parts.push(`${M.STATUSES[p.status]?.name || 'Status'}`);
    } else if (p.type === 'mana') parts.push('Restores Mana');
    else if (p.type === 'cure') parts.push('Removes harmful statuses');
    else if (p.type === 'revive') parts.push('Raises a fallen ally');
    if (p.status && p.type === 'damage') parts.push(`may cause ${M.STATUSES[p.status]?.name.toLowerCase()}`);
    if (!check.ok) parts.push(check.reason);
    return parts.join(' · ');
}

function actionsHtml(actor) {
    if (ui.pending) {
        const a = actor.actions.find(x => x.id === ui.pending.actionId);
        return `<div class="dcb-actions">
            <p class="dcb-hint"><i class="fa-solid fa-crosshairs"></i> ${escapeHtml(a?.label || 'Action')} — choose a ${a?.profile.target === 'ally' ? 'friend' : 'target'}</p>
            <button type="button" class="dcb-btn" data-action="cancel-target">Back</button></div>`;
    }
    const abilities = actor.actions.filter(a => a.kind === 'spell' || a.kind === 'ability');
    const items = actor.actions.filter(a => a.kind === 'item');
    if (ui.menu === 'abilities' || ui.menu === 'items') {
        const list = ui.menu === 'abilities' ? abilities : items;
        return `<div class="dcb-actions">
            <div class="dcb-act-list">${list.map(a => actionButton(actor, a)).join('') || '<p class="dcb-empty">Nothing here.</p>'}</div>
            <button type="button" class="dcb-btn" data-action="menu" data-menu="main"><i class="fa-solid fa-arrow-left"></i> Back</button></div>`;
    }
    const flee = Math.round(M.fleeChance(fight) * 100);
    const basic = actor.actions.find(a => a.id === 'basic');
    return `<div class="dcb-actions">
        <div class="dcb-act-main">
            ${basic ? actionButton(actor, basic) : ''}
            <button type="button" class="dcb-act" data-action="menu" data-menu="abilities" ${abilities.length ? '' : 'disabled'}><span class="dcb-act-icon">🔮</span><span class="dcb-act-name">Spells &amp; skills</span><span class="dcb-chip">${abilities.length}</span></button>
            <button type="button" class="dcb-act" data-action="menu" data-menu="items" ${items.length ? '' : 'disabled'}><span class="dcb-act-icon">🎒</span><span class="dcb-act-name">Items</span><span class="dcb-chip">${items.length}</span></button>
            <button type="button" class="dcb-act" data-action="defend" title="Take half damage until your next turn"><span class="dcb-act-icon">🛡️</span><span class="dcb-act-name">Defend</span></button>
            <button type="button" class="dcb-act" data-action="flee" title="Chance to escape the whole party"><span class="dcb-act-icon">🏃</span><span class="dcb-act-name">Flee</span><span class="dcb-chip">${flee}%</span></button>
        </div></div>`;
}

function logHtml() {
    const lines = (fight.log || []).slice(-60).map(e => `<li class="is-${escapeHtml(e.type)}${e.crit ? ' is-crit' : ''}">${escapeHtml(e.text)}</li>`);
    return `<ul class="dcb-log" aria-live="polite">${lines.join('')}</ul>`;
}

function fightHtml() {
    const actor = M.currentActor(fight);
    const enemies = fight.combatants.filter(c => c.side === 'enemy');
    const party = fight.combatants.filter(c => c.side === 'party');
    let turn;
    if (fight.phase !== 'active') turn = 'The fight is over';
    else if (actor?.side === 'party') turn = `${escapeHtml(actor.name)}'s turn`;
    else turn = `${escapeHtml(actor?.name || '…')} is acting…`;
    const mine = fight.phase === 'active' && actor?.side === 'party' && !ui.busy;
    return `<div class="dcb-body dcb-fight">
        <div class="dcb-field is-enemies">${enemies.map(c => cardHtml(c, actor)).join('')}</div>
        <div class="dcb-turn">${turn}</div>
        <div class="dcb-field is-party">${party.map(c => cardHtml(c, actor)).join('')}</div>
        ${mine ? actionsHtml(actor) : '<div class="dcb-actions is-waiting"><i class="fa-solid fa-hourglass-half"></i></div>'}
        ${logHtml()}
    </div>`;
}

// ── End ──

function endHtml() {
    const r = ui.report || {};
    const result = fight.result;
    const title = { victory: '🎉 Victory', defeat: '💀 Defeat', fled: '🏃 Escaped' }[result] || 'Finished';
    const cur = getCurrency();
    const rewards = [];
    if (r.xpGiven) rewards.push(`<li><i class="fa-solid fa-star"></i> ${r.xpGiven} XP to the whole party</li>`);
    if (r.moneyAdded) rewards.push(`<li><i class="fa-solid fa-coins"></i> ${r.moneyAdded}${cur ? ' ' + escapeHtml(cur.symbol || cur.name) : ''} found</li>`);
    for (const it of r.lootAdded || []) rewards.push(`<li><i class="fa-solid fa-box-open"></i> ${escapeHtml(it)}</li>`);
    for (const a of r.affinity || []) rewards.push(`<li><i class="fa-solid fa-heart"></i> ${escapeHtml(a.name)} ${a.delta > 0 ? 'likes you more' : 'is a little cooler toward you'}</li>`);
    const party = (r.party || []).map(p => `<li>${escapeHtml(p.name)} — ${p.down ? 'knocked out' : `Health ${p.healthPct}%`}</li>`).join('');
    let story = '';
    if (ui.narrationState === 'working') story = '<p class="dcb-note"><i class="fa-solid fa-spinner fa-spin"></i> The AI is writing the story of the fight into the chat…</p>';
    else if (ui.narrationState === 'done') story = '<p class="dcb-note"><i class="fa-solid fa-check"></i> The story of the fight was added to the chat.</p>';
    else if (ui.narrationState === 'failed') story = `<p class="dcb-error">The AI could not write the story (${escapeHtml(ui.narrationError || 'error')}). The fight itself is recorded.</p>`;
    return `<div class="dcb-body dcb-end">
        <h2>${title}</h2>
        <p class="dcb-muted">${fight.round} round${fight.round === 1 ? '' : 's'}</p>
        ${rewards.length ? `<ul class="dcb-rewards">${rewards.join('')}</ul>` : '<p class="dcb-muted">Nothing was won.</p>'}
        <h3>How everyone ended</h3>
        <ul class="dcb-outcome">${party}</ul>
        ${story}
    </div>
    <footer class="dcb-foot"><button type="button" class="dcb-btn is-primary" data-action="close">Done</button></footer>`;
}

// ─── Events ─────────────────────────────────────────────────────────────────

function onInput(ev) {
    const t = ev.target;
    if (!setup || view !== 'setup') return;
    if (t.dataset.field === 'situation') setup.situation = t.value;
    else if (t.dataset.field === 'manual-name') setup.manual.name = t.value;
}

function onChange(ev) {
    const t = ev.target;
    if (view !== 'setup' || !setup) return;
    if (t.dataset.party !== undefined) {
        setup.candidates[Number(t.dataset.party)].on = t.checked;
        render();
    } else if (t.dataset.tier !== undefined) {
        const e = setup.enemies[Number(t.dataset.tier)];
        if (e) { e.tier = t.value; render(); }
    } else if (t.dataset.field === 'manual-tier') {
        setup.manual.tier = t.value;
    }
}

function onClick(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const action = el.dataset.action;
    if (action === 'close') { closeCombat(); return; }
    if (view === 'setup') return setupAction(action, el);
    if (view === 'fight') return fightAction(action, el);
}

function selectedParty() {
    return setup.candidates.filter(c => c.on).map(c => ({ name: c.name, isUser: c.isUser }));
}

async function setupAction(action, el) {
    const s = setup;
    if (action === 'enemy-remove') { s.enemies.splice(Number(el.dataset.i), 1); render(); return; }
    if (action === 'enemy-add') {
        const name = s.manual.name.trim();
        if (!name) return;
        s.enemies.push({ name: name.slice(0, 40), icon: '👹', description: '', tier: s.manual.tier, attacks: [], levelDelta: 0 });
        s.manual.name = '';
        s.error = '';
        render();
        return;
    }
    if (action === 'find') {
        if (s.busy) return;
        const party = selectedParty();
        if (!party.length) return;
        s.busy = true; s.error = ''; s.note = '';
        render();
        try {
            const res = await generateEncounterSetup(party, { situation: s.situation });
            if (!isOpen() || setup !== s) return;
            s.enemies = res.enemies;
            s.environment = res.environment;
            s.note = res.labelled ? `The AI also labelled ${res.labelled} spell${res.labelled === 1 ? '' : 's'}, skill${res.labelled === 1 ? '' : 's'} and item${res.labelled === 1 ? '' : 's'} for combat.` : '';
            if (!res.enemies.length) s.error = 'The AI did not propose any enemies. Add them by hand or describe them above.';
        } catch (e) {
            s.error = `${e?.message || 'The AI could not be reached.'} You can add the enemies by hand.`;
        }
        s.busy = false;
        if (isOpen()) render();
        return;
    }
    if (action === 'start') {
        const party = selectedParty();
        if (!party.length || !s.enemies.length) return;
        fight = buildEncounter(party, s.enemies, { environment: s.environment });
        M.startCombat(fight);
        saveLiveEncounter(fight);
        view = 'fight';
        ui = freshUi();
        render();
        pump();
    }
}

async function fightAction(action, el) {
    if (ui.busy || fight.phase !== 'active') {
        if (action === 'leave') return leave();
        return;
    }
    const actor = M.currentActor(fight);
    if (action === 'leave') return leave();
    if (!actor || actor.side !== 'party') return;
    if (action === 'menu') { ui.menu = el.dataset.menu; render(); return; }
    if (action === 'cancel-target') { ui.pending = null; render(); return; }
    if (action === 'defend') { M.defend(fight, actor.id); return endTurn(); }
    if (action === 'flee') { M.attemptFlee(fight, actor.id); return endTurn(); }
    if (action === 'target' && ui.pending) {
        const { actionId } = ui.pending;
        ui.pending = null;
        M.performAction(fight, actor.id, actionId, el.dataset.id);
        return endTurn();
    }
    if (action === 'act') {
        const a = actor.actions.find(x => x.id === el.dataset.id);
        if (!a || !M.canUse(actor, a).ok) return;
        const t = a.profile.target;
        if (t === 'enemy' || t === 'ally') {
            const targets = M.validTargets(fight, actor, a);
            if (!targets.length) return;
            ui.pending = { actionId: a.id, targets };
            render();
            return;
        }
        M.performAction(fight, actor.id, a.id, null);
        return endTurn();
    }
}

/** After a party member acted: end the turn and let the enemies play. */
async function endTurn() {
    ui.menu = 'main';
    ui.pending = null;
    if (fight.phase === 'active') M.advance(fight);
    saveLiveEncounter(fight);
    render();
    await pump();
}

/** Plays enemy turns until it is a party member's turn again (or it ends). */
async function pump() {
    if (ui.busy) return;
    ui.busy = true;
    try {
        while (isOpen() && fight.phase === 'active') {
            const actor = M.currentActor(fight);
            if (!actor || actor.side === 'party') break;
            render();
            await sleep(ENEMY_DELAY);
            if (!isOpen()) break;
            M.runEnemyTurn(fight);
            render();
            await sleep(ENEMY_DELAY / 2);
            if (fight.phase === 'active') M.advance(fight);
            saveLiveEncounter(fight);
        }
    } finally {
        ui.busy = false;
    }
    if (!isOpen()) return;
    render();
    if (fight.phase === 'ended') await finish();
}

async function leave() {
    if (!fight || fight.phase !== 'active') return;
    const ok = window.confirm('Abandon the fight? The party retreats — no reward, and allies will be a little less pleased.');
    if (!ok) return;
    fight.phase = 'ended';
    fight.result = 'fled';
    fight.log.push({ n: fight.seq++, round: fight.round, type: 'flee', text: 'The party falls back.' });
    await finish();
}

async function finish() {
    if (view === 'end') return;
    view = 'end';
    ui.report = applyOutcome(fight);
    clearLiveEncounter();
    const narrate = isCombatNarrationOn();
    ui.narrationState = narrate ? 'working' : 'idle';
    render();
    if (!narrate) return;
    const mine = fight;
    try {
        await narrateOutcome(mine, ui.report);
        ui.narrationState = 'done';
    } catch (e) {
        ui.narrationState = 'failed';
        ui.narrationError = e?.message || '';
    }
    if (isOpen() && fight === mine) render();
}
