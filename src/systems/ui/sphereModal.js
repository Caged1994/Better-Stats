/**
 * Sphere grid window — a character's growth map.
 *
 * Without a grid yet it offers to make one (size, an optional flavour, with or
 * without the AI naming the abilities). With one it shows the map: the nodes
 * you own, the ones next to them that you can unlock, and the rest, dimmed.
 * Pick a node to see what it gives, then unlock it with the points levels
 * give. The rules are in src/utils/sphereModel.js, the link to the Stats data
 * in src/systems/features/sphereGrid.js. Reuses the combat window's look.
 */
import { ensureCss } from '../../core/cssLoader.js';
import { applyUiTheme, uiThemeReady } from '../../core/uiTheme.js';
import { escapeHtml } from '../../utils/html.js';
import { resolvePortrait } from './portraitBar.js';
import * as S from '../../utils/sphereModel.js';
import * as G from '../features/sphereGrid.js';
import { getStatCharacters } from '../features/characterStats.js';

const ROOT_ID = 'dooms-sphere';

let root = null;
let who = null; // { name, isUser }
let ui = null;
let setup = null;

const isOpen = () => !!root && document.body.contains(root);
const freshUi = () => ({ selected: null, notice: '', kind: 'info', confirmReset: false });
const freshSetup = () => ({ size: S.DEFAULT_SIZE, theme: '', useAI: true, busy: false, error: '' });

export async function openSphereGrid(name = null, isUser = false) {
    if (!G.isSphereEnabled()) {
        try { window.toastr?.info('The sphere grid is off — turn RPG mode and Levels on, and enable it in Settings → RPG & Stats.', 'Sphere grid'); } catch (e) { /* no toastr */ }
        return;
    }
    try { await ensureCss('combat'); await ensureCss('sphere'); } catch (e) { /* unstyled rather than not at all */ }
    await uiThemeReady();
    const chars = getStatCharacters();
    who = name ? { name, isUser: !!isUser } : (chars[0] ? { name: chars[0].name, isUser: chars[0].isUser } : null);
    ui = freshUi();
    setup = freshSetup();
    mount();
    render();
}

export function closeSphereGrid() {
    if (root) { root.remove(); root = null; }
}

function mount() {
    closeSphereGrid();
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'dcb dsg';
    applyUiTheme(root);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Sphere grid');
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
    const scroller = root.querySelector('.dsg-scroll');
    const pos = scroller ? [scroller.scrollLeft, scroller.scrollTop] : null;
    const view = who ? G.getGridView(who.name, who.isUser) : { grid: null, points: 0 };
    root.innerHTML = `<div class="dcb-window dsg-window">${header()}${who ? (view.grid ? gridHtml(view) : setupHtml()) : '<div class="dcb-body"><p class="dcb-empty">No characters yet.</p></div>'}</div>`;
    const s2 = root.querySelector('.dsg-scroll');
    if (s2 && pos) { s2.scrollLeft = pos[0]; s2.scrollTop = pos[1]; }
}

function header() {
    const chars = getStatCharacters();
    const tabs = chars.map(c => `<button type="button" class="dsg-who${who && c.name === who.name && !!c.isUser === !!who.isUser ? ' is-on' : ''}" data-action="who" data-name="${escapeHtml(c.name)}" data-user="${c.isUser ? 1 : 0}" title="${escapeHtml(c.name)}">${avatarHtml(c.name)}<span>${escapeHtml(c.name)}</span></button>`).join('');
    return `<header class="dcb-head">
        <span class="dcb-title"><i class="fa-solid fa-diagram-project"></i> Sphere grid</span>
        <span class="dcb-spacer"></span>
        <button type="button" class="dcb-icon-btn" data-action="close" title="Close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="dsg-whos">${tabs}</div>`;
}

function setupHtml() {
    const s = setup;
    const sizes = Object.entries(S.GRID_SIZES).map(([id, z]) => `<option value="${id}"${s.size === id ? ' selected' : ''}>${z.label} (${z.nodes} nodes)</option>`).join('');
    return `<div class="dcb-body">
        <section>
            <h3>${escapeHtml(who.name)} has no grid yet</h3>
            <p class="dcb-muted">A map of nodes to unlock with the points of each level: attribute boosts, spells, skills and passive bonuses. You start in the middle and can only unlock what is next to what you own. It sits next to the usual + on the Attributes tab.</p>
            <div class="dcb-row"><select data-field="size">${sizes}</select></div>
            <textarea class="dcb-text" data-field="theme" rows="2" maxlength="300" placeholder="Flavour of the grid (optional — e.g. a wandering swordsman who studies the old arts)">${escapeHtml(s.theme)}</textarea>
            <label class="dsg-check"><input type="checkbox" data-field="useAI" ${s.useAI ? 'checked' : ''}> Let the AI name the spells and skills <span class="dcb-muted">(one request; off: plain names, no request. What they do is set by the rules either way.)</span></label>
            ${s.error ? `<p class="dcb-error">${escapeHtml(s.error)}</p>` : ''}
        </section>
    </div>
    <footer class="dcb-foot">
        <button type="button" class="dcb-btn is-primary" data-action="create" ${s.busy ? 'disabled' : ''}>${s.busy ? '<i class="fa-solid fa-spinner fa-spin"></i> Building…' : '<i class="fa-solid fa-diagram-project"></i> Create the grid'}</button>
    </footer>`;
}

