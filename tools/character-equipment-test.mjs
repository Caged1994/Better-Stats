#!/usr/bin/env node
/**
 * Character Equipment test: the pure model, storage per campaign, the AI
 * round-trip (prompt -> parse -> add/remove), locked items and the swipe undo.
 *
 * Usage:  node tools/character-equipment-test.mjs     (from the repo root)
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
const M = await import(`${DES}/src/utils/equipmentModel.js`);
const Eq = await import(`${DES}/src/systems/features/characterEquipment.js`);
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
extensionSettings.characterAliases = { Elena: ['Lady Elena'] };
committedTrackerData.characterThoughts = JSON.stringify({ characters: [{ name: 'Elena' }, { name: 'Mastera' }] });

// ── 1. Pure model ──
check('one emoji is kept as the icon', M.cleanIcon('🗡️ sword') === '🗡️');
check('letters fall back to the box', M.cleanIcon('abc') === M.DEFAULT_ICON && M.cleanIcon('') === M.DEFAULT_ICON);
check('names and descriptions are capped', M.makeItem({ name: 'x'.repeat(99), desc: 'y'.repeat(999) }).name.length <= 40 && M.makeItem({ name: 'a', desc: 'y'.repeat(999) }).desc.length <= 120);
check('no name, no item', M.makeItem({ name: '  ' }) === null);
const norm = M.normalizeAIEquipment({ Elena: { add: [{ icon: '🗡️', name: 'Sword', desc: 'Sharp' }, 'Rope'], remove: 'Torch' } });
check('AI shapes are normalised', norm[0].add.length === 2 && norm[0].remove[0] === 'Torch');
const cur = [{ id: 'a', name: 'Torch', aiCanRemove: true }, { id: 'b', name: "Father's sword", aiCanRemove: false }];
const plan = M.planEquipmentChange(cur, { add: [{ name: 'torch' }, { name: 'Map' }], remove: ['TORCH', "father's sword", 'Ghost'] });
check('unlocked items can be removed by the AI', plan.remove.length === 1 && plan.remove[0].id === 'a');
check('locked items are blocked', plan.blocked.length === 1 && plan.blocked[0].id === 'b');
check('an item removed in the same update can come back; existing ones are not doubled', plan.add.map(i => i.name).join() === 'torch,Map');

// ── 2. Storage per campaign ──
const sword = Eq.addItem('Mastera', true, { icon: '🗡️', name: "Father's sword", desc: 'Old but sharp', aiCanRemove: false });
check('item added by hand', sword.id && sword.aiCanRemove === false && sword.source === 'user');
check('a duplicate is refused', !!Eq.addItem('Mastera', true, { name: "father's SWORD" }).error);
Eq.addItem('Mastera', true, { icon: '🔦', name: 'Torch', desc: 'Half burnt' });
extensionSettings.lorebook.activeCampaignId = 'camp1';
check('another campaign has its own equipment', Eq.getEquipment('Mastera', true).length === 0);
extensionSettings.lorebook.activeCampaignId = null;
check('...switching back finds it', Eq.getEquipment('Mastera', true).length === 2);
check('persona and NPC lists are separate', Eq.getEquipment('Mastera', false).length === 0);

// ── 3. Prompt ──
const instr = pb.generateTrackerInstructions(false, false);
check('current equipment is sent, locked items marked', instr.includes('- Mastera (player character): 🔒🗡️ Father\'s sword, 🔦 Torch'));
check('NPCs with nothing are listed too', instr.includes('- Elena: nothing'));
check('the AI is told how to change equipment', instr.includes('"equipment"') && instr.includes('can never be removed'));
check('a new NPC is asked for its starting gear', /NEW: also add the visible gear Elena/.test(instr));
check('separate-mode context lists equipment', pb.generateContextualSummary().includes('Mastera carries:'));
Eq.setEquipmentEnabled(false);
check('switched off: nothing is sent', !pb.generateTrackerInstructions(false, false).includes('EQUIPMENT'));
Eq.setEquipmentEnabled(true);

// ── 4. AI round-trip ──
const reply = 'Hi\n```json\n{"characters":[{"name":"Elena"}],"equipment":{"Mastera":{"add":[{"icon":"🗺️","name":"Old map","desc":"Shows the marsh paths"}],"remove":["Torch","Father\'s sword"]},"Lady Elena":{"add":[{"icon":"🏹","name":"Longbow","desc":"Yew, well kept"}]}}}\n```\nStory';
const parsed = parseResponse(reply);
check('parser extracts the equipment key', !!parsed.equipment && !parsed.parsingFailed);
check('an equipment-only reply is not a parse failure', !parseResponse('```json\n{"equipment":{"Elena":{"add":["Rope"]}}}\n```').parsingFailed);
chat.push({ is_user: true, mes: 'go' }, { is_user: false, mes: reply });
const res = Eq.applyAIEquipment(parsed.equipment, chat.length - 1);
check('items added and removed', res.added === 2 && res.removed === 1, JSON.stringify(res));
check('the locked item stays and is reported', Eq.getEquipment('Mastera', true).some(i => i.name === "Father's sword") && res.blocked.length === 1);
check('aliases resolve to the card name', Eq.getEquipment('Elena').some(i => i.name === 'Longbow'));
check('the torch is gone, the map is there', !Eq.getEquipment('Mastera', true).some(i => i.name === 'Torch') && Eq.getEquipment('Mastera', true).some(i => i.name === 'Old map' && i.icon === '🗺️'));
check('swipe undoes it', Eq.revertAIEquipmentForReplacedMessage(1) === 3
    && Eq.getEquipment('Mastera', true).map(i => i.name).join() === "Father's sword,Torch" && Eq.getEquipment('Elena').length === 0);
check('...once', Eq.revertAIEquipmentForReplacedMessage(1) === 0);

// ── 5. Editing + cleanup ──
const t = Eq.getEquipment('Mastera', true).find(i => i.name === 'Torch');
Eq.updateItem('Mastera', true, t.id, { aiCanRemove: false });
check('an item can be locked', Eq.getEquipment('Mastera', true).find(i => i.id === t.id).aiCanRemove === false);
check('the user can remove a locked item', Eq.removeItem('Mastera', true, sword.id) && !Eq.getEquipment('Mastera', true).some(i => i.id === sword.id));
extensionSettings.characterEquipment._base['npc:Elly'] = [{ id: 'e1', name: 'Dagger', icon: '🗡️', aiCanRemove: true }];
Eq.mergeEquipment('Elena', 'Elly');
check('alias merge moves the items', Eq.getEquipment('Elena').some(i => i.name === 'Dagger') && !extensionSettings.characterEquipment._base['npc:Elly']);
Eq.deleteEquipmentEverywhere('Elena');
check('deleting a character drops its items', Eq.getEquipment('Elena').length === 0);
extensionSettings.characterEquipment.camp1 = { 'user:Mastera': [] };
Eq.deleteCampaignEquipment('camp1');
check('deleting a campaign drops its equipment', !extensionSettings.characterEquipment.camp1);

if (failures) { console.error(`\n${failures} character-equipment check(s) failed`); process.exit(1); }
console.log('\nAll character-equipment checks pass');
