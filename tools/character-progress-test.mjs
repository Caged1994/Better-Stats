#!/usr/bin/env node
/**
 * Experience, levels, party and RPG mode test: the XP curve and AI parsing,
 * party-shared awards and level-ups, attribute points, NPC levels from the
 * AI, quest XP, swipe undo, campaigns and the RPG mode switch.
 *
 * Usage:  node tools/character-progress-test.mjs     (from the repo root)
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
const S = await import(`${DES}/src/systems/features/characterStats.js`);
const Eq = await import(`${DES}/src/systems/features/characterEquipment.js`);
const Ab = await import(`${DES}/src/systems/features/characterAbilities.js`);
const P = await import(`${DES}/src/systems/features/characterProgress.js`);
const R = await import(`${DES}/src/systems/features/rpgMode.js`);
const X = await import(`${DES}/src/utils/xpModel.js`);
const { parseResponse } = await import(`${DES}/src/systems/generation/parser.js`);
const pb = await import(`${DES}/src/systems/generation/promptBuilder.js`);

let failures = 0;
const check = (label, cond, extra = '') => {
    if (cond) console.log(`pass  ${label}`);
    else { console.error(`FAIL  ${label}${extra ? '\n      ' + extra : ''}`); failures++; }
};

extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: { camp1: { name: 'Camp One' } }, activeCampaignId: null };
extensionSettings.showInfoBox = true;
extensionSettings.showCharacterThoughts = true;
extensionSettings.showQuests = false;
extensionSettings.compactPrompts = true;
extensionSettings.customTrackerPrompt = '';
extensionSettings.knownCharacters = { Elena: {}, Bram: {} };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Bram' }, { name: 'Mastera' }] });
for (const [n, u] of [['Mastera', true], ['Elena', false], ['Bram', false]]) {
    Eq.cancelStartingGear(n, u); Ab.cancelStartingAbilities(n, u);
}

// ── 1. The curve and the AI's values ──
check('level 2 at 100 XP, level 3 at 300, level 4 at 600', X.xpToReach(2) === 100 && X.xpToReach(3) === 300 && X.xpToReach(4) === 600);
check('XP total → level', X.levelForXp(99) === 1 && X.levelForXp(100) === 2 && X.levelForXp(299) === 2 && X.levelForXp(300) === 3);
check('a custom step changes the curve', X.levelForXp(150, 50) === 3);
const ax = (v) => JSON.stringify(X.normalizeAIXp(v));
check('object award', ax({ size: 'large', reason: 'Beat the ogre' }) === '{"size":"large","amount":50,"reason":"Beat the ogre"}');
check('"size: reason" text', ax('medium: Drove off the bandits') === '{"size":"medium","amount":25,"reason":"Drove off the bandits"}');
check('synonyms', X.normalizeAIXp({ tier: 'minor' }).size === 'small' && X.normalizeAIXp('legendary').size === 'epic');
check('a number maps to the closest size', X.normalizeAIXp(30).size === 'medium' && X.normalizeAIXp({ amount: 90, reason: 'x' }).size === 'epic');
check('a list keeps only the biggest award', X.normalizeAIXp([{ size: 'small' }, { size: 'large', reason: 'big' }]).reason === 'big');
check('the user\'s amounts are used', X.normalizeAIXp('small', { small: 7 }).amount === 7);
check('junk gives no award', X.normalizeAIXp('nothing happened') === null && X.normalizeAIXp({}) === null);
check('levels in several shapes', JSON.stringify(X.normalizeAILevels({ A: 4, B: 'Lv 7', C: { level: 2 }, D: 'x' })) === '[{"name":"A","level":4},{"name":"B","level":7},{"name":"C","level":2}]');

// ── 2. Party awards and level-ups ──
check('the persona starts at level 1', P.getProgress('Mastera', true).level === 1 && P.hasLevel('Mastera', true));
check('only the persona is in the party at first', P.getPartyMembers().length === 1);
P.setPartyMember('Elena', true);
check('an NPC can join the party', P.isPartyMember('Elena') && P.getPartyMembers().map(m => m.name).join() === 'Mastera,Elena');
P.awardPartyXp(60, { reason: 'Fight', source: 'ai' });
check('each member gets the same XP', P.getProgress('Mastera', true).xp === 60 && P.getProgress('Elena').xp === 60);
check('NPCs outside the party get nothing', P.getProgress('Bram').xp === 0);
toasts.length = 0;
P.awardPartyXp(50, { reason: 'Puzzle', source: 'ai' });
let m = P.getProgress('Mastera', true);
check('level up at 100 XP with 3 points', m.level === 2 && m.points === 3, JSON.stringify(m));
check('a level-up toast per member', toasts.length === 2 && /reached level 2/.test(toasts[0]));
check('the log keeps the award and the level reached', m.log.length === 2 && m.log[1].reason === 'Puzzle' && m.log[1].level === 2);
check('XP into the level', JSON.stringify(P.getLevelInfo('Mastera', true)) === JSON.stringify({ level: 2, xp: 110, into: 10, needed: 200, pct: 5 }));
P.awardXpTo('Mastera', true, 500, { reason: 'Big', source: 'user' });
m = P.getProgress('Mastera', true);
check('several levels at once', m.level === 4 && m.points === 9, JSON.stringify(m));
P.removeLogEntry('Mastera', true, m.log[m.log.length - 1].id);
m = P.getProgress('Mastera', true);
check('deleting a log entry takes its XP back, the level stays', m.xp === 110 && m.level === 4);

// ── 3. Attribute points ──
const str0 = S.getCurrentStatValues('Mastera', true).str;
check('spending a point raises the attribute', P.spendPoint('Mastera', true, 'str') && S.getCurrentStatValues('Mastera', true).str === str0 + 1);
P.spendPoint('Mastera', true, 'str');
m = P.getProgress('Mastera', true);
check('points and spending are tracked', m.points === 7 && m.spent.str === 2);
check('a point can be taken back', P.refundPoint('Mastera', true, 'str') && S.getCurrentStatValues('Mastera', true).str === str0 + 1 && P.getProgress('Mastera', true).points === 8);
check('states take no points', P.spendPoint('Mastera', true, 'health') === false);
check('no refund without a spent point', P.refundPoint('Mastera', true, 'dex') === false);
P.setUnspentPoints('Mastera', true, 0);
check('without points nothing is spent', P.spendPoint('Mastera', true, 'dex') === false);

// ── 4. Prompt: XP rules and NPC levels ──
let instr = pb.generateTrackerInstructions(false, false);
check('the XP rules are sent', instr.includes('EXPERIENCE') && instr.includes('"xp": {"size": "medium"'));
check('sizes carry the user\'s amounts', instr.includes('small (10)') && instr.includes('epic (100)'));
check('the party is named with levels', instr.includes('Mastera (player character) Lv 4') && instr.includes('Elena Lv 2'));
check('a new NPC is asked for a level', /LEVELS — .*"Bram": 3/.test(instr), instr.slice(instr.indexOf('LEVELS'), instr.indexOf('LEVELS') + 200));
check('party members are not asked for a level', !/"levels": \{[^}]*Elena/.test(instr));
check('separate-mode context has the levels', pb.generateContextualSummary().includes('Levels: Mastera Lv 4 (party), Elena Lv 2 (party)'));

// ── 5. AI round-trip + undo ──
const reply = '```json\n{"infoBox":{"location":{"value":"Inn"}},"xp":{"size":"large","reason":"Saved the village"},"levels":{"Bram":6}}\n```\nStory';
const parsed = parseResponse(reply);
check('parser extracts xp and levels', !!parsed.xp && !!parsed.levels && !parsed.parsingFailed, JSON.stringify(parsed));
check('the experience alias works', !!parseResponse('```json\n{"experience":"small: found a key"}\n```').xp);
check('a bare xp object is not a parsing failure', !parseResponse('{"xp":{"size":"small"}}').parsingFailed);
chat.push({ is_user: true, mes: 'go' }, { is_user: false, mes: reply });
const before = JSON.stringify(extensionSettings.characterProgress);
const res = P.applyAIProgress(parsed.xp, parsed.levels, chat.length - 1);
check('award goes to the whole party', res.amount === 50 && res.members === 2, JSON.stringify(res));
check('Bram got his level', P.getProgress('Bram').level === 6 && P.getProgress('Bram').levelSet === 'ai' && P.getProgress('Bram').xp === 0 + X.xpToReach(6));
check('Bram is not asked again', !P.needsLevel('Bram'));
P.requestLevelGeneration('Bram');
check('regenerating stats asks for the level again', P.needsLevel('Bram'));
P.applyAIProgress(null, { Bram: 6 }, chat.length - 1);
check('the reason is logged', P.getProgress('Elena').log.at(-1).reason === 'Saved the village');
instr = pb.generateTrackerInstructions(false, false);
check('known levels are shown', instr.includes('Known levels: Bram Lv 6'));
check('a second level for Bram is ignored', P.applyAIProgress(null, { Bram: 2 }, chat.length - 1).levels === 0);
check('swipe restores every record the reply changed', P.revertAIProgressForReplacedMessage(chat.length - 1) === 3 && JSON.stringify(extensionSettings.characterProgress) === before);
P.applyAIProgress(parsed.xp, null, chat.length - 1);
P.setUnspentPoints('Elena', false, 5);
check('a record the user touched since is not reverted', P.revertAIProgressForReplacedMessage(chat.length - 1) === 1 && P.getProgress('Elena').points === 5);
chat.push({ is_user: true, mes: 'a' }, { is_user: false, mes: 'b' });
P.applyAIProgress('small', null, chat.length - 1);
check('nothing for a reply that is not the one replaced', P.revertAIProgressForReplacedMessage(0) === 0 && !!chat_metadata.dooms_tracker.xpUndo);

// ── 6. Quests ──
const xp0 = P.getProgress('Elena').xp;
const q = P.awardQuestXp('Find the sword', 'main');
check('a completed main quest gives epic XP to the party', q.amount === 100 && P.getProgress('Elena').xp === xp0 + 100);
check('the log names the quest', P.getProgress('Elena').log.at(-1).reason === 'Quest completed: Find the sword' && P.getProgress('Elena').log.at(-1).source === 'quest');
P.setXpSetting('questOptional', 'small');
check('quest sizes are configurable', P.awardQuestXp('Herbs', 'optional').amount === 10);

// ── 7. Settings ──
P.setXpSetting('small', 15);
P.setXpSetting('perLevel', 50);
check('custom amounts and curve', P.getXpSettings().tiers.small === 15 && P.getXpSettings().perLevel === 50);
check('the curve applies to levels', P.getLevelInfo('Mastera', true).needed === 4 * 50);
P.setXpSetting('perLevel', 100);
P.setXpEnabled(false);
instr = pb.generateTrackerInstructions(false, false);
check('XP off: no award rules, levels still kept', !instr.includes('EXPERIENCE') && P.isProgressEnabled());
check('XP off: AI awards are ignored', P.applyAIProgress('epic', null, chat.length - 1).amount === 0);
check('XP off: quests give nothing', P.awardQuestXp('x', 'main') === null);
P.setXpEnabled(true);

// ── 8. Campaigns ──
extensionSettings.lorebook.activeCampaignId = 'camp1';
check('another campaign starts fresh', P.getProgress('Mastera', true).level === 1 && !P.isPartyMember('Elena'));
P.awardPartyXp(100, { reason: 'c1' });
check('it levels on its own', P.getProgress('Mastera', true).level === 2);
extensionSettings.lorebook.activeCampaignId = null;
check('the first campaign is untouched', P.getProgress('Mastera', true).level === 4);
P.deleteCampaignProgress('camp1');
check('deleting a campaign drops its progress', !extensionSettings.characterProgress.camp1);

// ── 9. RPG mode ──
check('on by default', R.isRpgModeActive() && R.rpgModeSource() === 'default');
R.setCardRpgMode(false);
check('off for the card', !R.isRpgModeActive() && R.rpgModeSource() === 'card');
instr = pb.generateTrackerInstructions(false, false);
check('RPG off: nothing of Better Stats is sent', !instr.includes('EXPERIENCE') && !instr.includes('"stats"') && !instr.includes('EQUIPMENT') && !instr.includes('LEVELS'));
check('RPG off: no stats example', !pb.generateTrackerExample().includes('"stats"'));
check('RPG off: replies change nothing', P.applyAIProgress('epic', null, chat.length - 1).amount === 0 && S.applyAIStatUpdates({ Mastera: { Health: 5 } }, chat.length - 1) === 0);
R.setChatRpgMode(true);
check('the chat setting wins over the card', R.isRpgModeActive() && R.rpgModeSource() === 'chat' && chat_metadata.dooms_tracker.rpgMode === true);
R.setChatRpgMode(null);
check('back to the card setting', !R.isRpgModeActive());
R.setCardRpgMode(null);
R.setDefaultRpgMode(false);
check('the default can be off', !R.isRpgModeActive());
R.setDefaultRpgMode(true);
check('and on again', R.isRpgModeActive());

// ── 10. Cleanup ──
P.mergeProgress('Elena', 'Bram');
check('alias merge keeps the canonical record', P.getProgress('Elena').party && !Object.keys(extensionSettings.characterProgress._base).some(k => k === 'npc:Bram'));
P.deleteProgressEverywhere('Elena');
check('deleting a character drops its progress', !P.isPartyMember('Elena') && P.getProgress('Elena').xp === 0);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll character-progress checks pass');