function nodeLabel(n) {
    if (n.type === 'attr') return `<b>${escapeHtml(String(n.stat).toUpperCase())}</b>`;
    if (n.type === 'start') return S.NODE_TYPES.start.icon;
    return escapeHtml(n.icon || S.NODE_TYPES[n.type].icon);
}

function mapHtml(view) {
    const { grid, reach } = view;
    const all = Object.values(grid.nodes);
    const minX = Math.min(...all.map(n => n.x)), maxX = Math.max(...all.map(n => n.x));
    const minY = Math.min(...all.map(n => n.y)), maxY = Math.max(...all.map(n => n.y));
    const cols = (maxX - minX + 1) * 2 - 1, rows = (maxY - minY + 1) * 2 - 1;
    const gx = (x) => (x - minX) * 2 + 1, gy = (y) => (y - minY) * 2 + 1;
    const colSizes = Array.from({ length: cols }, (_, i) => (i % 2 ? '14px' : '46px')).join(' ');
    const rowSizes = Array.from({ length: rows }, (_, i) => (i % 2 ? '14px' : '46px')).join(' ');
    const own = new Set(grid.unlocked);
    const links = [];
    for (const n of all) for (const l of n.links) if (n.id < l) {
        const o = grid.nodes[l];
        const lit = own.has(n.id) && own.has(l);
        const col = (gx(n.x) + gx(o.x)) / 2, row = (gy(n.y) + gy(o.y)) / 2;
        links.push(`<span class="dsg-link ${n.y === o.y ? 'is-h' : 'is-v'}${lit ? ' is-lit' : ''}" style="grid-column:${col};grid-row:${row}"></span>`);
    }
    const cells = all.map(n => {
        const cls = ['dsg-node', `t-${n.type}`];
        if (own.has(n.id)) cls.push('is-owned'); else if (reach.has(n.id)) cls.push('is-reach');
        if (ui.selected === n.id) cls.push('is-selected');
        const title = `${n.name || S.NODE_TYPES[n.type].label} — ${S.describeNode(n)}${n.cost ? ` (${n.cost} pt)` : ''}`;
        return `<button type="button" class="${cls.join(' ')}" style="grid-column:${gx(n.x)};grid-row:${gy(n.y)}" data-action="node" data-id="${escapeHtml(n.id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${nodeLabel(n)}${n.cost > 1 && !own.has(n.id) ? `<i class="dsg-cost">${n.cost}</i>` : ''}</button>`;
    });
    return `<div class="dsg-scroll"><div class="dsg-map" style="grid-template-columns:${colSizes};grid-template-rows:${rowSizes}">${links.join('')}${cells.join('')}</div></div>`;
}

function detailHtml(view) {
    const { grid, points, reach } = view;
    const n = ui.selected && grid.nodes[ui.selected];
    if (!n) return '<section class="dsg-detail"><p class="dcb-muted">Pick a node to see what it gives. Bright nodes next to what you own can be unlocked.</p></section>';
    const own = grid.unlocked.includes(n.id);
    const can = S.canUnlock(grid, n.id, points);
    const kind = n.type === 'ability' ? (n.slot.kind === 'spell' ? 'Spell' : 'Skill') : S.NODE_TYPES[n.type].label;
    const extra = n.type === 'ability' ? `<p class="dsg-eff">${escapeHtml(profileText(n.slot.profile))}</p>` : '';
    return `<section class="dsg-detail t-${n.type}">
        <header><span class="dsg-detail-icon">${nodeLabel(n)}</span><div><strong>${escapeHtml(n.name || kind)}</strong><small>${escapeHtml(kind)}${n.cost ? ` · ${n.cost} point${n.cost === 1 ? '' : 's'}` : ''}</small></div></header>
        ${n.desc ? `<p>${escapeHtml(n.desc)}</p>` : ''}
        <p class="dsg-eff">${escapeHtml(S.describeNode(n))}</p>${extra}
        ${own ? '<p class="dcb-note"><i class="fa-solid fa-check"></i> Unlocked.</p>'
            : `<button type="button" class="dcb-btn is-primary" data-action="unlock" ${can.ok ? '' : 'disabled'}><i class="fa-solid fa-unlock"></i> Unlock <small>(${n.cost} pt)</small></button>${can.ok || !can.reason ? '' : `<p class="dcb-muted">${escapeHtml(can.reason)}</p>`}`}
    </section>`;
}

