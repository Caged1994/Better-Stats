#!/usr/bin/env node
/**
 * Character Stats test: the pure model, storage per campaign, the AI
 * round-trip (prompt -> parse -> apply) and the swipe undo.
 *
 * Usage:  node tools/character-stats-test.mjs     (from the repo root)
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
globalThis.toastr = anything;
globalThis.SillyTavern = anything;
globalThis.requestAnimationFrame = () => 0;
const events = [];
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.dispatchEvent = (e) => { events.push(e.type); return true; };

const { extensionSettings, committedTrackerData } = await import(`${DES}/src/core/state.js`);
const { chat, chat_metadata } = await import(`${SANDBOX}/script.js`);
const S = await import(`${DES}/src/systems/features/characterStats.js`);
const M = await import(`${DES}/src/utils/statsModel.js`);
const { parseResponse } = await import(`${DES}/src/systems/generation/parser.js`);
const pb = await import(`${DES}/src/systems/generation/promptBuilder.js`);

let failures = 0;
const check = (label, cond, extra = '') => {
    if (cond) console.log(`pass  ${label}`);
    else { console.error(`FAIL  ${label}${extra ? '\n      ' + extra : ''}`); failures++; }
};

// ── Setup: a persona and one NPC in the scene ──
extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: { camp1: { name: 'Camp One' } }, activeCampaignId: null };
extensionSettings.showQuests = false;
extensionSettings.showInfoBox = true;
extensionSettings.showCharacterThoughts = true;
extensionSettings.compactPrompts = true;
extensionSettings.customTrackerPrompt = '';
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Mastera' }] });

// ── 1. Defaults ──
const sheet = S.getStatSheet('Elena');
check('every character starts with 6 attributes + 6 states', sheet.length === 12);
check('states are AI-updated by default, attributes are not',
    sheet.filter(s => s.ai).every(s => s.kind === 'state') && sheet.filter(s => s.kind === 'state').every(s => s.ai));
check('persona and present NPC are the stat characters',
    JSON.stringify(S.getStatCharacters()) === JSON.stringify([{ name: 'Mastera', isUser: true }, { name: 'Elena', isUser: false }]));

// ── 2. Sheet save + custom stat only for that character ──
const list = S.getStatSheet('Mastera', true);
const { stat: sanity } = M.createCustomStat(list, { name: 'Sanity', kind: 'state', description: 'Grip on reality' });
list.push(sanity);
list.find(s => s.id === 'str').base = 70;
S.saveStatSheet('Mastera', true, list);
check('custom stat saved on the persona', S.getStatSheet('Mastera', true).some(s => s.id === sanity.id));
check('...and not on other characters', !S.getStatSheet('Elena').some(s => s.id === sanity.id));
check('base value saved', S.getStatSheet('Mastera', true).find(s => s.id === 'str').base === 70);
check('changes broadcast an event', events.includes(S.STATS_CHANGED_EVENT));

// ── 3. Current values are per campaign; base is shared ──
check('current falls back to base', S.getCurrentStatValues('Mastera', true).str === 70);
S.setCurrentStatValue('Mastera', true, 'satiety', 40);
check('current value set (no campaign)', S.getCurrentStatValues('Mastera', true).satiety === 40);
extensionSettings.lorebook.activeCampaignId = 'camp1';
check('another campaign starts from the base', S.getCurrentStatValues('Mastera', true).satiety === 80);
S.setCurrentStatValue('Mastera', true, 'satiety', 10);
extensionSettings.lorebook.activeCampaignId = null;
check('switching back keeps each campaign\'s own value', S.getCurrentStatValues('Mastera', true).satiety === 40);
check('values are clamped', S.setCurrentStatValue('Mastera', true, 'str', 999) === 100);
S.setCurrentStatValue('Mastera', true, 'str', 70);

// ── 4. Prompt carries the stats ──
const instr = pb.generateTrackerInstructions(false, false);
check('tracker instructions ask for "stats"', instr.includes('"stats"') && instr.includes('"Elena"') && instr.includes('"Mastera"'));
check('fixed stats are read-only context', /Fixed stats/.test(instr) && /Strength 70/.test(instr));
check('custom stat is explained to the AI', instr.includes('Sanity (Mastera only)'));
extensionSettings.customTrackerPrompt = 'MY OWN PROMPT';
check('stats survive a custom tracker prompt', pb.generateTrackerInstructions(false, false).includes('"stats"'));
extensionSettings.customTrackerPrompt = '';
extensionSettings.showInfoBox = false;
extensionSettings.showCharacterThoughts = false;
const standalone = pb.generateTrackerInstructions(false, true);
check('stats get their own JSON block when no tracker is on', standalone.includes('Start every reply with ONE JSON code block') && standalone.includes('"stats"'));
extensionSettings.showInfoBox = true;
extensionSettings.showCharacterThoughts = true;
check('separate-mode context lists the stats', pb.generateContextualSummary().includes('Character stats:'));

// ── 5. Parse + apply an AI reply ──
const reply = 'Hi\n```json\n{"infoBox":{"location":{"value":"Hill"}},"characters":[{"name":"Elena"}],"stats":{"Elena":{"Satiety":55,"Strength":1},"Mastera":{"Health":"60","Sanity":90}}}\n```\nStory...';
const parsed = parseResponse(reply);
check('parser extracts the stats key', !!parsed.stats && !!parsed.infoBox && !parsed.parsingFailed);
check('a stats-only reply is not a parse failure', !parseResponse('```json\n{"stats":{"Elena":{"Energy":5}}}\n```').parsingFailed);
chat.push({ is_user: true, mes: 'go' }, { is_user: false, mes: reply });
const changed = S.applyAIStatUpdates(parsed.stats, chat.length - 1);
check('AI changes applied', changed === 3, `changed=${changed}`);
check('...to AI-editable stats', S.getCurrentStatValues('Elena').satiety === 55 && S.getCurrentStatValues('Mastera', true).health === 60);
check('...but never to locked ones', S.getCurrentStatValues('Elena').str === 50);
check('undo recorded for the reply', chat_metadata.dooms_tracker?.statsUndo?.messageIndex === 1);

// ── 6. Swipe undo keeps manual edits ──
S.setCurrentStatValue('Mastera', true, 'health', 75); // user edits after the reply
const reverted = S.revertAIStatsForReplacedMessage(1);
check('swipe rolls back the AI\'s changes', S.getCurrentStatValues('Elena').satiety === 80 && S.getCurrentStatValues('Mastera', true)[sanity.id] === 100);
check('...but keeps a value the user edited since', S.getCurrentStatValues('Mastera', true).health === 75 && reverted === 2);
check('undo is consumed once', S.revertAIStatsForReplacedMessage(1) === 0);

// ── 7. Deleting a custom stat / character cleans up ──
const trimmed = S.getStatSheet('Mastera', true).filter(s => s.id !== sanity.id);
S.setCurrentStatValue('Mastera', true, sanity.id, 33);
S.saveStatSheet('Mastera', true, trimmed);
check('removing a custom stat drops its current values',
    !Object.values(extensionSettings.characterStatValues).some(b => b['user:Mastera'] && sanity.id in b['user:Mastera']));
S.deleteCampaignStatValues('camp1');
check('deleting a campaign drops its values', !extensionSettings.characterStatValues.camp1);
S.deleteStatSheet('Mastera', true);
check('deleting a character drops sheet and values',
    !extensionSettings.characterStatSheets.user.Mastera && !Object.values(extensionSettings.characterStatValues).some(b => 'user:Mastera' in b));

if (failures) { console.error(`\n${failures} character-stats check(s) failed`); process.exit(1); }
console.log('\nAll character-stats checks pass');
