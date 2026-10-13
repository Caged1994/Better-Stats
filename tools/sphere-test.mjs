#!/usr/bin/env node
/**
 * Sphere grid test — the grid rules (layout, regions, unlocking, dressing) and
 * the glue to the Stats data (points, attributes, spells, passives).
 *
 * Usage:  node tools/sphere-test.mjs     (from the repo root)
 * Exit:   0 = pass, 1 = failure
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SANDBOX = '/tmp/des-load-check';
const DES = `${SANDBOX}/scripts/extensions/third-party/DES`;

execFileSync(process.execPath, ['tools/load-check.mjs'], { stdio: 'pipe' });
const scriptStub = `${SANDBOX}/script.js`;
writeFileSync(scriptStub, readFileSync(scriptStub, 'utf8')
    .replace('export const chat_metadata = anything;', 'export const chat_metadata = {};')
    .replace('export const chat = anything;', 'export const chat = [];'));

const anything = new Proxy(function () {}, {
    get(t, p) {
        if (p === Symbol.toPrimitive) return () => 'stub';
        if (p === 'then') return undefined;
        if (p === Symbol.iterator) return function* () {};
        return anything;
    },
    apply() { return anything; },
    construct() { return {}; },
});
globalThis.__DES_ANYTHING__ = anything;
globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = anything;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8, maxTouchPoints: 0 }, configurable: true });
globalThis.jQuery = anything;
globalThis.$ = anything;
const toasts = [];
globalThis.toastr = { success: (m) => toasts.push(m), info: (m) => toasts.push(m), warning: () => {} };
globalThis.SillyTavern = anything;
globalThis.requestAnimationFrame = () => 0;
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.dispatchEvent = () => true;

const { extensionSettings, committedTrackerData } = await import(`${DES}/src/core/state.js`);
const { chat, chat_metadata } = await import(`${SANDBOX}/script.js`);
// Data belongs to the chat: another chat is another dooms_tracker blob.
const savedChats = [];
const otherChat = () => { savedChats.push(chat_metadata.dooms_tracker); chat_metadata.dooms_tracker = {}; };
const backToChat = () => { chat_metadata.dooms_tracker = savedChats.pop(); };
const S = await import(`${DES}/src/systems/features/characterStats.js`);
const Eq = await import(`${DES}/src/systems/features/characterEquipment.js`);
const Ab = await import(`${DES}/src/systems/features/characterAbilities.js`);
const P = await import(`${DES}/src/systems/features/characterProgress.js`);
const R = await import(`${DES}/src/systems/features/rpgMode.js`);
const Cb = await import(`${DES}/src/systems/features/combat.js`);
const M = await import(`${DES}/src/utils/combatModel.js`);
const Cd = await import(`${DES}/src/systems/features/characterConditions.js`);
const Mo = await import(`${DES}/src/systems/features/characterMoney.js`);
const Af = await import(`${DES}/src/systems/features/characterAffinity.js`);
const { chatStore } = await import(`${DES}/src/systems/features/chatScope.js`);

let failures = 0;
const check = (label, cond, extra = '') => {
    if (cond) console.log(`pass  ${label}`);
    else { console.error(`FAIL  ${label}${extra ? '\n      ' + extra : ''}`); failures++; }
};

const Sm = await import(`${DES}/src/utils/sphereModel.js`);
const Sg = await import(`${DES}/src/systems/features/sphereGrid.js`);

extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: {}, activeCampaignId: null };
extensionSettings.knownCharacters = { Elena: {} };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Mastera' }] });
for (const [n, u] of [['Mastera', true], ['Elena', false]]) { Eq.cancelStartingGear(n, u); Ab.cancelStartingAbilities(n, u); }
S.saveStatSheet('Elena', false, S.getStatSheet('Elena', false), { pending: false });
chat.push({ is_user: true, mes: 'The old monk offers to teach me.', name: 'Mastera' });

const ATTRS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

// ── 1. The grid ──
let det = true, conn = true, counts = true, kinds = true, spread = true, costs = true;
for (const size of Object.keys(Sm.GRID_SIZES)) {
    for (let seed = 1; seed <= 40; seed++) {
        const a = Sm.generateGrid({ seed, size, attributes: ATTRS });
        const b = Sm.generateGrid({ seed, size, attributes: ATTRS });
        if (JSON.stringify(a) !== JSON.stringify(b)) det = false;
        const nodes = Object.values(a.nodes);
        const z = Sm.GRID_SIZES[size];
        if (nodes.length !== z.nodes) counts = false;
        const seen = new Set([a.start]); const q = [a.start];
        while (q.length) for (const l of a.nodes[q.shift()].links) if (!seen.has(l)) { seen.add(l); q.push(l); }
        if (seen.size !== nodes.length) conn = false;
        for (const n of nodes) for (const l of n.links) if (!a.nodes[l].links.includes(n.id)) conn = false;
        const ab = nodes.filter(n => n.type === 'ability').length, pa = nodes.filter(n => n.type === 'passive').length;
        if (ab < z.abilities - 2 || pa < z.passives - 2) kinds = false;
        if (nodes.some(n => (n.type === 'ability' || n.type === 'passive') && n.depth < 2)) spread = false;
        if (nodes.some(n => n.type !== 'start' && !(n.cost >= 1 && n.cost <= 3))) costs = false;
    }
}
check('the same seed gives the same grid', det);
check('every size has its number of nodes', counts);
check('every node is reachable and links are mutual', conn);
check('there are spells, skills and passives (near the target)', kinds);
check('they are never next to the start', spread);
check('costs are 1 to 3, the start is free', costs);
const g = Sm.generateGrid({ seed: 5, attributes: ATTRS });
check('the start is unlocked and costs nothing', g.unlocked.length === 1 && g.nodes[g.start].cost === 0 && g.nodes[g.start].type === 'start');
check('all spells and skills carry a valid combat profile', Object.values(g.nodes).filter(n => n.type === 'ability').every(n => !!M.normalizeProfile(n.slot.profile) && n.name));
check('spells have a Mana tier, skills do not', Object.values(g.nodes).filter(n => n.type === 'ability').every(n => (n.slot.kind === 'spell') === !!n.slot.cost));
check('regions: most attribute nodes follow their area', (() => { const a = Object.values(g.nodes).filter(n => n.type === 'attr'); return a.filter(n => n.stat === n.region).length / a.length > 0.6; })());
const near = Sm.reachable(g);
check('only nodes next to the start are reachable at first', near.length === g.nodes[g.start].links.length && near.every(id => g.nodes[g.start].links.includes(id)));
const far = Object.values(g.nodes).find(n => n.depth >= 3);
check('a far node cannot be unlocked', !Sm.canUnlock(g, far.id, 99).ok);
check('not without enough points', (() => { const id = near.find(i => g.nodes[i].cost > 1) || near[0]; return g.nodes[id].cost > 1 ? !Sm.canUnlock(g, id, 0).ok : !Sm.canUnlock(g, id, 0).ok; })());
check('an unlocked node cannot be unlocked again', !Sm.canUnlock(g, g.start, 9).ok);

// ── 2. Dressing ──
const dg = Sm.generateGrid({ seed: 9, attributes: ATTRS });
const slots = Object.values(dg.nodes).filter(n => n.type === 'ability' || n.type === 'passive');
const kindBefore = JSON.stringify(slots.map(n => [n.type, n.slot, n.bonus]));
const dressed = Sm.applyDressing(dg, { nodes: { [slots[0].id]: { name: 'Moon lance', description: 'A silver spear of light.', icon: '🌙' }, [slots[1].id]: { name: 'Moon lance' }, [slots[2].id]: { name: '' }, zz: { name: 'x' } } });
check('the AI names nodes, duplicates and blanks are ignored', dressed === 1 && slots[0].name === 'Moon lance' && slots[0].desc.startsWith('A silver'));
check('the AI cannot change what a node does', JSON.stringify(slots.map(n => [n.type, n.slot, n.bonus])) === kindBefore);
check('applyDressing refuses junk', Sm.applyDressing(dg, null) === 0 && Sm.applyDressing(dg, 'x') === 0);

// ── 3. The feature ──
check('off by default', !Sg.isSphereEnabled());
Sg.setSphereEnabled(true);
check('on with RPG mode and levels once switched on', Sg.isSphereEnabled());
let calls = 0;
const reply = async () => { calls++; return JSON.stringify({ nodes: {} }); };
const made = await Sg.createGrid('Mastera', true, { seed: 77, generate: reply });
check('with an AI that said nothing useful the grid is complete and says why', calls === 1 && made.aiError && Object.values(made.grid.nodes).every(n => (n.type !== 'ability' && n.type !== 'passive') || n.name));
const plain = await Sg.createGrid('Mastera', true, { seed: 77, useAI: false, generate: reply });
check('"no AI" makes no request', calls === 1 && !plain.aiError);
let ok = await Sg.createGrid('Mastera', true, { seed: 77, generate: async () => {
    const gg = Sm.generateGrid({ seed: 77, attributes: ATTRS });
    const out = {};
    for (const n of Object.values(gg.nodes)) if (n.type === 'ability' || n.type === 'passive') out[n.id] = { name: `Named ${n.id}`, description: 'x', icon: '✨' };
    return '```json\n' + JSON.stringify({ nodes: out }) + '\n```';
} });
check('a real reply names the nodes', !ok.aiError && Object.values(ok.grid.nodes).some(n => n.name?.startsWith('Named ')));
const grid = Sg.getGrid('Mastera', true);
check('the grid is kept in the chat, one per character', !!grid && Sg.getGrid('Elena', false) === null);

check('no points, no unlock', (() => { const r = Sg.unlockNode('Mastera', true, Sm.reachable(grid)[0]); return !r.ok && /costs|point/i.test(r.reason); })());
P.setUnspentPoints('Mastera', true, 20);
const attrNode = Sm.reachable(Sg.getGrid('Mastera', true)).map(id => grid.nodes[id]).find(n => n.type === 'attr');
const before = S.getCurrentStatValues('Mastera', true)[attrNode.stat];
const r1 = Sg.unlockNode('Mastera', true, attrNode.id);
check('an attribute node raises the attribute and costs a point', r1.ok && S.getCurrentStatValues('Mastera', true)[attrNode.stat] === before + 1 && P.getProgress('Mastera', true).points === 19, JSON.stringify(r1));
check('it is not unlocked twice', !Sg.unlockNode('Mastera', true, attrNode.id).ok);
check('a far node is refused and costs nothing', (() => { const f = Object.values(grid.nodes).find(n => n.depth >= 4); const r = Sg.unlockNode('Mastera', true, f.id); return !r.ok && P.getProgress('Mastera', true).points === 19; })());

// Walk outwards until a spell, a skill and a passive are learned.
let learned = { spell: null, skill: null, passive: null };
for (let i = 0; i < 80 && !(learned.spell && learned.skill && learned.passive); i++) {
    const gv = Sg.getGridView('Mastera', true);
    const want = [...gv.reach].map(id => gv.grid.nodes[id]).sort((a, b) => (a.type === 'attr') - (b.type === 'attr'));
    P.setUnspentPoints('Mastera', true, 20);
    const n = want[0];
    const r = Sg.unlockNode('Mastera', true, n.id);
    if (!r.ok) { check('walking: ' + r.reason, false); break; }
    if (n.type === 'ability') learned[n.slot.kind === 'spell' ? 'spell' : 'skill'] = learned[n.slot.kind === 'spell' ? 'spell' : 'skill'] || n;
    if (n.type === 'passive') learned.passive = learned.passive || n;
}
const abilities = Ab.getAbilities('Mastera', true);
if (learned.spell) {
    const a = abilities.find(x => x.name === Sg.getGrid('Mastera', true).nodes[learned.spell.id].learnedAs);
    check('a spell node adds a real spell with its Mana cost', a && a.type === 'spell' && a.cost === learned.spell.slot.cost, JSON.stringify(a));
    const act = Cb.buildPartyMember('Mastera', true).combatant.actions.find(x => x.label === a.name);
    check('and it is usable in a fight with the planned effect', act && act.profile.type === learned.spell.slot.profile.type && act.profile.power === learned.spell.slot.profile.power, JSON.stringify(act?.profile));
} else check('a spell node was reached', false);
if (learned.skill) {
    const a = abilities.find(x => x.name === Sg.getGrid('Mastera', true).nodes[learned.skill.id].learnedAs);
    check('a skill node adds a skill', a && a.type === 'ability');
} else check('a skill node was reached', false);
if (learned.passive) {
    const a = abilities.find(x => x.name === Sg.getGrid('Mastera', true).nodes[learned.passive.id].learnedAs);
    check('a passive node adds a passive skill with its bonus', a && Object.keys(a.effects || {}).length >= 1, JSON.stringify(a));
} else check('a passive node was reached', false);
check('points are spent by cost', Sm.gridProgress(Sg.getGrid('Mastera', true)).spent > 0);
// A name already known gets a number.
const taken = Object.values(Sg.getGrid('Mastera', true).nodes).find(n => n.type === 'ability' && !Sm.isUnlocked(Sg.getGrid('Mastera', true), n.id));
if (taken) {
    Ab.addAbility('Mastera', true, { name: taken.name, type: 'ability' });
    // make it reachable
    const gg = Sg.getGrid('Mastera', true);
    gg.unlocked.push(...gg.nodes[taken.id].links.filter(l => !gg.unlocked.includes(l)));
    P.setUnspentPoints('Mastera', true, 20);
    const r = Sg.unlockNode('Mastera', true, taken.id);
    check('a name that is already known gets a number', r.ok && /\b2$/.test(Sg.getGrid('Mastera', true).nodes[taken.id].learnedAs), JSON.stringify(r));
}
otherChat();
check('another chat has no grid', Sg.getGrid('Mastera', true) === null);
backToChat();
check('deleting a grid forgets it', Sg.deleteGrid('Mastera', true) && Sg.getGrid('Mastera', true) === null);
Sg.setSphereEnabled(false);
check('switched off again', !Sg.isSphereEnabled());

console.log(failures ? `\n${failures} check(s) failed` : '\nall sphere checks passed');
process.exit(failures ? 1 : 0);