function profileText(p) {
    const power = { light: 'Light', medium: 'Medium', heavy: 'Heavy' }[p.power] || '';
    const target = { enemy: 'one enemy', enemies: 'all enemies', ally: 'one ally', allies: 'all allies', self: 'self' }[p.target] || '';
    const what = p.type === 'damage' ? 'Damage' : p.type === 'heal' ? 'Heals' : p.type === 'status' ? `Status: ${p.status}` : p.type;
    return `In a fight: ${[what, power, p.stat && p.stat !== 'none' ? p.stat.toUpperCase() : '', target ? `targets ${target}` : '', p.type === 'damage' && p.status ? `may cause ${p.status}` : ''].filter(Boolean).join(' · ')}`;
}

function gridHtml(view) {
    const { grid, points, progress } = view;
    return `<div class="dcb-body dsg-body">
        <div class="dsg-top">
            <span class="dsg-points${points ? ' is-up' : ''}"><i class="fa-solid fa-star"></i> ${points} point${points === 1 ? '' : 's'} to spend</span>
            <span class="dcb-muted">${progress.unlocked}/${progress.total} unlocked</span>
            <span class="dcb-spacer"></span>
            ${ui.confirmReset ? '<span class="dsg-confirm">Start a new grid? Spells and bonuses you learned stay; the map is replaced and the points spent are not refunded. <button type="button" class="dcb-btn is-primary" data-action="reset-yes">New grid</button><button type="button" class="dcb-btn" data-action="reset-no">Keep</button></span>' : '<button type="button" class="dcb-btn" data-action="reset-ask" title="Replace this grid with a new one"><i class="fa-solid fa-rotate"></i> New grid</button>'}
        </div>
        ${ui.notice ? `<p class="dsg-notice is-${ui.kind}">${escapeHtml(ui.notice)}</p>` : ''}
        <div class="dsg-main">${mapHtml(view)}${detailHtml(view)}</div>
    </div>`;
}

// ─── Events ─────────────────────────────────────────────────────────────────

function onInput(ev) {
    const t = ev.target;
    if (t.dataset.field === 'theme') setup.theme = t.value;
}

function onChange(ev) {
    const t = ev.target;
    if (t.dataset.field === 'size') setup.size = t.value;
    else if (t.dataset.field === 'useAI') setup.useAI = t.checked;
}

async function onClick(ev) {
    const el = ev.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const action = el.dataset.action;
    if (action === 'close') { closeSphereGrid(); return; }
    if (action === 'who') { who = { name: el.dataset.name, isUser: el.dataset.user === '1' }; ui = freshUi(); setup = freshSetup(); render(); return; }
    if (!who) return;
    if (action === 'create') {
        if (setup.busy) return;
        setup.busy = true; setup.error = '';
        render();
        const mine = who;
        try {
            const res = await G.createGrid(mine.name, mine.isUser, { size: setup.size, theme: setup.theme, useAI: setup.useAI });
            if (!isOpen()) return;
            ui = freshUi();
            if (res.aiError) { ui.notice = `The AI could not name the abilities (${res.aiError}) — plain names are used.`; ui.kind = 'warn'; }
        } catch (e) {
            setup.error = e?.message || 'The grid could not be built.';
        }
        setup.busy = false;
        if (isOpen()) render();
        return;
    }
    if (action === 'node') { ui.selected = el.dataset.id; ui.notice = ''; render(); return; }
    if (action === 'unlock') {
        const res = G.unlockNode(who.name, who.isUser, ui.selected);
        ui.notice = res.ok ? `Unlocked: ${res.gave}.` : (res.reason || 'It cannot be unlocked.');
        ui.kind = res.ok ? 'good' : 'warn';
        render();
        return;
    }
    if (action === 'reset-ask') { ui.confirmReset = true; render(); return; }
    if (action === 'reset-no') { ui.confirmReset = false; render(); return; }
    if (action === 'reset-yes') { G.deleteGrid(who.name, who.isUser); ui = freshUi(); setup = freshSetup(); render(); }
}
