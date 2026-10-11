#!/usr/bin/env node
/**
 * Money, affinity, Mana costs and automatic consequences test.
 * party-shared awards and level-ups, attribute points, NPC levels from the
 * AI, quest XP, swipe undo, chats and the RPG mode switch.
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
// Data belongs to the chat: another chat is another dooms_tracker blob.
const savedChats = [];
const otherChat = () => { savedChats.push(chat_metadata.dooms_tracker); chat_metadata.dooms_tracker = {}; };
const backToChat = () => { chat_metadata.dooms_tracker = savedChats.pop(); };
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
const Cd = await import(`${DES}/src/systems/features/characterConditions.js`);
const Cq = await import(`${DES}/src/systems/features/characterConsequences.js`);
const Mo = await import(`${DES}/src/systems/features/characterMoney.js`);
const Af = await import(`${DES}/src/systems/features/characterAffinity.js`);
const MoM = await import(`${DES}/src/utils/moneyModel.js`);
const AfM = await import(`${DES}/src/utils/affinityModel.js`);
const AbM = await import(`${DES}/src/utils/abilityModel.js`);
const CqM = await import(`${DES}/src/utils/consequenceModel.js`);
const Mod = await import(`${DES}/src/systems/features/characterModifiers.js`);

extensionSettings.enabled = true;
extensionSettings.userCharacters = { Mastera: {} };
extensionSettings.activeUserCharacter = 'Mastera';
extensionSettings.lorebook = { campaigns: {}, activeCampaignId: null };
extensionSettings.showInfoBox = true;
extensionSettings.showCharacterThoughts = true;
extensionSettings.showQuests = false;
extensionSettings.compactPrompts = true;
extensionSettings.customTrackerPrompt = '';
extensionSettings.knownCharacters = { Elena: {}, Bram: {} };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Bram' }, { name: 'Mastera' }] });
for (const [n, u] of [['Mastera', true], ['Elena', false], ['Bram', false]]) { Eq.cancelStartingGear(n, u); Ab.cancelStartingAbilities(n, u); }
for (const n of ['Elena', 'Bram']) S.saveStatSheet(n, false, S.getStatSheet(n, false), { pending: false });
chat.push({ is_user: true, mes: 'a' }, { is_user: false, mes: 'b' });
const last = () => chat.length - 1;

// ── 1. Mana costs ──
check('cost words and numbers map to tiers', AbM.normalizeManaCost('high') === 'heavy' && AbM.normalizeManaCost(14) === 'medium' && AbM.normalizeManaCost('free') === null);
check('custom tier amounts', JSON.stringify(AbM.resolveManaTiers({ light: 3, heavy: 200 })) === '{"light":3,"medium":15,"heavy":100}');
Ab.applyAIAbilities({ Mastera: { add: [{ name: 'Fireball', type: 'spell', cost: 'medium' }, { name: 'Tracking', type: 'ability', cost: 'heavy' }] } }, last());
const fb = Ab.getAbilities('Mastera', true).find(a => a.name === 'Fireball');
check('the AI\'s cost is kept on spells', fb.cost === 'medium');
check('abilities never cost Mana', Ab.getAbilities('Mastera', true).find(a => a.name === 'Tracking').cost === null);
let instr = pb.generateTrackerInstructions(false, false);
check('spells are sent with their Mana cost', instr.includes('Fireball (Mana 15)'));
check('the AI is told how casting works', instr.includes('Casting one lowers the caster\'s Mana in "stats" by its cost'));
Ab.setManaTier('medium', 20);
check('the cost follows the settings', pb.generateTrackerInstructions(false, false).includes('Fireball (Mana 20)'));
Ab.updateAbility('Mastera', true, fb.id, { cost: 'light' });
check('the cost can be edited', Ab.getAbilities('Mastera', true).find(a => a.name === 'Fireball').cost === 'light');
S.setStatEnabled('mana', false);
instr = pb.generateTrackerInstructions(false, false);
check('Mana switched off: spells are free, no cost sent', instr.includes('Fireball') && !instr.includes('Mana 5') && !instr.includes('Spells cost Mana'));
S.setStatEnabled('mana', true);

// ── 2. Automatic consequences ──
check('rule choice with hysteresis', CqM.desiredRule('satiety', 25)?.id === 'hungry' && CqM.desiredRule('satiety', 33, 'hungry')?.id === 'hungry' && CqM.desiredRule('satiety', 36, 'hungry') === null);
check('a worse rule takes over', CqM.desiredRule('satiety', 5, 'hungry')?.id === 'starving' && CqM.desiredRule('satiety', 13, 'starving')?.id === 'starving');
S.setCurrentStatValue('Mastera', true, 'satiety', 25);
let conds = Cd.getConditions('Mastera', true);
check('a low bar adds its condition', conds.some(c => c.name === 'Hungry' && c.source === 'auto'));
check('...with its malus', Mod.getEffectiveStatValues('Mastera', true).modifiers.str?.total === -1);
S.setCurrentStatValue('Mastera', true, 'satiety', 5);
conds = Cd.getConditions('Mastera', true);
check('it worsens to Starving (one per bar)', conds.some(c => c.name === 'Starving') && !conds.some(c => c.name === 'Hungry'));
S.setCurrentStatValue('Mastera', true, 'satiety', 14);
check('recovering a little keeps it (no flicker)', Cd.getConditions('Mastera', true).some(c => c.name === 'Starving'));
S.setCurrentStatValue('Mastera', true, 'satiety', 60);
check('a full bar ends it', !Cd.getConditions('Mastera', true).some(c => c.source === 'auto'));
S.applyAIStatUpdates({ Elena: { Health: 0 } }, last());
check('AI stat updates trigger them too', Cd.getConditions('Elena').some(c => c.name === 'Unconscious'));
Cd.applyAIConditions({ Elena: { remove: ['Unconscious'] } }, last());
check('the AI cannot remove an automatic condition', Cd.getConditions('Elena').some(c => c.name === 'Unconscious'));
instr = pb.generateTrackerInstructions(false, false);
check('the AI sees them marked [auto]', instr.includes('Unconscious [auto]') && instr.includes('never add or remove those yourself'));
S.revertAIStatsForReplacedMessage(last());
check('a swipe that restores the bar ends it', !Cd.getConditions('Elena').some(c => c.name === 'Unconscious'));
S.setCurrentStatValue('Mastera', true, 'energy', 5);
Cq.setConsequencesEnabled(false);
check('switching the feature off removes them', !Cd.getConditions('Mastera', true).some(c => c.source === 'auto'));
Cq.setConsequencesEnabled(true);
check('...and on again brings them back', Cd.getConditions('Mastera', true).some(c => c.name === 'Exhausted'));
S.setCurrentStatValue('Mastera', true, 'energy', 100);
S.setStatEnabled('hygiene', false);
S.setCurrentStatValue('Mastera', true, 'satiety', 60);
check('switched-off bars bring nothing', !Cd.getConditions('Mastera', true).some(c => c.name === 'Filthy'));
S.setStatEnabled('hygiene', true);

// ── 3. Affinity ──
check('tiers', AfM.affinityTier(-80).id === 'hostile' && AfM.affinityTier(0).id === 'neutral' && AfM.affinityTier(35).id === 'friendly' && AfM.affinityTier(90).id === 'close');
check('AI shapes', JSON.stringify(AfM.normalizeAIAffinity({ A: 5, B: '−3', C: { set: 40 }, D: { change: -4, reason: 'Insulted' } })) === '[{"name":"A","delta":5,"reason":""},{"name":"B","delta":-3,"reason":""},{"name":"C","set":40,"reason":""},{"name":"D","delta":-4,"reason":"Insulted"}]');
instr = pb.generateTrackerInstructions(false, false);
check('new NPCs are asked for a starting affinity', /STARTING AFFINITY: give Elena, Bram/.test(instr));
Af.applyAIAffinity({ Elena: { set: 30 }, Bram: { set: -25 } }, last());
check('starting values are kept', Af.getAffinity('Elena') === 30 && Af.getAffinity('Bram') === -25);
Af.applyAIAffinity({ Elena: { set: 90 } }, last());
check('a starting value is given only once', Af.getAffinity('Elena') === 30);
Af.applyAIAffinity({ Elena: 25, Bram: { change: -4, reason: 'Insulted' } }, last());
check('changes are capped at ±10', Af.getAffinity('Elena') === 40 && Af.getAffinity('Bram') === -29);
check('the reason is kept', Af.getAffinityRecord('Bram').reason === 'Insulted');
check('the persona has no affinity', Af.applyAIAffinity({ Mastera: 5 }, last()) === 0);
instr = pb.generateTrackerInstructions(false, false);
check('values are sent with their tier', instr.includes('AFFINITY toward Mastera') && instr.includes('Elena +40 (friendly)') && instr.includes('Bram -29 (wary)'));
chat.push({ is_user: true, mes: 'c' }, { is_user: false, mes: 'd' });
Af.applyAIAffinity({ Elena: -10 }, last());
check('swipe undoes the change', Af.revertAIAffinityForReplacedMessage(last()) === 1 && Af.getAffinity('Elena') === 40);
check('set by hand, clamped', Af.setAffinity('Elena', 250) === 100);
check('separate-mode context', pb.generateContextualSummary().includes('Affinity toward Mastera: Elena +100 (close), Bram -29 (wary)'));

// ── 4. Money ──
check('amounts parse', MoM.roundMoney('+5.50') === 5.5 && MoM.roundMoney('1,250.75') === 1250.75 && MoM.roundMoney('abc') === null);
check('currency shapes', JSON.stringify(MoM.normalizeCurrency({ name: 'euro', symbol: '€' })) === '{"name":"euro","symbol":"€"}' && MoM.normalizeCurrency('credits').name === 'credits');
check('formatting', MoM.formatMoney(1250.5, { name: 'euro', symbol: '€' }) === '1,250.50 €' && MoM.formatMoney(3, { name: 'gold crowns', symbol: '' }) === '3 gold crowns');
check('no currency on the card yet', Mo.getCurrency() === null);
instr = pb.generateTrackerInstructions(false, false);
check('the AI is asked for a currency and starting money', instr.includes('CURRENCY: none chosen yet') && /STARTING MONEY: give Mastera/.test(instr));
Mo.applyAICurrency({ name: 'euro', symbol: '€' });
check('the AI\'s currency is kept for the card', Mo.getCurrency()?.symbol === '€');
Mo.applyAICurrency({ name: 'gold', symbol: 'g' });
check('...and not replaced afterwards', Mo.getCurrency().name === 'euro');
Mo.applyAIMoney({ Mastera: { set: 150 } }, last());
check('starting money', Mo.getMoney('Mastera', true) === 150);
chat.push({ is_user: true, mes: 'e' }, { is_user: false, mes: 'f' });
Mo.applyAIMoney({ Mastera: -12.5, Bram: 40 }, last());
check('spending, and no purse outside the party', Mo.getMoney('Mastera', true) === 137.5 && Mo.getMoney('Bram') === null);
chat.push({ is_user: true, mes: 'g' }, { is_user: false, mes: 'h' });
Mo.applyAIMoney({ Mastera: -999 }, last());
check('never below zero', Mo.getMoney('Mastera', true) === 0);
check('swipe restores it', Mo.revertAIMoneyForReplacedMessage(last()) === 1 && Mo.getMoney('Mastera', true) === 137.5);
Mo.setMoney('Mastera', true, 150);
P.setPartyMember('Elena', true);
check('party members get a purse too', /STARTING MONEY: give Elena/.test(pb.generateTrackerInstructions(false, false)));
instr = pb.generateTrackerInstructions(false, false);
check('balances are sent with the currency', instr.includes('MONEY (euro, €): Mastera 150 €'));
Mo.setCurrency({ name: 'credits', symbol: '' });
check('the user can change the currency', pb.generateTrackerInstructions(false, false).includes('MONEY (credits): Mastera 150 credits'));
check('parser extracts money, currency and affinity', (() => { const r = parseResponse('{"money":{"Mastera":-3},"currency":"credits","affinity":{"Elena":2}}'); return !!r.money && !!r.currency && !!r.affinity && !r.parsingFailed; })());

// ── 5. Per chat, RPG mode ──
otherChat();
check('a new chat: no money or affinity', Mo.getMoney('Mastera', true) === null && Af.getAffinity('Elena') === null);
check('...the card keeps its currency', Mo.getCurrency()?.name === 'credits');
backToChat();
R.setCardRpgMode(false);
instr = pb.generateTrackerInstructions(false, false);
check('RPG off: no money or affinity sent', !instr.includes('MONEY') && !instr.includes('AFFINITY'));
check('RPG off: no automatic conditions', (S.setCurrentStatValue('Mastera', true, 'satiety', 5), !Cd.getConditions('Mastera', true).some(c => c.name === 'Starving')));
R.setCardRpgMode(null);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll character-economy checks pass');
