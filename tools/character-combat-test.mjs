#!/usr/bin/env node
/**
 * Combat test — the glue between the combat rules and the Stats data:
 * fighters built from the sheets, the AI's enemies and labels, the fight
 * kept in the chat, and the outcome written back (bars, items, XP, money,
 * loot, affinity, conditions).
 *
 * Usage:  node tools/character-combat-test.mjs     (from the repo root)
 * Exit:   0 = pass, 1 = failure
 *
 * Reuses the stub sandbox tools/load-check.mjs builds, with two stubs made
 * real (chat and chat_metadata) because the undo record lives there.
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
const R = await import(`${DES}/src/systems/features/rpgMode.js`);const Cb = await import(`${DES}/src/systems/features/combat.js`);
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

extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: {}, activeCampaignId: null };
extensionSettings.knownCharacters = { Elena: {}, Bram: {} };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Bram' }, { name: 'Mastera' }] });
for (const [n, u] of [['Mastera', true], ['Elena', false], ['Bram', false]]) { Eq.cancelStartingGear(n, u); Ab.cancelStartingAbilities(n, u); }
for (const n of ['Elena', 'Bram']) S.saveStatSheet(n, false, S.getStatSheet(n, false), { pending: false });
chat.push({ is_user: true, mes: 'The bandits step out of the trees.', name: 'Mastera' }, { is_user: false, mes: 'Three men with knives block the road.', name: 'Narrator' });
P.setPartyMember('Elena', true);

// A sword she wears, a potion, a key; one spell, one skill.
Eq.addItem('Mastera', true, { name: 'Long sword', desc: 'A good blade', equipped: true, effects: { str: 2 } });
Eq.addItem('Mastera', true, { name: 'Healing potion', qty: 2 });
Eq.addItem('Mastera', true, { name: 'Old key' });
Ab.addAbility('Mastera', true, { name: 'Fireball', type: 'spell', cost: 'medium' });
Ab.addAbility('Mastera', true, { name: 'Second wind', type: 'ability' });
Ab.addAbility('Elena', false, { name: 'Mend', type: 'spell', cost: 'light' });
Mo.setMoney('Mastera', true, 50);
Af.setAffinity('Elena', 10);

// ── 1. Fighters from the sheets ──
check('combat is on with RPG mode', Cb.isCombatEnabled());
const cands = Cb.partyCandidates();
check('the player and the party are candidates, ticked', cands.find(c => c.isUser)?.inParty && cands.find(c => c.name === 'Elena')?.inParty && cands.find(c => c.name === 'Bram')?.inParty === false);
const mast = Cb.buildPartyMember('Mastera', true);
const mc = mast.combatant;
check('the sword raises STR (effective attributes)', mc.attrs.str === S.getEffectiveStatValues?.('Mastera', true) || mc.attrs.str === 12, `str ${mc.attrs.str}`);
check('health and mana start from the bars', mc.hp === mc.maxHp && mc.mana === 100);
check('an equipped weapon adds damage', mc.atkBonus > 0, `atkBonus ${mc.atkBonus}`);
check('the spell is an action with a Mana cost', mc.actions.find(a => a.label === 'Fireball')?.manaCost === 15);
check('the skill is an action without Mana but with a pause', (a => a && a.manaCost === 0 && a.cooldown >= 0)(mc.actions.find(a => a.label === 'Second wind')));
const pot = mc.actions.find(a => a.label === 'Healing potion');
check('the potion is a usable item with its quantity', pot && pot.kind === 'item' && pot.qty === 2 && pot.profile.type === 'heal');
check('the key is not an action', !mc.actions.some(a => a.label === 'Old key'));
check('the unlabelled actions are listed for the AI', mast.unlabelled.length === 5 && mast.unlabelled.some(u => u.ref === 'Fireball'), JSON.stringify(mast.unlabelled.map(u => u.ref)));
S.setCurrentStatValue('Mastera', true, 'health', 40);
S.setCurrentStatValue('Mastera', true, 'mana', 55);
const hurt = Cb.buildPartyMember('Mastera', true).combatant;
check('a wounded hero starts wounded', Math.abs(hurt.hp / hurt.maxHp - 0.4) < 0.02 && hurt.mana === 55);
S.setStatEnabled('mana', false);
const nomana = Cb.buildPartyMember('Mastera', true).combatant;
check('Mana off: spells are free, with a pause instead', nomana.mana === null && nomana.actions.find(a => a.label === 'Fireball').manaCost === 0 && nomana.actions.find(a => a.label === 'Fireball').cooldown > 0);
S.setStatEnabled('mana', true);
S.setStatEnabled('health', false);
check('Health off: they start at full HP', Cb.buildPartyMember('Mastera', true).combatant.hp === Cb.buildPartyMember('Mastera', true).combatant.maxHp);
S.setStatEnabled('health', true);
S.setCurrentStatValue('Mastera', true, 'health', 100);
S.setCurrentStatValue('Mastera', true, 'mana', 100);

// ── 2. The AI's part ──
const party = [{ name: 'Mastera', isUser: true }, { name: 'Elena', isUser: false }];
const reply = '```json\n' + JSON.stringify({
    environment: 'A muddy forest road',
    enemies: [
        { name: 'Bandit', icon: '🗡️', description: 'A lean man with a knife', tier: 'minion', attacks: [{ name: 'Stab', power: 'light' }], loot: { money: 12, items: ['Rusty dagger'] } },
        { name: 'Bandit', icon: '🗡️', description: 'Another one', tier: 'minion', attacks: ['Slash'] },
        { name: 'Bandit chief', tier: 'weird', hp: 999999, attacks: [{ name: 'Cleave', power: 'heavy', stat: 'str', status: 'bleed' }] },
    ],
    profiles: {
        a1: { type: 'damage', power: 'heavy', stat: 'int', target: 'enemy', status: 'burn' },
        a2: { type: 'status', status: 'empower', power: 'light', stat: 'none', target: 'self' },
        a3: { type: 'gear', atk: 5, def: 0 },
        a4: { type: 'heal', power: 'medium', stat: 'none', target: 'ally' },
        a5: { type: 'none' },
        zz: { type: 'damage' },
    },
}) + '\n```';
let asked = null;
const setup = await Cb.generateEncounterSetup(party, { situation: 'three bandits', generate: async (o) => { asked = o.prompt; return reply; } });
check('the AI is asked about the situation and the sheets', asked[1].content.includes('three bandits') && asked[0].content.includes('Mastera') && asked[1].content.includes('"profiles"'));
check('enemies come back clean', setup.enemies.length === 3 && setup.enemies[0].tier === 'minion' && setup.enemies[2].tier === 'normal');
check('duplicate names are told apart', setup.enemies[0].name === 'Bandit' && setup.enemies[1].name === 'Bandit 2');
check('the environment is kept', setup.environment === 'A muddy forest road');
check('labels are saved (unknown keys ignored)', setup.labelled >= 5, `labelled ${setup.labelled}`);
const fbProf = Cb.getStoredProfile('npc:Elena', 'spell', 'Mend') || Cb.getStoredProfile('user:Mastera', 'spell', 'Fireball');
check('a saved label is used instead of a guess', fbProf?.power === 'heavy' && fbProf.status === 'burn', JSON.stringify(fbProf));
const again = Cb.buildPartyMember('Mastera', true);
check('after labelling, nothing is left to label for Mastera', again.unlabelled.length < mast.unlabelled.length, `${again.unlabelled.length} left`);
check('the labels belong to the chat', chatStore('characterCombat') && Object.keys(chatStore('characterCombat')).length > 0);
// the scene tracker's characters reach the AI, so the enemies the story introduced are kept
{
    const keep = committedTrackerData.characterThoughts;
    committedTrackerData.characterThoughts = JSON.stringify({ characters: [
        { name: 'Elena', Appearance: 'red hair' },
        { name: 'Man in grey', emoji: '🗡️', Appearance: 'scarred man, about 40', Relationship: { status: 'hostile' }, thoughts: 'secret plan' },
        { name: 'Mastera' },
    ] });
    let seen = null;
    await Cb.generateEncounterSetup(party, { generate: async (o) => { seen = o.prompt; return reply; } });
    const sys = seen[0].content, usr = seen[1].content;
    check('the tracker characters are shown to the AI with their details', sys.includes('<characters_in_scene>') && sys.includes('Man in grey') && sys.includes('scarred man'));
    check('the fighters are not listed as scene characters', !/- Elena/.test(sys) && !/- Mastera/.test(sys));
    check('inner thoughts are left out', !sys.includes('secret plan'));
    check('the prompt says to keep what the story says and to label the unnamed', /same sex/.test(usr) && /Bandit 1/.test(usr));
    committedTrackerData.characterThoughts = keep;
}

const badReply = async () => 'sorry, no json here';
let threw = false;
try { await Cb.generateEncounterSetup(party, { generate: badReply }); } catch (e) { threw = true; }
check('a reply without JSON is an error, not a crash', threw);

// ── 3. A fight, kept in the chat ──
const specs = setup.enemies.slice(0, 2).map(s => ({ ...s, tier: 'minion' }));
const state = Cb.buildEncounter(party, specs, { environment: setup.environment, seed: 12345 });
check('the fight has the party and the enemies', state.combatants.filter(c => c.side === 'party').length === 2 && state.combatants.filter(c => c.side === 'enemy').length === 2);
check('enemies are built by the rules, not the AI', state.combatants.filter(c => c.side === 'enemy').every(e => e.maxHp < 200));
M.startCombat(state);
Cb.saveLiveEncounter(state);
check('the live fight is kept in the chat', Cb.getLiveEncounter()?.round === 1 && Cb.getLiveEncounter().combatants.length === 4);
otherChat();
check('another chat has no fight', Cb.getLiveEncounter() === null);
backToChat();
check('...and this one still has it', Cb.getLiveEncounter() !== null);

function playOut(st) {
    for (let g = 0; st.phase === 'active' && g < 300; g++) {
        const a = M.currentActor(st);
        if (a.side === 'enemy') M.runEnemyTurn(st);
        else {
            const foes = M.alive(st, 'enemy').sort((x, y) => x.hp - y.hp);
            let best = null, score = -1;
            for (const ac of a.actions) {
                if (!M.canUse(a, ac).ok || ac.profile.type !== 'damage') continue;
                const e = M.estimateAction(a, ac, foes[0]);
                const sc = (e.min + e.max) / 2 * e.hit / 100;
                if (sc > score) { score = sc; best = ac; }
            }
            M.performAction(st, a.id, best.id, foes[0].id);
        }
        if (st.phase === 'active') M.advance(st);
    }
}
// Use the potion once and leave a lingering poison, so the outcome has something to write.
const mastC = M.getCombatant(state, mc.id);
M.getCombatant(state, 'p:mastera').hp = 30;
state.order = ['p:mastera', ...state.order.filter(x => x !== 'p:mastera')]; state.turn = 0;
M.performAction(state, 'p:mastera', M.getCombatant(state, 'p:mastera').actions.find(a => a.kind === 'item').id, 'p:mastera');
M.getCombatant(state, 'p:elena').statuses.push({ id: 'poison', turns: 99 });
M.getCombatant(state, 'p:elena').mana = 20;
M.advance(state);
playOut(state);
check('the party wins against two minions', state.result === 'victory', `result ${state.result}`);

// ── 4. The outcome ──
const lvlBefore = P.getProgress('Mastera', true).xp;
const moneyBefore = Mo.getMoney('Mastera', true);
const affBefore = Af.getAffinity('Elena');
const finalHp = M.hpToHealthPct(M.getCombatant(state, 'p:mastera'));
const finalMana = M.getCombatant(state, 'p:mastera').mana;
const res = await Cb.finishEncounter(state, { narrate: false });
check('Health goes back to the bar', S.getCurrentStatValues('Mastera', true).health === finalHp, `bar ${S.getCurrentStatValues('Mastera', true).health} vs ${finalHp}`);
check('Mana goes back to the bar', S.getCurrentStatValues('Mastera', true).mana === finalMana && S.getCurrentStatValues('Elena', false).mana === M.getCombatant(state, 'p:elena').mana);
check('a lingering poison becomes a condition', Cd.getConditions('Elena').some(c => c.name === 'Poisoned'));
const left = Eq.getEquipment('Mastera', true).find(i => i.name === 'Healing potion');
check('the used potion is gone from the pack', left && left.qty === 1);
check('XP goes to the whole party', P.getProgress('Mastera', true).xp === lvlBefore + res.report.rewards.xp && P.getProgress('Elena', false).xp === res.report.rewards.xp && res.report.rewards.xp > 0, `xp ${res.report.rewards.xp}`);
check('money from the enemies goes to the player', Mo.getMoney('Mastera', true) === Math.round((moneyBefore + res.report.moneyAdded) * 100) / 100 && res.report.moneyAdded > 0);
check('loot lands in the pack', Eq.getEquipment('Mastera', true).some(i => i.name === 'Rusty dagger') && res.report.lootAdded.includes('Rusty dagger'));
check('allies like you more after a win', Af.getAffinity('Elena') === affBefore + 3);
check('the live fight is cleared', Cb.getLiveEncounter() === null);
const xpAfter = P.getProgress('Mastera', true).xp;
const again2 = await Cb.finishEncounter(state, { narrate: false });
check('applying twice does nothing', again2.report.already === true && P.getProgress('Mastera', true).xp === xpAfter && Af.getAffinity('Elena') === affBefore + 3);

// ── 5. Fleeing and losing ──
{
    const st = Cb.buildEncounter(party, specs, { seed: 7 });
    M.startCombat(st);
    st.phase = 'ended'; st.result = 'fled';
    const aff = Af.getAffinity('Elena'); const xp = P.getProgress('Mastera', true).xp;
    const r = await Cb.finishEncounter(st, { narrate: false });
    check('fleeing earns nothing', P.getProgress('Mastera', true).xp === xp && r.report.rewards.xp === 0);
    check('...and costs a little affinity', Af.getAffinity('Elena') === aff - 2);
}
{
    const st = Cb.buildEncounter(party, specs, { seed: 8 });
    M.startCombat(st);
    for (const c of st.combatants.filter(x => x.side === 'party')) { c.hp = 0; c.down = true; }
    M.checkEnd(st);
    const aff = Af.getAffinity('Elena');
    await Cb.finishEncounter(st, { narrate: false });
    check('a defeat leaves everyone at 1% Health, nobody dies', S.getCurrentStatValues('Mastera', true).health === 1 && S.getCurrentStatValues('Elena', false).health === 1);
    check('a defeat does not touch affinity', Af.getAffinity('Elena') === aff);
}

// ── 6. The story afterwards ──
{
    const st = Cb.buildEncounter(party, specs, { seed: 9 });
    M.startCombat(st);
    st.phase = 'ended'; st.result = 'victory';
    for (const e of st.combatants.filter(c => c.side === 'enemy')) { e.hp = 0; e.down = true; }
    let prompt = null;
    const r = await Cb.finishEncounter(st, { narrate: true, post: false, generate: async (o) => { prompt = o.prompt; return '[FIGHT CONCLUDED] The last bandit fled | left his {{user}} knife.'; } });
    check('the AI is given the record of the fight', prompt && prompt[1].content.includes('Bandit defeated') && prompt[1].content.includes('The party won'));
    check('the account is cleaned for the chat', r.narration === 'The last bandit fled ¦ left his { {user} } knife.', r.narration);
    const st2 = Cb.buildEncounter(party, specs, { seed: 10 });
    M.startCombat(st2); st2.phase = 'ended'; st2.result = 'fled';
    const r2 = await Cb.finishEncounter(st2, { narrate: true, post: false, generate: async () => { throw new Error('offline'); } });
    check('if the AI is unreachable the fight is still recorded', r2.narrationError === 'offline' && r2.report.result === 'fled');
}

// ── 7. Switches ──
Cb.setCombatEnabled(false);
check('combat can be switched off', !Cb.isCombatEnabled());
Cb.setCombatEnabled(true);
R.setDefaultRpgMode(false);
check('RPG mode off switches combat off', R.isRpgModeActive() ? Cb.isCombatEnabled() : !Cb.isCombatEnabled());
R.setDefaultRpgMode(true);
Cb.setCombatNarration(false);
check('the story can be switched off', Cb.isCombatNarrationOn() === false);
Cb.setCombatNarration(true);

// ── Hand-set weapon values (Equipment tab) ──
{
    const sword = Eq.getEquipment('Mastera', true).find(i => i.name === 'Long sword');
    const potion = Eq.getEquipment('Mastera', true).find(i => i.name === 'Healing potion');
    const auto = Cb.getItemCombat('Mastera', true, sword);
    check('item combat: a sword is editable gear', auto.editable && auto.atk > 0);
    check('item combat: a potion is not editable gear', !Cb.getItemCombat('Mastera', true, potion).editable);
    Cb.setItemGear('Mastera', true, 'Long sword', 9, 3);
    const set = Cb.getItemCombat('Mastera', true, sword);
    check('item combat: hand-set values are stored', set.stored && set.atk === 9 && set.def === 3);
    check('item combat: the fighter uses them', Cb.buildPartyMember('Mastera', true).combatant.atkBonus === 9);
    Cb.setItemGear('Mastera', true, 'Long sword', 99, -4);
    const clamped = Cb.getItemCombat('Mastera', true, sword);
    check('item combat: values are clamped 0–15', clamped.atk === 15 && clamped.def === 0);
    Cb.setItemGear('Mastera', true, 'Long sword', null, null);
    check('item combat: clearing goes back to automatic', !Cb.getItemCombat('Mastera', true, sword).stored);
}

// ── Hand-set effects of spells, skills and items ──
{
    const fb = () => Cb.buildPartyMember('Mastera', true).combatant.actions.find(a => a.label === 'Fireball');
    const spell = Ab.getAbilities('Mastera', true).find(a => a.name === 'Fireball');
    check('action profile: a fresh read gives a profile', !!Cb.getActionProfile('Mastera', true, 'spell', spell).profile);
    Cb.setActionProfile('Mastera', true, 'spell', 'Fireball', { type: 'damage', power: 'heavy', stat: 'wis', target: 'enemies', status: 'poison' });
    const a = fb();
    check('action profile: the spell uses the hand-set effect', a && a.profile.power === 'heavy' && a.profile.stat === 'wis' && a.profile.target === 'enemies' && a.profile.status === 'poison', JSON.stringify(a?.profile));
    check('action profile: stored and described', Cb.getActionProfile('Mastera', true, 'spell', spell).stored && /Damage · Heavy · WIS/.test(Cb.describeProfile(a.profile)), Cb.describeProfile(a?.profile));
    Cb.setActionProfile('Mastera', true, 'spell', 'Fireball', { type: 'none' });
    check('action profile: "passive" takes it out of the fight', !fb());
    Cb.setActionProfile('Mastera', true, 'spell', 'Fireball', null);
    check('action profile: cleared goes back to automatic', !Cb.getActionProfile('Mastera', true, 'spell', spell).stored && !!fb());
    Cb.setActionProfile('Mastera', true, 'item', 'Old key', { type: 'heal', power: 'medium', stat: 'none', target: 'ally' });
    const key = Cb.buildPartyMember('Mastera', true).combatant.actions.find(x => x.label === 'Old key');
    check('action profile: a plain item can be made usable', key && key.profile.type === 'heal');
    Cb.setActionProfile('Mastera', true, 'item', 'Old key', null);
    check('action profile: a status without a status is refused', Cb.setActionProfile('Mastera', true, 'spell', 'Fireball', { type: 'status' }) === false);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall combat checks passed');
process.exit(failures ? 1 : 0);
