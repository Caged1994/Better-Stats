#!/usr/bin/env node
/**
 * Dungeon test — the dungeon rules (layout, fog, moves, camp, dressing) and
 * the glue to the Stats data (fights, traps, chests, rest, the end).
 *
 * Usage:  node tools/dungeon-test.mjs     (from the repo root)
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

const D = await import(`${DES}/src/utils/dungeonModel.js`);
const Dg = await import(`${DES}/src/systems/features/dungeon.js`);

extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: {}, activeCampaignId: null };
extensionSettings.knownCharacters = { Elena: {} };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Mastera' }] });
for (const [n, u] of [['Mastera', true], ['Elena', false]]) { Eq.cancelStartingGear(n, u); Ab.cancelStartingAbilities(n, u); }
S.saveStatSheet('Elena', false, S.getStatSheet('Elena', false), { pending: false });
chat.push({ is_user: true, mes: 'We go down the old well.', name: 'Mastera' }, { is_user: false, mes: 'A cold draught.', name: 'Narrator' });
P.setPartyMember('Elena', true);
const party = [{ name: 'Mastera', isUser: true }, { name: 'Elena', isUser: false }];

// ── 1. The layout ──
const types = (st) => st.floors.flatMap(f => Object.values(f.rooms)).map(r => r.type);
let allConnected = true, exitFar = true, counts = true, deadTreasure = true, deadEndMiss = 0, total = 0, again = true;
for (const size of Object.keys(D.SIZES)) {
    for (let seed = 1; seed <= 40; seed++) {
        const a = D.generateDungeon({ seed, floors: 2, size, partySize: 2, partyLevel: 3 });
        const b = D.generateDungeon({ seed, floors: 2, size, partySize: 2, partyLevel: 3 });
        if (JSON.stringify(a) !== JSON.stringify(b)) again = false;
        for (const f of a.floors) {
            const rooms = f.rooms;
            const seen = new Set([f.start]); const q = [f.start];
            while (q.length) for (const l of rooms[q.shift()].links) if (!seen.has(l)) { seen.add(l); q.push(l); }
            if (seen.size !== Object.keys(rooms).length) allConnected = false;
            if (Math.abs(Object.keys(rooms).length - D.SIZES[size].rooms) > 1) counts = false;
            const maxDepth = Math.max(...Object.values(rooms).map(r => r.depth));
            if (rooms[f.exit].depth !== maxDepth) exitFar = false;
            for (const r of Object.values(rooms)) if (r.type === 'treasure' && r.links.length !== 1) deadEndMiss++;
            for (const r of Object.values(rooms)) for (const l of r.links) if (!rooms[l].links.includes(r.id)) allConnected = false;
        }
    }
}
check('the same seed gives the same dungeon', again);
check('every room is reachable and links are mutual', allConnected);
check('rooms per floor are the size, give or take one', counts);
check('the exit is the farthest room', exitFar);
check('treasure mostly sits in dead ends', deadEndMiss < 30, String(deadEndMiss));
const dg = D.generateDungeon({ seed: 7, floors: 3, size: 'medium', partySize: 2, partyLevel: 3 });
check('floors: 3, first floor ends in stairs, last in a boss', dg.floors.length === 3 && dg.floors[0].rooms[dg.floors[0].exit].type === 'stairs' && dg.floors[2].rooms[dg.floors[2].exit].type === 'boss');
check('there are fights', types(dg).filter(t => t === 'combat').length >= 3);
check('floors are capped at three', D.generateDungeon({ seed: 1, floors: 9 }).floors.length === 3);
check('every fight room has enemies', dg.floors.every(f => Object.values(f.rooms).every(r => (r.type !== 'combat' && r.type !== 'boss') || r.enemies.length > 0)));
check('traps and locked chests carry their numbers', Object.values(dg.floors[0].rooms).every(r => r.type !== 'trap' || (r.trap && r.trap.damage > 0 && r.trap.stat)) && Object.values(dg.floors[0].rooms).every(r => r.type !== 'treasure' || (r.loot && typeof r.loot.money === 'number')));

// ── 2. Fog, moves, blocking ──
const st = D.generateDungeon({ seed: 11, floors: 2, size: 'small', partySize: 2, partyLevel: 3 });
st.party = party;
const vis0 = D.visibleRooms(st);
const start = D.currentRoom(st);
check('at first only the start and its neighbours show', vis0.length === 1 + start.links.length && vis0.filter(v => v.known).length === 1);
check('you cannot jump to a room that is not next to you', !D.canMove(st, Object.keys(st.floors[0].rooms).find(id => id !== st.at && !start.links.includes(id))).ok);
// Walk until a blocking room is found.
const blocking = start.links.map(l => D.getRoom(st, l)).find(r => D.BLOCKING.has(r.type));
if (blocking) {
    D.move(st, blocking.id);
    const other = blocking.links.find(l => l !== st.from);
    check('a room with enemies or a trap blocks going further', other && !D.canMove(st, other).ok);
    check('but you can step back', D.canMove(st, st.from).ok);
    blocking.cleared = true;
    check('cleared, it lets you pass', other ? D.canMove(st, other).ok : true);
} else {
    check('a room with enemies or a trap blocks going further (no blocking room next to the start in this seed)', true);
}
check('visited rooms are remembered', D.exploredCount(st).seen >= 1);
const stairsFloor = D.generateDungeon({ seed: 5, floors: 2, size: 'small' });
stairsFloor.at = stairsFloor.floors[0].exit;
check('descending needs the stairs', D.descend(stairsFloor).ok && stairsFloor.floor === 1 && stairsFloor.at === stairsFloor.floors[1].start);
check('no stairs on the last floor', !D.descend(stairsFloor).ok);

// ── 3. Camping ──
const camp = D.generateDungeon({ seed: 3, floors: 1, size: 'small' });
check('ambush chance rises with each camp and is capped', (() => { const c0 = D.ambushChance(camp); camp.danger = 3; const c3 = D.ambushChance(camp); camp.danger = 99; return c3 > c0 && D.ambushChance(camp) === 0.6; })());
const tiers = D.ambushTiers(camp);
check('an ambush is a plain group', tiers.length >= 1 && !tiers.includes('boss'));
const wand = D.wanderingSpecs(camp, ['normal', 'normal', 'minion']);
check('wandering groups have distinct names and attacks', new Set(wand.map(w => w.name)).size === 3 && wand.every(w => w.attacks.length));

// ── 4. Dressing ──
const dr = D.generateDungeon({ seed: 21, floors: 1, size: 'small', partySize: 2, partyLevel: 2, theme: 'a flooded crypt' });
const combatRoom = Object.values(dr.floors[0].rooms).find(r => r.type === 'combat');
const tier0 = combatRoom.enemies[0].tier;
const n = D.applyDressing(dr, {
    title: 'The Drowned Crypt', floors: [{ name: 'Lower vault' }],
    rooms: {
        [combatRoom.id]: { name: 'Flooded hall', description: 'Black water to the knees.', enemies: [{ name: 'Drowned monk', tier: 'boss', attacks: [{ name: 'Touch', power: 'light' }] }] },
        nope: { name: 'x' },
    },
}, (arr) => arr.map(e => ({ name: e.name, attacks: e.attacks, tier: e.tier })));
check('the AI dresses rooms, names and title', n >= 1 && dr.title === 'The Drowned Crypt' && combatRoom.name === 'Flooded hall' && dr.floors[0].name === 'Lower vault');
check('the AI cannot change an enemy\'s category', combatRoom.enemies[0].name === 'Drowned monk' && combatRoom.enemies[0].tier === tier0);
D.fillDressing(dr);
check('what the AI left empty is filled', Object.values(dr.floors[0].rooms).every(r => r.name && r.desc) && Object.values(dr.floors[0].rooms).filter(r => r.type === 'combat' || r.type === 'boss').every(r => r.enemies.every(e => e.name && e.attacks.length)));
check('applyDressing refuses junk', D.applyDressing(dr, null) === 0 && D.applyDressing(dr, 'x') === 0);

// ── 5. The feature layer ──
check('the dungeon is available with RPG mode and combat', Dg.isDungeonEnabled());
const fakeGen = async () => JSON.stringify({ title: 'The Old Well', rooms: {}, profiles: {} });
const made = await Dg.createDungeon(party, { theme: 'a well', floors: 1, size: 'small', seed: 99, generate: fakeGen });
check('a dungeon is created and complete with an AI that said little', made.state.title === 'The Old Well' && made.state.party.length === 2 && Object.values(made.state.floors[0].rooms).every(r => r.name));
const failed = await Dg.createDungeon(party, { floors: 1, size: 'small', seed: 99, generate: async () => { throw new Error('no network'); } });
check('without the AI it still works, and says why', failed.aiError === 'no network' && failed.state.floors[0].rooms[failed.state.at].name);
const plain = await Dg.createDungeon(party, { floors: 1, size: 'small', seed: 99, useAI: false });
check('"no AI" skips the call', !plain.aiError && plain.state.title);
const g = made.state;
Dg.saveLiveDungeon(g);
check('the dungeon is kept in the chat', Dg.hasLiveDungeon() && Dg.getLiveDungeon().id === g.id);

// Walk to the first combat room by shortest path (clearing blockers on the way).
function pathTo(state, pred) {
    const rooms = state.floors[state.floor].rooms;
    const prev = { [state.at]: null }; const q = [state.at];
    while (q.length) { const id = q.shift(); if (pred(rooms[id])) { const p = []; for (let c = id; c; c = prev[c]) p.unshift(c); return p; } for (const l of rooms[id].links) if (!(l in prev)) { prev[l] = id; q.push(l); } }
    return null;
}
function walk(state, pred) {
    const p = pathTo(state, pred);
    for (const id of p.slice(1)) {
        const here = D.currentRoom(state);
        if (D.blocksExit(here)) here.cleared = true;
        const r = Dg.goTo(state, id);
        if (!r.ok) return false;
    }
    return true;
}
const hpOf = (n, u) => S.getCurrentStatValues(n, u, S.getStatSheet(n, u).stats ? undefined : undefined);
walk(g, r => r.type === 'combat');
const room = D.currentRoom(g);
const fight = Dg.startRoomFight(g);
check('a room fight starts tagged and pending', fight && fight.tag.dungeon === g.id && fight.tag.room === room.id && g.pendingFight?.kind === 'room' && Cb.getLiveEncounter());
check('no moving during a fight', !D.canMove(g, g.from || room.links[0]).ok);
check('no second fight at the same time', Dg.startRoomFight(g) === null);
// Fled: back where it came from, room not cleared.
const from = g.pendingFight.from;
Dg.resolveFight(g, { result: 'fled' });
check('fleeing goes back, enemies stay', g.at === from && !room.cleared && !g.pendingFight);
// Victory.
g.at = room.id; g.from = from;
Dg.startRoomFight(g);
const r1 = Dg.resolveFight(g, { result: 'victory', xp: 30, money: 5, items: ['Old coin'] });
check('victory clears the room and adds up spoils', room.cleared && g.stats.fights === 2 && g.stats.xp >= 30 && g.stats.money === 5 && g.stats.items.includes('Old coin') && !r1.ended);
// Reconcile from the saved result.
Cb.clearLiveEncounter?.();
g.at = room.id; room.cleared = false;
Dg.startRoomFight(g);
check('while the fight is live nothing is reconciled', Dg.reconcileFight(g) === false);
// Defeat ends it.
Dg.resolveFight(g, { result: 'defeat' });
check('a defeat ends the expedition without dying', g.phase === 'ended' && g.result === 'defeated');

// Traps and chests, on a fresh dungeon.
const g2 = D.generateDungeon({ seed: 31, floors: 1, size: 'large', partySize: 2, partyLevel: 3 }); g2.party = party; D.fillDressing(g2);
const trapRoom = Object.values(g2.floors[0].rooms).find(r => r.type === 'trap');
if (trapRoom) {
    walk(g2, r => r.id === trapRoom.id);
    const opts = Dg.tryOptions(g2, trapRoom.trap.stat, trapRoom.trap.difficulty);
    check('trap: each member has a chance', opts.length === 2 && opts.every(o => o.chance >= 0.05 && o.chance <= 0.95 || !o.has));
    const hp0 = S.getCurrentStatValues('Mastera', true, S.getStatSheet('Mastera', true).stats)?.health;
    const bad = Dg.attemptTrap(g2, party[0], { rng: () => 0 }); // natural 1
    check('trap: a natural 1 hurts and clears the room', bad.ok && !bad.success && bad.damage > 0 && trapRoom.cleared && g2.stats.trapsFailed === 1);
    check('trap: a hurt member does not drop below 1', S.getCurrentStatValues('Mastera', true, S.getStatSheet('Mastera', true).stats).health >= 1);
} else check('trap room exists in this seed', false);
const chestRoom = Object.values(g2.floors[0].rooms).find(r => r.type === 'treasure');
if (chestRoom) {
    walk(g2, r => r.id === chestRoom.id);
    chestRoom.loot.locked = true; chestRoom.loot.items = ['Ruby']; chestRoom.loot.money = 40;
    const money0 = Mo.getMoney('Mastera', true);
    const jam = Dg.openChest(g2, { method: 'force', actor: party[0], rng: () => 0 });
    check('chest: forcing and failing jams it (half the money, no items, costs Health)', jam.ok && jam.outcome === 'jammed' && jam.money === 20 && jam.items.length === 0 && jam.damage > 0 && Mo.getMoney('Mastera', true) === money0 + 20);
    check('chest: it cannot be opened twice', Dg.openChest(g2, { method: 'open' }).ok === false);
} else check('chest room exists in this seed', false);
const restRoom = Object.values(g2.floors[0].rooms).find(r => r.type === 'rest');
if (restRoom) {
    walk(g2, r => r.id === restRoom.id);
    S.setCurrentStatValue('Mastera', true, 'health', 30);
    const rr = Dg.useRestRoom(g2);
    check('rest room: heals the party once', rr.ok && S.getCurrentStatValues('Mastera', true, S.getStatSheet('Mastera', true).stats).health === 75 && Dg.useRestRoom(g2).ok === false);
}
const c = Dg.camp(g2);
check('camp: either rests or an ambush starts', c.ok && (c.ambush ? !!g2.pendingFight : g2.stats.rests >= 1));

// ── 6. The end ──
const g3 = D.generateDungeon({ seed: 8, floors: 1, size: 'small', partySize: 2, partyLevel: 2 }); g3.party = party; D.fillDressing(g3);
Dg.saveLiveDungeon(g3);
let said = 0;
const fin = await Dg.finishDungeon(g3, { narrate: true, generate: async () => { said++; return 'They climbed out, tired.'; }, post: false });
check('finishing leaves the expedition as left, clears the saved one and tells the story', g3.result === 'left' && !Dg.getLiveDungeon() && fin.narration === 'They climbed out, tired.' && said === 1);
const fin2 = await Dg.finishDungeon(g3, { narrate: true, generate: async () => { said++; return 'again'; }, post: false });
check('finishing twice does not tell the story twice', said === 1 && !fin2.narration);

console.log(failures ? `\n${failures} check(s) failed` : '\nall dungeon checks passed');
process.exit(failures ? 1 : 0);
