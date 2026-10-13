/**
 * Dungeon window — an expedition through a small map of rooms, in three views:
 *   setup    choose the party, a theme, how deep and how big; the program lays
 *            the map out and the AI dresses it once (or skip the AI);
 *   explore  walk the map room by room: fight, get past traps, open chests,
 *            rest, camp, go down; a log keeps what happened;
 *   end      the result, what was found, and (optionally) the story in the chat.
 *
 * The rules are in src/utils/dungeonModel.js, the link to the Stats data and
 * the chat in src/systems/features/dungeon.js. Fights open the combat window
 * (combatModal.openEncounter) and the dungeon waits behind it. The expedition
 * is saved in the chat after every step.
 */
import { ensureCss } from '../../core/cssLoader.js';
import { escapeHtml } from '../../utils/html.js';
import { resolvePortrait } from './portraitBar.js';
import * as D from '../../utils/dungeonModel.js';
import { rollText, degreeLabel } from '../../utils/checkModel.js';
import { partyCandidates, getLiveEncounter } from '../features/combat.js';
import * as G from '../features/dungeon.js';
import { openEncounter } from './combatModal.js';
import { getCurrency } from '../features/characterMoney.js';

const ROOT_ID = 'dooms-dungeon';

let root = null;
let view = 'setup';
let setup = null;
let st = null;
let ui = null;

const isOpen = () => !!root && document.body.contains(root);

function freshUi() {
    return { notice: '', noticeKind: 'info', busy: false, ending: false, finished: null, narrate: G.isDungeonNarrationOn(), narrationError: '', confirmLeave: false };
}

