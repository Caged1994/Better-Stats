/**
 * Sphere grid — the link between the grid rules (src/utils/sphereModel.js)
 * and the rest of Better Stats.
 *
 * It is a second way to spend the points that levels give, next to putting
 * them on an attribute by hand; it is off until switched on in Settings. Every
 * character has their own grid, built the first time it is opened (the
 * program lays it out, the AI names the spells, skills and passives once, or
 * nothing is asked and they get plain names). Unlocking a node next to one you
 * own costs points and gives its reward at once: a raised attribute, a real
 * spell or skill (with its combat effect already set) or a passive bonus.
 *
 * In the chat: chat_metadata.dooms_tracker.betterStats.sphereGrid = { grids: { "user:Name"|"npc:Name": grid } }
 */
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { safeGenerateRaw } from '../../utils/responseExtractor.js';
import { repairJSON } from '../../utils/jsonRepair.js';
import { isRpgModeActive } from './rpgMode.js';
import { chatStore, saveChatScope } from './chatScope.js';
import { statKey, getStatSheet, getCurrentStatValues, setCurrentStatValue, notifyStatsChanged } from './characterStats.js';
import { isProgressEnabled, getProgress, spendPointsOn } from './characterProgress.js';
import { addAbility, getAbilities } from './characterAbilities.js';
import { setActionProfile, recentMessages, cardInfo } from './combat.js';
import { activeStats } from '../../utils/statsModel.js';
import { cleanIcon } from '../../utils/equipmentModel.js';
import * as S from '../../utils/sphereModel.js';
import { buildSphereDressingPrompt } from '../generation/spherePrompts.js';

// ─── Settings ───────────────────────────────────────────────────────────────

/** Off until switched on; it needs RPG mode and levels (they give the points). */
export function isSphereEnabled() {
    return isRpgModeActive() && isProgressEnabled() && extensionSettings.sphereGridEnabled === true;
}

export function setSphereEnabled(on) {
    extensionSettings.sphereGridEnabled = !!on;
    saveSettings();
    notifyStatsChanged({ source: 'settings' });
}

// ─── Storage ────────────────────────────────────────────────────────────────

function bucket(create = false) {
    const s = chatStore('sphereGrid', create);
    if (s && create && (!s.grids || typeof s.grids !== 'object')) s.grids = {};
    return s;
}

export function getGrid(name, isUser = false) {
    const g = bucket()?.grids?.[statKey(name, isUser)];
    return g && typeof g === 'object' && g.nodes && Array.isArray(g.unlocked) ? g : null;
}

function saveGrid(name, isUser, grid) {
    bucket(true).grids[statKey(name, isUser)] = grid;
    saveChatScope();
    notifyStatsChanged({ source: 'sphere', name });
}

export function deleteGrid(name, isUser = false) {
    const b = bucket();
    const k = statKey(name, isUser);
    if (!b?.grids?.[k]) return false;
    delete b.grids[k];
    saveChatScope();
    notifyStatsChanged({ source: 'sphere', name });
    return true;
}

function attributeIds(name, isUser) {
    return activeStats(getStatSheet(name, isUser)).filter(s => s.kind === 'attribute').map(s => s.id);
}

// ─── Creating a grid ────────────────────────────────────────────────────────

/**
 * Builds a character's grid and (unless `useAI` is false) has the AI name its
 * spells, skills and passives in one request. If the AI fails the grid is
 * complete with plain names and `aiError` says why.
 * @returns {Promise<{ grid, aiError?: string }>}
 */
