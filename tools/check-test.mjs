#!/usr/bin/env node
/**
 * Checks test — the dice rules, the checks of a character in a chat, the AI's
 * request, and what reaches the prompt.
 *
 * Usage:  node tools/check-test.mjs     (from the repo root)
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
const R = await import(`${DES}/src/systems/features/rpgMode.js`);const Ck = await import(`${DES}/src/systems/features/characterChecks.js`);
const K = await import(`${DES}/src/utils/checkModel.js`);
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


// ── 1. The dice rules (pure) ──
check('modifier: 10 is 0, 14 is +2, 20 is +5, 8 is -1', K.attributeModifier(10) === 0 && K.attributeModifier(14) === 2 && K.attributeModifier(20) === 5 && K.attributeModifier(8) === -1);
check('difficulty by name, label, number and junk', K.resolveDifficulty('hard').dc === 16 && K.resolveDifficulty('Very hard').id === 'extreme' && K.resolveDifficulty(12).id === 'medium' && K.resolveDifficulty(14).dc === 14 && K.resolveDifficulty('???').id === 'medium');
check('difficulty numbers are clamped', K.resolveDifficulty(99).dc === 30 && K.resolveDifficulty(1).dc === 4);
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
// rng returns [0,1): face = floor(r*20)+1
const r1 = K.rollCheck({ value: 14, dc: 16, rng: seq(0.55) });   // face 12, +2 = 14 vs 16
check('a roll adds the modifier and fails by the margin', r1.die === 12 && r1.total === 14 && r1.margin === -2 && !r1.success && r1.degree === 'failure');
const r2 = K.rollCheck({ value: 10, dc: 30, rng: seq(0.99) });   // face 20
check('a natural 20 always succeeds', r2.die === 20 && r2.success && r2.degree === 'critical-success');
const r3 = K.rollCheck({ value: 40, dc: 4, rng: seq(0) });       // face 1
check('a natural 1 always fails', r3.die === 1 && !r3.success && r3.degree === 'critical-failure');
check('the bonus counts and is limited', K.rollCheck({ value: 10, bonus: 3, dc: 12, rng: seq(0.45) }).total === 13 && K.rollCheck({ value: 10, bonus: 99, dc: 12, rng: seq(0.45) }).bonus === 10);
check('chance: modifier 0 vs 12 is 45%, vs 20 is 5%, never 0 or 100', K.successChance(0, 12) === 0.45 && K.successChance(0, 20) === 0.05 && K.successChance(-20, 30) === 0.05 && K.successChance(30, 4) === 0.95);
let dist = 0;
for (let i = 0; i < 4000; i++) if (K.rollCheck({ value: 10, dc: 12 }).success) dist++;
check('real dice: about 45% for a plain character at medium', Math.abs(dist / 4000 - 0.45) < 0.04, String(dist / 4000));
check('the request is read from objects, strings and aliases', K.normalizeCheckRequest({ stat: 'dex', difficulty: 'hard', reason: 'jump' })?.dc === 16
    && K.normalizeCheckRequest(JSON.stringify({ attribute: 'STR', dc: 14, character: 'Elena' }))?.who === 'Elena'
    && K.normalizeCheckRequest('nonsense') === null && K.normalizeCheckRequest({ difficulty: 'easy' }) === null);
const line = K.describeResult({ name: 'Mastera', statLabel: 'DEX', difficultyLabel: 'hard', ...r1, reason: 'jump the gap' });
check('the fact line says who, what, the numbers and the outcome', /Mastera, DEX check \(hard\): rolled 12 \+2 = 14 against 16 — FAILURE by 2 \(jump the gap\)\./.test(line), line);
check('the AI prompt names the attributes and the outcome', /"stat": "str\|dex"/.test(K.buildChecksPrompt({ player: 'P', statIds: ['str', 'dex'], note: 'X' })) && /LAST CHECK/.test(K.buildChecksPrompt({ player: 'P', statIds: ['str'], note: 'X' })));
check('nothing to say, nothing sent', K.buildChecksPrompt({ player: 'P', statIds: [], note: '' }) === '');

// ── 2. Rolling for a character, in the chat ──
check('checks are on with RPG mode', Ck.isChecksEnabled());
const attrs = Ck.getCheckAttributes('Mastera', true);
check('the attributes come with value and modifier', attrs.length >= 4 && attrs.every(a => Number.isFinite(a.value)) && attrs.find(a => a.id === 'str') && attrs.find(a => a.id === 'str').modifier === K.attributeModifier(attrs.find(a => a.id === 'str').value));
const before = Ck.getCheckAttributes('Mastera', true).find(a => a.id === 'str').value;
Eq.addItem('Mastera', true, { name: 'Gauntlets', equipped: true, effects: { str: 4 } });
check('equipment raises the roll', Ck.getCheckAttributes('Mastera', true).find(a => a.id === 'str').value === before + 4);
const roll = Ck.rollCheckFor('Mastera', true, { stat: 'str', difficulty: 'hard', reason: 'force the door', rng: seq(0.7) });
check('a roll is recorded with its numbers', roll && roll.die === 15 && roll.dc === 16 && roll.statLabel && roll.reason === 'force the door' && roll.consumedAt === null, JSON.stringify(roll));
check('an unknown attribute rolls nothing', Ck.rollCheckFor('Mastera', true, { stat: 'luck' }) === null);
check('the attribute can be named by its abbreviation or name', !!Ck.rollCheckFor('Mastera', true, { stat: 'STR', rng: seq(0.5) }) && !!Ck.rollCheckFor('Mastera', true, { stat: 'Strength', rng: seq(0.5) }));
check('recent rolls are listed newest first', Ck.getRecentChecks(2).length === 2);
check('the chance is offered', Ck.checkChance('Mastera', true, 'str', 16, 0) > 0 && Ck.checkChance('Mastera', true, 'nope', 16) === null);

// ── 3. What reaches the prompt ──
chat.length = 0;
chat.push({ is_user: true, mes: 'I try the door', name: 'Mastera' });
Ck.rollCheckFor('Mastera', true, { stat: 'dex', difficulty: 'medium', reason: 'pick the lock', rng: seq(0.1) });   // afterIndex 0
const p1 = Ck.buildChecksPromptForGeneration({ compact: true });
check('the outcome is in the prompt, with the request instructions', /LAST CHECK/.test(p1) && /pick the lock/.test(p1) && /"check":/.test(p1), p1);
check('and in the context of the roleplay reply', /Check outcome/.test(Ck.buildChecksContextSummary()));
chat.push({ is_user: true, mes: 'I push on', name: 'Mastera' });
check('still there after the player writes', /LAST CHECK/.test(Ck.buildChecksPromptForGeneration({ compact: true })));
chat.push({ is_user: false, mes: 'The lock clicks...', name: 'Narrator' });
Ck.settleChecks(null, chat.length - 1);
check('once the AI has answered it, it is gone', !/LAST CHECK/.test(Ck.buildChecksPromptForGeneration({ compact: true })) && Ck.buildChecksContextSummary() === '');
Ck.revertAIChecksForReplacedMessage(chat.length - 1);
check('a swipe of that reply brings it back', /LAST CHECK/.test(Ck.buildChecksPromptForGeneration({ compact: true })));
chat.pop();
chat.push({ is_user: false, mes: 'A second reply', name: 'Narrator' });
Ck.settleChecks(null, chat.length - 1);
check('and the new reply uses it up again', Ck.buildChecksContextSummary() === '');

// ── 4. The AI's request ──
chat.push({ is_user: true, mes: 'I step to the edge', name: 'Mastera' });
chat.push({ is_user: false, mes: 'The gap is wide. Can you make it?', name: 'Narrator' });
check('a request from the AI is kept as pending', Ck.settleChecks(JSON.stringify({ stat: 'dex', difficulty: 'hard', reason: 'jump the gap' }), chat.length - 1) === true);
const pend = Ck.getPendingCheck();
check('the pending request has its details', pend && pend.stat === 'dex' && pend.dc === 16 && pend.reason === 'jump the gap' && pendingOk());
function pendingOk() { const a = Ck.pendingActor(); return a && a.isUser && a.name === 'Mastera'; }
check('a request for an attribute the character lacks is ignored', Ck.settleChecks(JSON.stringify({ stat: 'luck' }), chat.length - 1) === false);
const rolled = Ck.rollCheckFor('Mastera', true, { stat: pend.stat, difficulty: pend.difficulty, reason: pend.reason, source: 'ai', rng: seq(0.9) });
check('rolling answers the request', rolled && rolled.source === 'ai' && Ck.getPendingCheck() === null);
Ck.settleChecks(JSON.stringify({ stat: 'str', difficulty: 'easy' }), chat.length - 1);
check('dismissing removes it', (Ck.dismissPendingCheck(), Ck.getPendingCheck() === null));
Ck.settleChecks(JSON.stringify({ stat: 'str', difficulty: 'easy' }), chat.length - 1);
Ck.revertAIChecksForReplacedMessage(chat.length - 1);
check('a swipe of the reply removes what it asked', Ck.getPendingCheck() === null);
Ck.settleChecks(JSON.stringify({ stat: 'str', difficulty: 'easy' }), chat.length - 1);
chat.push({ is_user: true, mes: 'I do something else', name: 'Mastera' });
chat.push({ is_user: false, mes: 'Another reply without a request', name: 'Narrator' });
check('a request not repeated by the next reply lapses', (Ck.settleChecks(null, chat.length - 1), Ck.getPendingCheck() === null));
Ck.settleChecks(JSON.stringify({ stat: 'str', difficulty: 'easy' }), chat.length - 1);
chat.push({ is_user: true, mes: 'x', name: 'Mastera' });
chat.push({ is_user: false, mes: 'y (no tracker at all)', name: 'Narrator' });
check('even without any tracker data, an old request is not shown', Ck.getPendingCheck() === null);

// ── 4b. The reply's "check" survives the parser ──
{
    const { parseResponse } = await import(`${DES}/src/systems/generation/parser.js`);
    const together = parseResponse('```json\n{"infoBox": {"date": "x"}, "check": {"stat": "dex", "difficulty": "hard", "reason": "jump"}}\n```\nThe gap yawns.');
    check('together: the check key comes through', !!together.check && JSON.parse(together.check).stat === 'dex', JSON.stringify(together.check));
    const alone = parseResponse('```json\n{"check": {"stat": "str", "difficulty": "easy"}}\n```');
    check('alone in its block, it still comes through', !!alone.check && JSON.parse(alone.check).difficulty === 'easy', JSON.stringify(alone.check));
}

// ── 5. Switching off, and the chat it belongs to ──
Ck.clearChecks();
Ck.rollCheckFor('Mastera', true, { stat: 'str', rng: seq(0.5) });
otherChat();
check('another chat has none of these', Ck.getRecentChecks().length === 0 && Ck.getPendingCheck() === null);
backToChat();
check('and this one keeps them', Ck.getRecentChecks().length === 1);
Ck.setChecksEnabled(false);
check('switched off: no prompt, no context, no pending', Ck.buildChecksPromptForGeneration({}) === '' && Ck.buildChecksContextSummary() === '' && Ck.getPendingCheck() === null && Ck.settleChecks(JSON.stringify({ stat: 'str' }), 1) === false);
Ck.setChecksEnabled(true);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
