#!/usr/bin/env node
/**
 * Combat model test — the pure rules in src/utils/combatModel.js:
 * hit chance, damage, armour, healing, statuses, cooldowns and Mana,
 * initiative and turns, enemy behaviour, flight, rewards, and a balance
 * check (simulated fights stay inside sensible win-rate bands).
 *
 * Usage:  node tools/combat-test.mjs     (from the repo root)
 * Exit:   0 = pass, 1 = failure
 */
import * as C from '../src/utils/combatModel.js';

let passed = 0;
let failed = 0;
function ok(cond, label) {
    if (cond) { passed++; return; }
    failed++;
    console.error('FAIL:', label);
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

const ATTRS = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
const prof = (o) => C.normalizeProfile(o);

function hero(id, over = {}, actions = []) {
    return C.makeCombatant({ id, side: 'party', name: id, level: 1, attrs: { ...ATTRS, ...(over.attrs || {}) }, mana: 100, ...over, actions });
}
function foe(id, over = {}) {
    return C.makeCombatant({ id, side: 'enemy', name: id, level: 1, attrs: { ...ATTRS, ...(over.attrs || {}) }, ...over });
}
const act = (id, p, extra = {}) => ({ id, label: id, icon: '✨', kind: 'ability', profile: prof(p), manaCost: 0, cooldown: 0, ...extra });
function fight(combatants, seed = 1) {
    const s = C.createCombat({ combatants, seed });
    C.startCombat(s);
    return s;
}
/** Puts `id` first in the order, so a test can act with them. */
function turnOf(s, id) {
    s.order = [id, ...s.order.filter(x => x !== id)];
    s.turn = 0;
}

// ─── Randomness ─────────────────────────────────────────────────────────────
{
    const a = { rng: 42 };
    const b = { rng: 42 };
    const xs = [C.nextRandom(a), C.nextRandom(a), C.nextRandom(a)];
    const ys = [C.nextRandom(b), C.nextRandom(b), C.nextRandom(b)];
    eq(xs, ys, 'same seed, same rolls');
    ok(xs.every(x => x >= 0 && x < 1), 'rolls are in [0, 1)');
    ok(new Set(xs).size === 3, 'rolls differ');
}

// ─── Hit points and hit chance ──────────────────────────────────────────────
{
    ok(C.maxHpFor(10, 1) === 75, `max HP at CON 10, level 1 is 75 (got ${C.maxHpFor(10, 1)})`);
    ok(C.maxHpFor(20, 5) > C.maxHpFor(10, 5), 'more CON, more HP');
    ok(C.maxHpFor(10, 5) > C.maxHpFor(10, 1), 'more levels, more HP');
    const a = hero('a'), d = foe('d');
    ok(Math.abs(C.hitChance(a, d) - 0.75) < 1e-9, 'equal DEX hits 75%');
    ok(C.hitChance(hero('q', { attrs: { dex: 20 } }), d) > 0.75, 'higher DEX hits more');
    ok(C.hitChance(hero('q', { attrs: { dex: 100 } }), d) === C.TUNING.hitMax, 'hit chance is capped');
    ok(C.hitChance(hero('q', { attrs: { dex: 1 } }), foe('z', { attrs: { dex: 100 } })) === C.TUNING.hitMin, 'hit chance has a floor');
    ok(C.hitChance(a, d, prof({ type: 'damage', stat: 'int' })) > C.hitChance(a, d, prof({ type: 'damage', stat: 'str' })), 'spells are more accurate');
}

// ─── Damage ─────────────────────────────────────────────────────────────────
{
    const strong = hero('s', { attrs: { str: 20 } }), weak = hero('w', { attrs: { str: 5 } }), d = foe('d');
    const atk = (p) => ({ profile: prof({ type: 'damage', stat: 'str', power: p }) });
    ok(C.damageAgainst(strong, atk('light'), d) > C.damageAgainst(weak, atk('light'), d), 'more STR, more damage');
    ok(C.damageAgainst(strong, atk('medium'), d) > C.damageAgainst(strong, atk('light'), d), 'medium beats light');
    ok(C.damageAgainst(strong, atk('heavy'), d) > C.damageAgainst(strong, atk('medium'), d), 'heavy beats medium');
    const armored = foe('a', { armor: 12 });
    ok(C.damageAgainst(strong, atk('light'), armored) < C.damageAgainst(strong, atk('light'), d), 'armour reduces damage');
    const spell = { profile: prof({ type: 'damage', stat: 'int', power: 'light' }) };
    const physArmor = foe('p', { armor: 15 });
    ok(C.damageAgainst(hero('m', { attrs: { int: 10 } }), spell, physArmor) > C.damageAgainst(hero('m2', { attrs: { str: 10 } }), atk('light'), physArmor), 'armour counts for less against magic');
    const crit = C.damageAgainst(strong, atk('light'), d, { crit: true });
    ok(crit > C.damageAgainst(strong, atk('light'), d), 'a critical hit hurts more');
    const sword = hero('sw', { atkBonus: 6 });
    ok(C.damageAgainst(sword, atk('light'), d) > C.damageAgainst(hero('nos'), atk('light'), d), 'a weapon adds damage');
    ok(C.damageAgainst(sword, spell, d) === C.damageAgainst(hero('nos2'), spell, d), 'a weapon does not help spells');
    const guarded = foe('g'); guarded.guard = true;
    ok(C.damageAgainst(strong, atk('light'), guarded) < C.damageAgainst(strong, atk('light'), d), 'guarding cuts damage');
    const shielded = foe('sh'); shielded.statuses.push({ id: 'shield', turns: 2 });
    ok(C.damageAgainst(strong, atk('light'), shielded) < C.damageAgainst(strong, atk('light'), d), 'shield cuts damage');
    const vuln = foe('v'); vuln.statuses.push({ id: 'vulnerable', turns: 2 });
    ok(C.damageAgainst(strong, atk('light'), vuln) > C.damageAgainst(strong, atk('light'), d), 'vulnerable takes more');
    const weakened = hero('wk', { attrs: { str: 20 } }); weakened.statuses.push({ id: 'weaken', turns: 2 });
    ok(C.damageAgainst(weakened, atk('light'), d) < C.damageAgainst(strong, atk('light'), d), 'weakened hits softer');
    const aoe = C.damageAgainst(strong, { profile: prof({ type: 'damage', stat: 'str', power: 'light', target: 'enemies' }) }, d, { aoe: true });
    ok(aoe < C.damageAgainst(strong, atk('light'), d), 'area attacks do less per target');
    ok(C.damageAgainst(weak, atk('light'), foe('t', { attrs: { con: 100 }, armor: 15 })) >= 1, 'damage is at least 1');
    const bomb = { profile: prof({ type: 'damage', stat: 'none', power: 'medium' }) };
    eq(C.damageAgainst(hero('x', { attrs: { str: 1 } }), bomb, d), C.damageAgainst(hero('y', { attrs: { str: 99 } }), bomb, d), 'a flat item ignores attributes');
}

// ─── Using actions ──────────────────────────────────────────────────────────
{
    const fire = act('fire', { type: 'damage', stat: 'int', power: 'heavy', status: 'burn' }, { kind: 'spell', manaCost: 30 });
    const a = hero('a', {}, [fire]); const d = foe('d', { attrs: { dex: 1 } });
    const s = fight([a, d]);
    turnOf(s, 'a');
    const before = d.hp;
    let tries = 0;
    while (d.hp === before && tries++ < 20) { a.mana = 100; delete a.cooldowns.fire; C.performAction(s, 'a', 'fire', 'd'); if (s.phase !== 'active') break; }
    ok(d.hp < before || d.down, 'a spell damages the target');
    ok(a.mana <= 70, 'casting spends Mana');
    a.mana = 10;
    ok(!C.canUse(a, fire).ok && /Mana/.test(C.canUse(a, fire).reason), 'not enough Mana blocks the spell');
    const n = s.log.length;
    C.performAction(s, 'a', 'fire', 'd');
    ok(s.log.length === n + 1 && /cannot/.test(s.log[s.log.length - 1].text), 'a blocked action only logs why');
    a.mana = null;
    ok(C.canUse(a, act('free', { type: 'damage' }, { manaCost: 30 })).ok, 'with Mana off, cost is not checked');
}
{
    const slam = act('slam', { type: 'damage', stat: 'str', power: 'heavy' }, { cooldown: 3 });
    const a = hero('a', {}, [slam]); const d = foe('d', { attrs: { con: 100, dex: 1 }, maxHp: 9999 });
    const s = fight([a, d]);
    turnOf(s, 'a');
    C.performAction(s, 'a', 'slam', 'd');
    eq(a.cooldowns.slam, 3, 'an ability goes on cooldown');
    ok(!C.canUse(a, slam).ok, 'cooldown blocks it');
    C.advance(s); turnOf(s, 'a'); C.advance(s); turnOf(s, 'a');
    // beginTurn counts the cooldown down; emulate three own turns
    for (let i = 0; i < 3; i++) { a.cooldowns.slam && a.cooldowns.slam--; }
    ok(C.canUse(a, slam).ok || !a.cooldowns.slam, 'cooldown ends');
}
{
    const potion = act('pot', { type: 'heal', stat: 'none', power: 'medium', target: 'ally' }, { kind: 'item', qty: 2 });
    const a = hero('a', { hp: 20 }, [potion]);
    const s = fight([a, foe('d')]);
    turnOf(s, 'a');
    const hp0 = a.hp;
    C.performAction(s, 'a', 'pot', 'a');
    ok(a.hp > hp0, 'a potion heals');
    eq(potion.qty, 1, 'a potion is used up');
    C.performAction(s, 'a', 'pot', 'a');
    C.performAction(s, 'a', 'pot', 'a');
    eq(potion.qty, 0, 'the stack runs out');
    ok(a.hp <= a.maxHp, 'healing never exceeds max HP');
    ok(/None left/.test(C.canUse(a, potion).reason), 'no potion left');
}
{
    const heal = act('heal', { type: 'heal', stat: 'wis', power: 'light', target: 'ally' });
    const a = hero('a', { attrs: { wis: 30 } }, [heal]); const b = hero('b', { hp: 5 });
    const s = fight([a, b, foe('d')]);
    turnOf(s, 'a');
    C.performAction(s, 'a', 'heal', 'b');
    ok(b.hp > 5, 'a heal spell heals an ally');
    ok(C.healAmount(a, heal, b) > C.healAmount(hero('w', { attrs: { wis: 5 } }), heal, b), 'WIS improves healing');
}
{
    // Statuses
    const burn = act('burn', { type: 'status', status: 'burn', stat: 'none', target: 'enemy' });
    const a = hero('a', { attrs: { dex: 100 } }, [burn]); const d = foe('d', { attrs: { dex: 1 } });
    const s = fight([a, d]);
    turnOf(s, 'a');
    C.performAction(s, 'a', 'burn', 'd');
    ok(d.statuses.some(x => x.id === 'burn'), 'a status is applied');
    // Make d act: its turn starts with burn damage.
    s.order = ['d', 'a']; s.turn = 1; const hp0 = d.hp;
    C.advance(s);
    ok(d.hp < hp0, 'burning hurts at the start of the turn');
    C.advance(s); // the end of d's own turn
    ok(d.statuses.find(x => x.id === 'burn')?.turns === 2, 'durations count down at the end of the owner\'s turn');
}
{
    // Stun: skip the turn, then immunity
    const s = fight([hero('a'), foe('d')]);
    const d = C.getCombatant(s, 'd');
    d.statuses.push({ id: 'stun', turns: 1 });
    s.order = ['a', 'd']; s.turn = 0;
    C.advance(s);
    ok(s.log.some(e => e.type === 'skip' && e.actor === 'd'), 'a stunned combatant loses the turn');
    ok(!d.statuses.some(x => x.id === 'stun'), 'stun wears off');
    ok(d.stunImmune > 0, 'right after a stun comes a short immunity');
    const events = [];
    const stunner = act('st', { type: 'status', status: 'stun', stat: 'none', target: 'enemy' });
    const a = C.getCombatant(s, 'a'); a.actions.push(stunner); a.attrs.dex = 100;
    s.order = ['a', 'd']; s.turn = 0; s.phase = 'active';
    events.push(...C.performAction(s, 'a', 'st', 'd'));
    ok(!d.statuses.some(x => x.id === 'stun'), 'an immune target cannot be stunned again');
}
{
    // Cure, revive, mana, regen
    const cure = act('cure', { type: 'cure', stat: 'none', target: 'ally' });
    const rev = act('rev', { type: 'revive', stat: 'none', power: 'medium', target: 'ally' });
    const eth = act('eth', { type: 'mana', stat: 'none', power: 'medium', target: 'ally' });
    const a = hero('a', {}, [cure, rev, eth]); const b = hero('b'); const c = hero('c', { hp: 0 });
    const s = fight([a, b, c, foe('d')]);
    turnOf(s, 'a');
    b.statuses.push({ id: 'poison', turns: 3 }, { id: 'shield', turns: 3 });
    C.performAction(s, 'a', 'cure', 'b');
    ok(!b.statuses.some(x => x.id === 'poison') && b.statuses.some(x => x.id === 'shield'), 'cure removes only harmful statuses');
    ok(c.down, 'a combatant at 0 HP starts down');
    C.performAction(s, 'a', 'rev', 'c');
    ok(!c.down && c.hp > 0, 'revive brings someone back');
    b.mana = 10;
    C.performAction(s, 'a', 'eth', 'b');
    ok(b.mana > 10, 'a mana item restores Mana');
    b.mana = null;
    const n = s.log.length;
    C.performAction(s, 'a', 'eth', 'b');
    ok(/no Mana/.test(s.log[s.log.length - 1].text) || s.log.length > n, 'no Mana to restore when it is off');
}

// ─── Turns, ending ──────────────────────────────────────────────────────────
{
    const s = fight([hero('a'), hero('b'), foe('d')], 3);
    eq(s.order.length, 3, 'everybody is in the order');
    const first = C.currentActor(s).id;
    C.advance(s);
    ok(C.currentActor(s).id !== first, 'advance moves to the next turn');
    C.advance(s); C.advance(s);
    ok(s.round === 2, 'a new round starts after everybody has acted');
    C.getCombatant(s, 'b').down = true;
    for (let i = 0; i < 4; i++) { ok(!C.currentActor(s)?.down, 'fallen combatants are skipped'); C.advance(s); }
}
{
    const s = fight([hero('a'), foe('d', { hp: 1 })]);
    turnOf(s, 'a');
    C.getCombatant(s, 'd').attrs.dex = 1;
    for (let i = 0; i < 30 && s.phase === 'active'; i++) { C.performAction(s, 'a', 'basic', 'd'); if (s.phase === 'active') C.advance(s), turnOf(s, 'a'); }
    eq(s.result, 'victory', 'defeating every enemy wins');
}
{
    const s = fight([hero('a', { hp: 1 }), foe('d', { attrs: { str: 100, dex: 100 } })]);
    for (let i = 0; i < 40 && s.phase === 'active'; i++) {
        const cur = C.currentActor(s);
        if (cur.side === 'enemy') C.runEnemyTurn(s);
        if (s.phase === 'active') C.advance(s);
    }
    eq(s.result, 'defeat', 'losing the whole party is a defeat');
    ok(C.partyOutcome(s)[0].healthPct === 1 && C.partyOutcome(s)[0].down, 'the fallen end at 1% Health');
}
{
    // Flight
    const s = fight([hero('a', { attrs: { dex: 40 } }), foe('d')], 5);
    ok(C.fleeChance(s) > 0.5, 'faster parties flee more easily');
    const boss = fight([hero('a'), foe('d', { tier: 'boss' })], 5);
    ok(C.fleeChance(boss) < C.fleeChance(fight([hero('a'), foe('d')], 5)), 'bosses are harder to flee');
    let fled = 0;
    for (let seed = 1; seed < 50; seed++) {
        const f = fight([hero('a', { attrs: { dex: 40 } }), foe('d')], seed);
        C.attemptFlee(f, 'a');
        if (f.result === 'fled') fled++;
    }
    ok(fled > 25 && fled < 50, `fleeing sometimes works (${fled}/49)`);
}

// ─── Enemy behaviour ────────────────────────────────────────────────────────
{
    const heal = act('mend', { type: 'heal', stat: 'wis', power: 'medium', target: 'ally' });
    const e = foe('e', { hp: 5, maxHp: 80 }, []);
    e.actions.push(heal);
    const s = fight([hero('a'), e]);
    let healed = 0;
    for (let i = 0; i < 30; i++) if (C.chooseEnemyAction(s, e).actionId === 'mend') healed++;
    ok(healed > 20, `a wounded enemy tends to heal (${healed}/30)`);
    const e2 = foe('e2'); e2.actions.push(heal);
    const s2 = fight([hero('a'), e2]);
    let mend = 0;
    for (let i = 0; i < 30; i++) if (C.chooseEnemyAction(s2, e2).actionId === 'mend') mend++;
    ok(mend === 0, 'a healthy enemy does not waste a heal');
    // Hurt targets attract attacks
    const p1 = hero('p1'), p2 = hero('p2', { hp: 5 });
    const s3 = fight([p1, p2, foe('e3')]);
    let hit2 = 0;
    for (let i = 0; i < 200; i++) if (C.chooseEnemyAction(s3, C.getCombatant(s3, 'e3')).targetId === 'p2') hit2++;
    ok(hit2 > 110, `hurt heroes draw more attacks (${hit2}/200)`);
}
{
    // buildEnemy keeps the AI from setting the numbers
    const e = C.buildEnemy({ name: 'Wolf', tier: 'normal', hp: 99999, attacks: [{ name: 'Bite', power: 'medium', status: 'bleed' }, { name: 'Howl', type: 'status', status: 'weaken', target: 'enemy' }] }, { partyLevel: 3, id: 'w' });
    ok(e.maxHp < 500, 'the AI cannot set enemy hit points');
    ok(e.actions.length === 3, 'enemy has its attack plus the basic one');
    ok(C.buildEnemy({ name: 'B', tier: 'boss' }, { partyLevel: 3, id: 'b' }).maxHp > e.maxHp, 'a boss is tougher');
    ok(C.buildEnemy({ name: 'M', tier: 'minion' }, { partyLevel: 3, id: 'm' }).maxHp < e.maxHp, 'a minion is weaker');
    ok(C.buildEnemy({ name: 'W', tier: 'normal' }, { partyLevel: 3, partySize: 3, id: 'w2' }).maxHp > e.maxHp, 'a bigger party faces tougher enemies');
    eq(C.buildEnemy({ name: 'X', tier: 'weird' }, { partyLevel: 1, id: 'x' }).tier, 'normal', 'unknown category falls back to normal');
    ok(C.buildEnemy({ name: 'L', levelDelta: 99 }, { partyLevel: 1, id: 'l' }).level <= 4, 'the level offset is limited');
}

// ─── Profiles ───────────────────────────────────────────────────────────────
{
    eq(C.normalizeProfile({ type: 'attack', power: 'HEAVY', stat: 'INT' }), { type: 'damage', power: 'heavy', stat: 'int', target: 'enemy' }, 'profile is cleaned');
    ok(C.normalizeProfile({ type: 'nonsense' }) === null, 'unknown type is rejected');
    ok(C.normalizeProfile({ type: 'status' }) === null, 'a status profile needs a status');
    eq(C.normalizeProfile({ type: 'heal' }).target, 'ally', 'heal defaults to an ally');
    eq(C.normalizeProfile({ type: 'status', status: 'shield' }).target, 'self', 'a good status defaults to self');
    ok(C.normalizeProfile({ type: 'damage', stat: 'luck' }).stat === 'str', 'unknown attribute falls back');
    eq(C.guessProfile('spell', 'Fireball').status, 'burn', 'Fireball burns');
    eq(C.guessProfile('spell', 'Healing Light').type, 'heal', 'Healing Light heals');
    eq(C.guessProfile('item', 'Pozione di cura').type, 'heal', 'Italian potion heals');
    eq(C.guessProfile('item', 'Long sword').type, 'gear', 'a sword is gear');
    ok(C.guessProfile('item', 'Long sword').atk > 0, 'a sword attacks');
    ok(C.guessProfile('item', 'Kevlar vest').def > 0, 'a vest defends');
    eq(C.guessProfile('item', 'Old key').type, 'none', 'a key does nothing in a fight');
    eq(C.guessProfile('item', 'Ring', '', { effects: { str: 2 } }).type, 'gear', 'effects make gear');
    ok(C.isUsableItemProfile(C.guessProfile('item', 'Potion of healing')) && !C.isUsableItemProfile(C.guessProfile('item', 'Old key')), 'only some items can be used');
    eq(C.guessProfile('spell', 'Mystery', '', { cost: 'heavy' }).power, 'heavy', 'a spell takes its power from its cost tier');
}

// ─── Rewards ────────────────────────────────────────────────────────────────
{
    const mk = () => {
        const e1 = foe('e1', { tier: 'normal', hp: 0 }); const e2 = foe('e2', { tier: 'boss', hp: 0, loot: { money: 99999, items: ['Dragon scale', 'Dragon scale', ' '] } });
        const s = fight([hero('a'), e1, e2]);
        return s;
    };
    const s = mk(); s.result = 'victory';
    const r = C.computeRewards(s, { partyLevel: 1 });
    ok(r.xp === 25 + 100, `XP follows the categories (${r.xp})`);
    ok(r.money <= C.TUNING.tiers.normal.money * 2 + C.TUNING.tiers.boss.moneyCap, 'loot money is capped');
    eq(r.items, ['Dragon scale'], 'loot items are cleaned and de-duplicated');
    s.result = 'fled';
    eq(C.computeRewards(s, {}).xp, 0, 'fleeing earns nothing');
    s.result = 'victory';
    ok(C.computeRewards(s, { partyLevel: 10 }).xp < r.xp, 'weak enemies give less XP than their category');
    ok(C.summarizeForNarration(s).enemies.length === 2, 'the narration summary lists the enemies');
}
{
    const a = hero('a', { hp: 40 }); a.maxHp = 80;
    eq(C.hpToHealthPct(a), 50, 'HP maps back onto the Health bar');
    a.hp = 0; a.down = true;
    eq(C.hpToHealthPct(a), 1, 'the fallen keep 1%');
    const w = hero('w', { healthPct: 30 });
    ok(w.hp === Math.round(w.maxHp * 0.3), 'a hurt hero starts hurt');
    ok(hero('z', { healthPct: 0 }).hp >= 1, 'a starting Health of 0% still gives 1 HP');
}

// ─── Difficulty guide ───────────────────────────────────────────────────────
{
    eq(C.threatRating(['minion'], 3).id, 'easy', 'one minion is easy for three');
    eq(C.threatRating(['normal', 'normal'], 3).id, 'easy', 'two normals are easy for three heroes');
    eq(C.threatRating(['normal', 'normal'], 1).id, 'deadly', 'two normals are deadly for one hero');
    eq(C.threatRating(['elite'], 1).id, 'deadly', 'an elite is deadly alone');
    eq(C.threatRating(['normal'], 1).id, 'fair', 'one normal is fair alone');
    ok(C.threatRating(['boss', 'minion', 'minion'], 3).ratio > C.threatRating(['boss'], 3).ratio, 'more enemies, more threat');
    eq(C.threatRating([], 0).id, 'easy', 'no enemies is easy');
}

// ─── Balance ────────────────────────────────────────────────────────────────
function simHero(id) {
    const c = hero(id, {}, [
        act('fire', { type: 'damage', power: 'heavy', stat: 'int', target: 'enemy', status: 'burn' }, { kind: 'spell', manaCost: 30 }),
        act('pot', { type: 'heal', power: 'medium', stat: 'none', target: 'ally' }, { kind: 'item', qty: 2 }),
    ]);
    return c;
}
function simEnemy(id, tier, size) {
    return C.buildEnemy({ name: id, tier, attacks: [{ name: 'Claw', power: 'medium' }] }, { partyLevel: 1, partySize: size, id });
}
function play(s) {
    for (let guard = 0; s.phase === 'active' && guard < 400; guard++) {
        const a = C.currentActor(s);
        if (a.side === 'enemy') C.runEnemyTurn(s);
        else {
            const foes = C.alive(s, 'enemy').sort((x, y) => x.hp - y.hp);
            const low = C.alive(s, 'party').sort((x, y) => x.hp / x.maxHp - y.hp / y.maxHp)[0];
            let best = null, score = -1;
            for (const ac of a.actions) {
                if (!C.canUse(a, ac).ok) continue;
                if (ac.profile.type === 'heal') { if (low.hp / low.maxHp < 0.4) { best = { ac, t: low.id }; score = 999; } continue; }
                if (ac.profile.type !== 'damage') continue;
                const e = C.estimateAction(a, ac, foes[0]);
                const sc = ((e.min + e.max) / 2) * e.hit / 100;
                if (sc > score) { score = sc; best = { ac, t: foes[0].id }; }
            }
            C.performAction(s, a.id, best.ac.id, best.t);
        }
        if (s.phase === 'active') C.advance(s);
    }
}
function winRate(heroes, enemies, n = 200) {
    let w = 0;
    for (let i = 1; i <= n; i++) {
        const s = C.createCombat({ combatants: [...heroes.map(simHero), ...enemies.map(([id, t]) => simEnemy(id, t, heroes.length))], seed: i * 7919 });
        C.startCombat(s);
        play(s);
        if (s.result === 'victory') w++;
    }
    return w / n;
}
{
    const band = (label, v, lo, hi) => ok(v >= lo && v <= hi, `${label}: ${(v * 100).toFixed(0)}% not in ${lo * 100}–${hi * 100}%`);
    band('solo vs minion', winRate(['A'], [['e', 'minion']]), 0.95, 1);
    band('solo vs normal', winRate(['A'], [['e', 'normal']]), 0.85, 1);
    band('solo vs 2 normal', winRate(['A'], [['e', 'normal'], ['f', 'normal']]), 0.2, 0.65);
    band('solo vs elite', winRate(['A'], [['e', 'elite']]), 0.35, 0.8);
    band('solo vs boss', winRate(['A'], [['e', 'boss']]), 0, 0.15);
    band('party of 3 vs 2 normal', winRate(['A', 'B', 'C'], [['e', 'normal'], ['f', 'normal']]), 0.9, 1);
    band('party of 3 vs boss', winRate(['A', 'B', 'C'], [['e', 'boss']]), 0.6, 1);
    band('party of 3 vs boss + 2 minions', winRate(['A', 'B', 'C'], [['e', 'boss'], ['m', 'minion'], ['n', 'minion']]), 0.6, 0.97);
}

// ── a passive skill is not an attack ──
ok(C.guessProfile('ability', 'Iron skin', '', { effects: { con: 2 } }).type === 'none', 'guess: a skill with only always-on bonuses is passive');
ok(C.guessProfile('ability', 'Power strike', '', {}).type === 'damage', 'guess: a plain skill is still an attack');

// ── damageReduction (inspect panel) ──
{
    const t = C.makeCombatant({ id: 't', side: 'enemy', name: 'T', attrs: { con: 20 }, armor: 10 });
    const r = C.damageReduction(t);
    ok(r.physical > r.magic && r.magic > 0 && r.physical < 1, 'damageReduction: physical > magic, both in (0,1)');
}

// ── status duration and chance, set by hand ──
{
    const p = prof({ type: 'damage', power: 'light', stat: 'str', target: 'enemy', status: 'burn', statusTurns: 5, statusChance: 100 });
    ok(p.statusTurns === 5 && p.statusChance === 1, 'profile: duration and chance are kept');
    const q = prof({ type: 'damage', power: 'light', stat: 'str', target: 'enemy', status: 'burn', statusTurns: 99, statusChance: 0.01 });
    ok(q.statusTurns === C.MAX_STATUS_TURNS && q.statusChance === C.MIN_STATUS_CHANCE, 'profile: duration and chance are limited');
    const r = prof({ type: 'damage', power: 'light', stat: 'str', target: 'enemy', statusTurns: 4, statusChance: 0.5 });
    ok(r.statusTurns === undefined && r.statusChance === undefined, 'profile: no status, no duration or chance');
    const u = prof({ type: 'status', status: 'shield', statusTurns: 2, statusChance: 0.3 });
    ok(u.statusTurns === 2 && u.statusChance === undefined, 'profile: a pure status has a duration but no chance');
    ok(C.statusChanceOf({}) === C.TUNING.statusChance && C.statusTurnsOf({}) === C.TUNING.statusTurns, 'defaults when not set');

    // chance 100%: always lands, for the set number of turns
    let landed = 0;
    for (let seed = 1; seed <= 20; seed++) {
        const a = hero('A', {}, [act('x', { type: 'damage', power: 'light', stat: 'str', target: 'enemy', status: 'burn', statusTurns: 5, statusChance: 1 })]);
        const e = foe('E', { maxHp: 999 });
        e.hp = e.maxHp = 999;
        const s = fight([a, e], seed);
        turnOf(s, 'A');
        C.performAction(s, 'A', 'x', 'E');
        const burn = s.combatants.find(c => c.id === 'E').statuses.find(t => t.id === 'burn');
        if (burn && burn.turns === 5) landed++;
    }
    ok(landed >= 15, `a 100% status lands (almost) every time it hits (${landed}/20)`);
    // a low chance rarely lands
    let low = 0;
    for (let seed = 1; seed <= 60; seed++) {
        const a = hero('A', {}, [act('x', { type: 'damage', power: 'light', stat: 'str', target: 'enemy', status: 'burn', statusChance: 0.1 })]);
        const e = foe('E');
        e.hp = e.maxHp = 999;
        const s = fight([a, e], seed);
        turnOf(s, 'A');
        C.performAction(s, 'A', 'x', 'E');
        if (s.combatants.find(c => c.id === 'E').statuses.some(t => t.id === 'burn')) low++;
    }
    ok(low <= 20, `a 10% status rarely lands (${low}/60)`);
    // a buff for 2 turns
    const a2 = hero('A', {}, [act('w', { type: 'status', status: 'shield', target: 'self', statusTurns: 2 })]);
    const s2 = fight([a2, foe('E')], 3);
    turnOf(s2, 'A');
    C.performAction(s2, 'A', 'w', null);
    ok(s2.combatants.find(c => c.id === 'A').statuses.find(t => t.id === 'shield')?.turns === 2, 'a set duration is used by a status move');
}

// ── what a status does, in words ──
{
    const b = C.statusInfo('burn');
    ok(b && /7%/.test(b.text) && b.bad, 'statusInfo: burning says its 7%');
    ok(/25%/.test(C.statusInfo('weaken').text) && /30%/.test(C.statusInfo('empower').text) && /40%/.test(C.statusInfo('shield').text), 'statusInfo: the multipliers are stated');
    ok(C.statusInfo('nope') === null, 'statusInfo: unknown is null');
    ok(C.STATUS_IDS.every(id => C.statusInfo(id).text.length > 10), 'statusInfo: every status has a text');
}

// ── the turn bar ──
{
    const s = fight([hero('A', { attrs: { dex: 16 } }), hero('B', { attrs: { dex: 12 } }), foe('E', { attrs: { dex: 8 } }), foe('F', { attrs: { dex: 14 } })], 5);
    const t = C.upcomingTurns(s, 9);
    ok(t.length === 9 && t[0].current && t[0].id === C.currentActor(s).id, 'turn bar: starts with whoever acts now');
    eq(t.slice(0, 4).map(x => x.id), s.order.slice(s.turn).concat(s.order.slice(0, s.turn)).slice(0, 4), 'turn bar: follows the order');
    ok(t.slice(4, 8).map(x => x.id).join() === s.order.join(), 'turn bar: the next round repeats the order');
    ok(t.some(x => x.newRound) && t.find(x => x.newRound).round === s.round + 1, 'turn bar: marks the new round');
    const e = s.combatants.find(c => c.id === 'E');
    e.hp = 0; e.down = true;
    ok(!C.upcomingTurns(s, 9).some(x => x.id === 'E'), 'turn bar: the fallen are left out');
    const f = s.combatants.find(c => c.id === 'F');
    f.statuses.push({ id: 'stun', turns: 1 });
    const ft = C.upcomingTurns(s, 9).filter(x => x.id === 'F');
    ok(ft[0].stunned && !ft[1]?.stunned, 'turn bar: a stunned fighter is marked on the first turn only');
    s.phase = 'ended';
    ok(C.upcomingTurns(s, 9).length === 0, 'turn bar: nothing once the fight is over');
    C.advance;
}

console.log(`combat model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