export async function createGrid(name, isUser, { size = S.DEFAULT_SIZE, theme = '', useAI = true, seed = Date.now(), generate = safeGenerateRaw, depth = 6 } = {}) {
    const attrs = attributeIds(name, isUser);
    const grid = S.generateGrid({ seed, size, attributes: attrs.length ? attrs : undefined, theme });
    let aiError;
    if (useAI) {
        try {
            const card = cardInfo();
            const messages = buildSphereDressingPrompt({
                grid, character: name, cardName: card.name, cardDescription: card.description,
                messages: recentMessages(depth), known: getAbilities(name, isUser).map(a => a.name),
            });
            const reply = await generate({ prompt: messages, quietToLoud: false });
            const m = String(reply || '').match(/\{[\s\S]*\}/);
            if (!m) throw new Error('The AI did not return any JSON.');
            const data = repairJSON(m[0], { allowFunctionEval: false });
            if (!S.applyDressing(grid, data, cleanIcon)) throw new Error('The AI reply had no names in it.');
        } catch (e) {
            aiError = e?.message || 'The AI could not be reached.';
        }
    }
    S.fillNames(grid);
    saveGrid(name, isUser, grid);
    return { grid, ...(aiError ? { aiError } : {}) };
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Everything the window needs about one character's grid. */
export function getGridView(name, isUser = false) {
    const grid = getGrid(name, isUser);
    const points = getProgress(name, isUser).points;
    if (!grid) return { grid: null, points };
    const reach = new Set(S.reachable(grid));
    return { grid, points, reach, progress: S.gridProgress(grid) };
}

// ─── Unlocking ──────────────────────────────────────────────────────────────

function uniqueAbilityName(name, isUser, base) {
    const known = new Set(getAbilities(name, isUser).map(a => a.name.toLowerCase()));
    let n = base, i = 2;
    while (known.has(n.toLowerCase())) n = `${base} ${i++}`.slice(0, 40);
    return n;
}

/**
 * Unlocks a node: checks the rules, gives the reward, spends the points.
 * @returns {{ ok: boolean, reason?: string, node?: object, gave?: string }}
 */
export function unlockNode(name, isUser, nodeId) {
    const grid = getGrid(name, isUser);
    if (!grid) return { ok: false, reason: 'No grid yet.' };
    const points = getProgress(name, isUser).points;
    const can = S.canUnlock(grid, nodeId, points);
    if (!can.ok) return can;
    const n = grid.nodes[nodeId];
    let gave = '';
    if (n.type === 'attr') {
        const stat = getStatSheet(name, isUser).find(x => x.id === n.stat);
        if (!stat || stat.kind !== 'attribute' || stat.enabled === false) return { ok: false, reason: `${String(n.stat).toUpperCase()} is switched off for this character.` };
        const cur = getCurrentStatValues(name, isUser)[n.stat];
        if (!(cur < stat.max)) return { ok: false, reason: `${stat.name} is already at its maximum.` };
        setCurrentStatValue(name, isUser, n.stat, Math.min(stat.max, cur + n.amount), { persist: false, silent: true });
        gave = `+${n.amount} ${String(n.stat).toUpperCase()}`;
    } else if (n.type === 'ability' || n.type === 'passive') {
        const finalName = uniqueAbilityName(name, isUser, n.name || 'Technique');
        const input = n.type === 'ability'
            ? { name: finalName, type: n.slot.kind, cost: n.slot.cost || null, icon: n.icon, desc: n.desc }
            : { name: finalName, type: 'ability', icon: n.icon, desc: n.desc, effects: S.passiveEffects(n) };
        const made = addAbility(name, isUser, input);
        if (made.error) return { ok: false, reason: made.error };
        if (n.type === 'ability') setActionProfile(name, isUser, n.slot.kind === 'spell' ? 'spell' : 'ability', finalName, n.slot.profile);
        n.learnedAs = finalName;
        gave = n.type === 'ability' ? `${n.slot.kind === 'spell' ? 'Spell' : 'Skill'}: ${finalName}` : `${finalName} (${S.describeNode(n)})`;
    } else {
        return { ok: false, reason: 'Nothing to unlock here.' };
    }
    if (!spendPointsOn(name, isUser, n.cost)) return { ok: false, reason: 'Not enough points.' };
    grid.unlocked.push(nodeId);
    saveGrid(name, isUser, grid);
    return { ok: true, node: { ...n }, gave };
}