function freshSetup() {
    return {
        candidates: partyCandidates().map(c => ({ ...c, on: c.inParty })),
        theme: '',
        floors: 1,
        size: 'medium',
        useAI: true,
        busy: false,
        error: '',
    };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function openDungeon() {
    if (!G.isDungeonEnabled()) {
        try { window.toastr?.info('The dungeon is off — turn RPG mode and Combat on, and enable Dungeon in Settings → RPG & Stats.', 'Dungeon'); } catch (e) { /* no toastr */ }
        return;
    }
    try { await ensureCss('combat'); await ensureCss('dungeon'); } catch (e) { /* unstyled rather than not at all */ }
    ui = freshUi();
    const live = G.getLiveDungeon();
    if (live) {
        st = live;
        G.reconcileFight(st);
        view = st.phase === 'active' ? 'explore' : 'end';
    } else {
        st = null;
        setup = freshSetup();
        view = 'setup';
    }
    mount();
    render();
}

export function closeDungeon() {
    if (root) { root.remove(); root = null; }
}

// ─── Mounting ───────────────────────────────────────────────────────────────

function mount() {
    closeDungeon();
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'dcb ddg';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Dungeon');
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
}

function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

function avatarHtml(name) {
    let src = '';
    try {
        const raw = resolvePortrait(name);
        if (raw) src = /^(data:|blob:|https?:)/i.test(raw) ? raw : new URL(raw, document.baseURI).href;
    } catch (e) { src = ''; }
    const fallback = "const s=document.createElement('span');s.className='dcb-avatar is-initials';s.textContent=this.dataset.i;this.replaceWith(s);";
    return src
        ? `<img class="dcb-avatar" src="${escapeHtml(src)}" alt="" draggable="false" data-i="${escapeHtml(initials(name))}" onerror="${escapeHtml(fallback)}">`
        : `<span class="dcb-avatar is-initials">${escapeHtml(initials(name))}</span>`;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function render() {
    if (!root) return;
    const log = root.querySelector('.ddg-log');
    const wasBottom = log ? log.scrollHeight - log.clientHeight - log.scrollTop < 30 : true;
    const logTop = log ? log.scrollTop : 0;
    root.innerHTML = `<div class="dcb-window ddg-window ddg-view-${view}">${header()}${view === 'setup' ? setupHtml() : view === 'explore' ? exploreHtml() : endHtml()}</div>`;
    const l2 = root.querySelector('.ddg-log');
    if (l2) l2.scrollTop = wasBottom ? l2.scrollHeight : logTop;
}

function header() {
    let sub = 'New expedition';
    if (view === 'explore' && st) {
        const f = D.floorOf(st);
        sub = `${escapeHtml(st.title || 'The dungeon')}${st.floors.length > 1 ? ` · ${escapeHtml(f.name || `Floor ${st.floor + 1}`)} (${st.floor + 1}/${st.floors.length})` : ''}`;
    } else if (view === 'end') sub = 'Finished';
    return `<header class="dcb-head">
        <span class="dcb-title"><i class="fa-solid fa-dungeon"></i> Dungeon</span>
        <span class="dcb-sub">${sub}</span>
        <span class="dcb-spacer"></span>
        <button type="button" class="dcb-icon-btn" data-action="close" title="Close — the expedition is kept and can be resumed" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </header>`;
}

// ── Setup ──

function setupHtml() {
    const s = setup;
    const anyParty = s.candidates.some(c => c.on);
    const party = s.candidates.map((c, i) => `
        <label class="dcb-pick${c.on ? ' is-on' : ''}">
            <input type="checkbox" data-party="${i}" ${c.on ? 'checked' : ''}>
            ${avatarHtml(c.name)}
            <span class="dcb-pick-name">${escapeHtml(c.name)}${c.isUser ? ' <em>you</em>' : ''}</span>
            <span class="dcb-lv">Lv ${c.level}</span>
        </label>`).join('');
    const sizes = Object.entries(D.SIZES).map(([id, z]) => `<option value="${id}"${s.size === id ? ' selected' : ''}>${z.label} (about ${z.rooms} rooms a floor)</option>`).join('');
    const floors = [1, 2, 3].map(n => `<option value="${n}"${s.floors === n ? ' selected' : ''}>${n} floor${n === 1 ? '' : 's'}</option>`).join('');
    return `<div class="dcb-body">
        <section>
            <h3>Who goes in</h3>
            <div class="dcb-picks">${party || '<p class="dcb-empty">No characters yet.</p>'}</div>
        </section>
        <section>
            <h3>The place</h3>
            <textarea class="dcb-text" data-field="theme" rows="2" maxlength="400" placeholder="What kind of place is it? (optional — e.g. a flooded crypt under the old chapel. Leave empty and the AI takes it from the chat.)">${escapeHtml(s.theme)}</textarea>
            <div class="dcb-row ddg-opts">
                <select data-field="floors" title="How deep">${floors}</select>
                <select data-field="size" title="How big each floor is">${sizes}</select>
            </div>
            <label class="ddg-check"><input type="checkbox" data-field="useAI" ${s.useAI ? 'checked' : ''}> Let the AI dress the dungeon <span class="dcb-muted">(names, descriptions and who the enemies are — one request. Off: generic names, no request.)</span></label>
            ${s.error ? `<p class="dcb-error">${escapeHtml(s.error)}</p>` : ''}
            <p class="dcb-muted">The program decides the layout, traps and how hard the fights are; the AI only names and describes.</p>
        </section>
    </div>
    <footer class="dcb-foot">
        <button type="button" class="dcb-btn" data-action="close">Cancel</button>
        <button type="button" class="dcb-btn is-primary" data-action="create" ${anyParty && !s.busy ? '' : 'disabled'}>${s.busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Preparing the dungeon…' : '<i class="fa-solid fa-dungeon"></i> Generate and enter'}</button>
    </footer>`;
}

// ── Explore ──

function partyBarsHtml() {
    const rows = G.partyStatus(st).map(p => {
        const bar = (cls, v, label) => (v === null ? '' : `<div class="dcb-bar ${cls}${cls === 'is-hp' && v <= 30 ? ' is-low' : ''}" title="${escapeHtml(label)}"><span style="width:${Math.max(0, Math.min(100, v))}%"></span><em>${escapeHtml(label)}</em></div>`);
        return `<div class="ddg-member">${avatarHtml(p.name)}<div class="ddg-member-main"><span class="ddg-member-name">${escapeHtml(p.name)}</span>${bar('is-hp', p.health, `Health ${p.health}`)}${bar('is-mana', p.mana, `Mana ${p.mana}`)}</div></div>`;
    });
    return `<div class="ddg-party">${rows.join('')}</div>`;
}

function mapHtml() {
    const f = D.floorOf(st);
    const rooms = D.visibleRooms(st);
    const links = D.visibleLinks(st);
    // The frame is the floor's whole footprint (not only what is seen), so the map does not jump as it is revealed.
    const all = Object.values(f.rooms);
    const minX = Math.min(...all.map(r => r.x)), maxX = Math.max(...all.map(r => r.x));
    const minY = Math.min(...all.map(r => r.y)), maxY = Math.max(...all.map(r => r.y));
    const cols = (maxX - minX + 1) * 2 - 1;
    const rowsN = (maxY - minY + 1) * 2 - 1;
    const gx = (x) => (x - minX) * 2 + 1;
    const gy = (y) => (y - minY) * 2 + 1;
    const colSizes = Array.from({ length: cols }, (_, i) => (i % 2 ? '12px' : 'minmax(0, 1fr)')).join(' ');
    const rowSizes = Array.from({ length: rowsN }, (_, i) => (i % 2 ? '12px' : '46px')).join(' ');
    const shown = new Set(rooms.map(r => r.room.id));
    const cells = rooms.map(({ room, known, here, reachable }) => {
        const t = D.ROOM_TYPES[room.type];
        const cls = ['ddg-room', known ? 'is-known' : 'is-unknown', `t-${room.type}`];
        if (here) cls.push('is-here');
        if (reachable) cls.push('is-reachable');
        if (room.cleared && known && D.BLOCKING.has(room.type)) cls.push('is-cleared');
        const icon = known ? (here ? '🧭' : t.icon) : '❔';
        const name = known ? `${room.name || t.label} — ${t.label}${room.cleared && D.BLOCKING.has(room.type) ? ' (cleared)' : ''}` : 'Unexplored';
        return `<button type="button" class="${cls.join(' ')}" style="grid-column:${gx(room.x)};grid-row:${gy(room.y)}" data-action="go" data-id="${escapeHtml(room.id)}" title="${escapeHtml(name)}" aria-label="${escapeHtml(name)}" ${reachable ? '' : 'tabindex="-1"'}>${icon}</button>`;
    });
    const lines = links.filter(([a, b]) => shown.has(a) && shown.has(b)).map(([a, b]) => {
        const ra = f.rooms[a], rb = f.rooms[b];
        const col = (gx(ra.x) + gx(rb.x)) / 2, row = (gy(ra.y) + gy(rb.y)) / 2; // between the two cells
        const horizontal = ra.y === rb.y;
        return `<span class="ddg-link ${horizontal ? 'is-h' : 'is-v'}" style="grid-column:${col};grid-row:${row}"></span>`;
    });
    return `<div class="ddg-map" style="grid-template-columns:${colSizes};grid-template-rows:${rowSizes}">${lines.join('')}${cells.join('')}</div>`;
}

const pct = (n) => `${Math.round(n * 100)}%`;
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

function memberChips(action, statId, difficulty, extra = '') {
    return G.tryOptions(st, statId, difficulty).map((o, i) => `
        <button type="button" class="ddg-who" data-action="${action}" data-i="${i}" ${o.has ? '' : 'disabled'} title="${escapeHtml(o.name)}: ${String(statId).toUpperCase()} ${o.value ?? '—'}">
            ${avatarHtml(o.name)}<span>${escapeHtml(o.name)}</span><small>${o.has ? `${signed(o.modifier)} · ${pct(o.chance)}` : 'n/a'}</small>${extra}
        </button>`).join('');
}

function roomCardHtml() {
    const room = D.currentRoom(st);
    const t = D.ROOM_TYPES[room.type];
    const live = st.pendingFight ? getLiveEncounter() : null;
    const busy = !!st.pendingFight;
    let body = '';
    if (busy) {
        body = live
            ? '<p class="dcb-hint"><i class="fa-solid fa-khanda"></i> A fight is in progress.</p><button type="button" class="dcb-btn is-primary" data-action="resume-fight"><i class="fa-solid fa-khanda"></i> Resume the fight</button>'
            : '<p class="dcb-muted">Settling the fight…</p>';
    } else if ((room.type === 'combat' || room.type === 'boss') && !room.cleared) {
        const foes = room.enemies.map(e => `<li><span class="dcb-avatar is-emoji">${escapeHtml(e.icon || '👹')}</span><span>${escapeHtml(e.name || 'Enemy')}</span><span class="dcb-tier is-${e.tier}">${escapeHtml(e.tier)}</span></li>`).join('');
        body = `<ul class="ddg-foes">${foes}</ul>
            <button type="button" class="dcb-btn is-primary" data-action="fight"><i class="fa-solid fa-khanda"></i> Fight</button>
            <p class="dcb-muted">Or step back through the way you came.</p>`;
    } else if (room.type === 'trap' && !room.cleared) {
        const tr = room.trap;
        body = `<p class="ddg-trap">${tr.desc && tr.desc !== room.desc ? escapeHtml(tr.desc) + ' ' : ''}<strong>${String(tr.stat).toUpperCase()}, ${escapeHtml(tr.difficulty)}</strong> — failing costs about ${tr.damage} Health.</p>
            <p class="dcb-muted">Who tries to get past?</p>
            <div class="ddg-whos">${memberChips('trap', tr.stat, tr.difficulty)}</div>
            <p class="dcb-muted">Or step back through the way you came.</p>`;
    } else if (room.type === 'treasure' && !room.cleared) {
        const l = room.loot;
        if (l.locked) {
            body = `<p>A locked chest.</p>
                <p class="dcb-muted">Pick the lock (${l.lockStat.toUpperCase()}, ${escapeHtml(l.lockDifficulty)}) — a failure jams it: only half the money, no items.</p>
                <div class="ddg-whos">${memberChips('chest-pick', l.lockStat, l.lockDifficulty)}</div>
                <p class="dcb-muted">Or force it (${l.forceStat.toUpperCase()}, ${escapeHtml(l.lockDifficulty)}) — a failure also hurts.</p>
                <div class="ddg-whos">${memberChips('chest-force', l.forceStat, l.lockDifficulty)}</div>`;
        } else {
            body = '<p>An unlocked chest.</p><button type="button" class="dcb-btn is-primary" data-action="chest-open"><i class="fa-solid fa-box-open"></i> Open it</button>';
        }
    } else if (room.type === 'rest' && !room.cleared) {
        body = `<button type="button" class="dcb-btn is-primary" data-action="rest"><i class="fa-solid fa-fire"></i> Rest here <small>(+${room.rest.health} Health, +${room.rest.mana} Mana, once)</small></button>`;
    } else if (room.type === 'stairs') {
        body = D.isLastFloor(st) ? '' : '<button type="button" class="dcb-btn is-primary" data-action="down"><i class="fa-solid fa-stairs"></i> Go down</button>';
    }
    const canCamp = !busy && !D.blocksExit(room) && st.phase === 'active';
    const camp = canCamp ? `<button type="button" class="dcb-btn" data-action="camp" title="Recover some Health and Mana. The more you camp, the likelier something finds you."><i class="fa-solid fa-campground"></i> Camp <small>(${pct(D.ambushChance(st))} risk)</small></button>` : '';
    return `<section class="ddg-room-card t-${room.type}">
        <header><span class="ddg-room-icon">${t.icon}</span><div><strong>${escapeHtml(room.name || t.label)}</strong><small>${escapeHtml(t.label)}${room.cleared && D.BLOCKING.has(room.type) ? ' · cleared' : ''}</small></div></header>
        <p class="ddg-desc">${escapeHtml(room.desc || '')}</p>
        ${body}
        <div class="ddg-actions-row">${camp}<button type="button" class="dcb-btn" data-action="leave-ask"><i class="fa-solid fa-person-walking-arrow-right"></i> Leave the dungeon</button></div>
        ${ui.confirmLeave ? '<div class="ddg-confirm"><span>Leave now? You keep what you have found.</span><button type="button" class="dcb-btn is-primary" data-action="leave-yes">Leave</button><button type="button" class="dcb-btn" data-action="leave-no">Stay</button></div>' : ''}
    </section>`;
}

function logHtml() {
    const lines = (st.log || []).slice(-40).map(e => `<li class="is-${escapeHtml(e.type)}">${escapeHtml(e.text)}</li>`);
    return `<ul class="ddg-log" aria-live="polite">${lines.join('')}</ul>`;
}

function exploreHtml() {
    return `<div class="dcb-body ddg-explore">
        ${partyBarsHtml()}
        <div class="ddg-main">
            ${mapHtml()}
            <div class="ddg-side">${ui.notice ? `<p class="ddg-notice is-${ui.noticeKind}">${ui.notice}</p>` : ''}${roomCardHtml()}</div>
        </div>
        ${logHtml()}
    </div>`;
}

// ── End ──

function endHtml() {
    const s = st.stats;
    const { seen, total } = D.exploredCount(st);
    const title = { cleared: '🏆 Dungeon cleared', left: '🚪 You left the dungeon', defeated: '💀 The expedition failed' }[st.result] || 'Finished';
    const cur = getCurrency();
    const found = [];
    if (s.xp) found.push(`<li><i class="fa-solid fa-star"></i> ${s.xp} XP${ui.finished?.bonusXp ? ` (+${ui.finished.bonusXp} for clearing it)` : ''}</li>`);
    else if (ui.finished?.bonusXp) found.push(`<li><i class="fa-solid fa-star"></i> +${ui.finished.bonusXp} XP for clearing it</li>`);
    if (s.money) found.push(`<li><i class="fa-solid fa-coins"></i> ${s.money}${cur ? ' ' + escapeHtml(cur.symbol || cur.name) : ''} found</li>`);
    for (const it of s.items) found.push(`<li><i class="fa-solid fa-box-open"></i> ${escapeHtml(it)}</li>`);
    const facts = [
        `${seen}/${total} rooms seen`, `${s.fights} fight${s.fights === 1 ? '' : 's'}`,
        s.traps ? `${s.traps} trap${s.traps === 1 ? '' : 's'} (${s.trapsFailed} sprung)` : '', s.chests ? `${s.chests} chest${s.chests === 1 ? '' : 's'}` : '',
        st.floors.length > 1 ? `floor ${s.floors}/${st.floors.length}` : '',
    ].filter(Boolean).join(' · ');
    let story = '';
    if (ui.ending) story = '<p class="dcb-note"><i class="fa-solid fa-spinner fa-spin"></i> Closing the expedition…</p>';
    else if (ui.finished) {
        if (ui.finished.narration) story = '<p class="dcb-note"><i class="fa-solid fa-check"></i> The story of the expedition was added to the chat.</p>';
        else if (ui.finished.narrationError) story = `<p class="dcb-error">The AI could not write the story (${escapeHtml(ui.finished.narrationError)}). The expedition itself is recorded.</p>`;
    }
    const foot = ui.finished
        ? '<button type="button" class="dcb-btn is-primary" data-action="close">Done</button>'
        : `<label class="ddg-check"><input type="checkbox" data-field="narrate" ${ui.narrate ? 'checked' : ''} ${ui.ending ? 'disabled' : ''}> Write the story in the chat</label>
           <button type="button" class="dcb-btn is-primary" data-action="finish" ${ui.ending ? 'disabled' : ''}><i class="fa-solid fa-flag-checkered"></i> Close the expedition</button>`;
    return `<div class="dcb-body dcb-end">
        <h2>${title}</h2>
        <p class="dcb-muted">${escapeHtml(facts)}</p>
        ${found.length ? `<ul class="dcb-rewards">${found.join('')}</ul>` : '<p class="dcb-muted">Nothing was found.</p>'}
        ${story}
        <h3>What happened</h3>
        ${logHtml()}
    </div>
    <footer class="dcb-foot">${foot}</footer>`;
}

// ─── Events ─────────────────────────────────────────────────────────────────

function onInput(ev) {
    const t = ev.target;
    if (view === 'setup' && setup && t.dataset.field === 'theme') setup.theme = t.value;
}

function onChange(ev) {
    const t = ev.target;
    if (view === 'setup' && setup) {
        if (t.dataset.party !== undefined) { setup.candidates[Number(t.dataset.party)].on = t.checked; render(); }
        else if (t.dataset.field === 'floors') setup.floors = Number(t.value) || 1;
        else if (t.dataset.field === 'size') setup.size = t.value;
        else if (t.dataset.field === 'useAI') setup.useAI = t.checked;
    } else if (view === 'end' && t.dataset.field === 'narrate') ui.narrate = t.checked;
}

function onClick(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const action = el.dataset.action;
    if (action === 'close') { closeDungeon(); return; }
    if (view === 'setup') return setupAction(action);
    if (view === 'explore') return exploreAction(action, el);
    if (view === 'end') return endAction(action);
}

async function setupAction(action) {
    const s = setup;
    if (action !== 'create' || s.busy) return;
    const party = s.candidates.filter(c => c.on).map(c => ({ name: c.name, isUser: c.isUser }));
    if (!party.length) return;
    s.busy = true; s.error = '';
    render();
    try {
        const res = await G.createDungeon(party, { theme: s.theme, floors: s.floors, size: s.size, useAI: s.useAI });
        if (!isOpen() || setup !== s) return;
        G.saveLiveDungeon(res.state);
        st = res.state;
        ui = freshUi();
        if (res.aiError) {
            ui.notice = `The AI could not dress the dungeon (${escapeHtml(res.aiError)}) — it uses generic names.`;
            ui.noticeKind = 'warn';
        }
        view = 'explore';
    } catch (e) {
        s.error = e?.message || 'The dungeon could not be built.';
    }
    s.busy = false;
    if (isOpen()) render();
}

function say(text, kind = 'info') {
    ui.notice = text;
    ui.noticeKind = kind;
}

function rollLine(entry) {
    return entry ? `${escapeHtml(entry.name)} ${escapeHtml(rollText(entry))} — ${degreeLabel(entry.degree)}.` : '';
}

function afterStep() {
    if (st.phase !== 'active') view = 'end';
    render();
}

function exploreAction(action, el) {
    ui.confirmLeave = action === 'leave-ask' ? true : (action === 'leave-no' ? false : ui.confirmLeave);
    if (action === 'leave-ask' || action === 'leave-no') { render(); return; }
    if (action === 'leave-yes') { G.endDungeon(st, 'left'); ui.confirmLeave = false; view = 'end'; render(); return; }
    if (action === 'resume-fight') return runFight(getLiveEncounter());
    ui.notice = '';
    const members = st.party;
    if (action === 'go') {
        const res = G.goTo(st, el.dataset.id);
        if (!res.ok && res.reason) say(escapeHtml(res.reason), 'warn');
        render();
        return;
    }
    if (action === 'down') { G.goDown(st); render(); return; }
    if (action === 'rest') { G.useRestRoom(st); render(); return; }
    if (action === 'fight') {
        if (getLiveEncounter()) { say('A fight is already going on in the combat window — finish or abandon it first.', 'warn'); render(); return; }
        return runFight(G.startRoomFight(st));
    }
    if (action === 'camp') {
        if (getLiveEncounter()) { say('A fight is already going on in the combat window — finish or abandon it first.', 'warn'); render(); return; }
        const res = G.camp(st);
        if (res.ambush) { say('Something finds you while you rest!', 'warn'); return runFight(res.fight); }
        if (res.ok) say('You rest a while and recover some strength.', 'good');
        render();
        return;
    }
    if (action === 'trap') {
        const actor = members[Number(el.dataset.i)];
        const res = actor && G.attemptTrap(st, actor);
        if (res?.ok) say(`${rollLine(res.entry)} ${res.success ? 'The trap does nothing.' : `It hurts: −${res.damage} Health.`}`, res.success ? 'good' : 'bad');
        afterStep();
        return;
    }
    if (action === 'chest-open' || action === 'chest-pick' || action === 'chest-force') {
        const actor = action === 'chest-open' ? null : members[Number(el.dataset.i)];
        const res = G.openChest(st, { method: action === 'chest-force' ? 'force' : (action === 'chest-pick' ? 'pick' : 'open'), actor });
        if (res.ok) {
            const what = [res.items.join(', '), res.money ? `${res.money} money` : ''].filter(Boolean).join(' and ') || 'nothing of use';
            say(`${res.entry ? rollLine(res.entry) + ' ' : ''}${res.outcome === 'jammed' ? `The chest jams: ${escapeHtml(what)}.${res.damage ? ` −${res.damage} Health.` : ''}` : `${res.outcome === 'rich' ? 'A rich haul: ' : 'Inside: '}${escapeHtml(what)}.`}`, res.outcome === 'jammed' ? 'bad' : 'good');
        }
        afterStep();
    }
}

/** Opens the combat window for a dungeon fight; the dungeon waits behind it. */
function runFight(fightState) {
    if (!fightState) { render(); return; }
    if (root) root.style.display = 'none';
    openEncounter(fightState, {
        narrate: false,
        onDone: () => {
            if (!isOpen()) return;
            G.reconcileFight(st);
            root.style.display = '';
            ui.notice = '';
            if (st.phase !== 'active') view = 'end';
            render();
        },
    });
}

async function endAction(action) {
    if (action !== 'finish' || ui.ending || ui.finished) return;
    ui.ending = true;
    render();
    const mine = st;
    try {
        ui.finished = await G.finishDungeon(mine, { narrate: ui.narrate });
    } catch (e) {
        ui.finished = { summary: null, narration: '', bonusXp: 0, narrationError: e?.message || 'error' };
    }
    ui.ending = false;
    if (isOpen() && st === mine) render();
}
