/**
 * Automatic consequences — low stat bars bring conditions by themselves.
 *
 * After any change to the current stat values (AI reply, a value edited in
 * the panel, a reset, a swipe), every character in the scene gets the
 * conditions their bars call for — Hungry, Exhausted, Badly wounded… — and
 * loses the ones their bars no longer do. Those conditions are marked 'auto':
 * the AI is told not to touch them, and the panel shows which bar they
 * follow. Rules and thresholds are in src/utils/consequenceModel.js.
 *
 * Only bars that are switched on count; switching the feature off (Settings
 * → RPG & Stats) removes every automatic condition in the scene.
 */
import { extensionSettings } from '../../core/state.js';
import { saveSettings } from '../../core/persistence.js';
import { saveChatScope } from './chatScope.js';
import {
    setStatValuesHook,
    getStatCharacters,
    getStatSheet,
    getCurrentStatValues,
    isCharacterStatsEnabled,
    isStatGenerationPending,
    notifyStatsChanged,
} from './characterStats.js';
import { isConditionsEnabled, syncAutoConditions, activeAutoConditions } from './characterConditions.js';
import { activeStats } from '../../utils/statsModel.js';
import { CONSEQUENCE_RULES, desiredConsequences } from '../../utils/consequenceModel.js';

export function isConsequencesEnabled() {
    return isCharacterStatsEnabled() && isConditionsEnabled() && extensionSettings.autoConsequences !== false;
}

export function setConsequencesEnabled(on) {
    extensionSettings.autoConsequences = !!on;
    saveSettings();
    syncAllConsequences();
    notifyStatsChanged({ source: 'settings' });
}

/** The rules that apply to one character right now. */
export function consequencesFor(name, isUser) {
    if (!isConsequencesEnabled() || isStatGenerationPending(name, isUser)) return [];
    const bars = activeStats(getStatSheet(name, isUser)).filter(s => s.kind === 'state');
    const cur = getCurrentStatValues(name, isUser, bars);
    const values = {};
    for (const s of bars) values[s.id] = cur[s.id];
    const active = {};
    for (const id of activeAutoConditions(name, isUser)) {
        const r = CONSEQUENCE_RULES.find(x => x.id === id);
        if (r) active[r.stat] = r.id;
    }
    return desiredConsequences(values, active);
}

let running = false;

/**
 * Brings every character in the scene in line with their bars. With the
 * feature off, removes the automatic conditions instead. Returns how many
 * characters changed.
 */
export function syncAllConsequences() {
    if (running) return 0;
    running = true;
    let n = 0;
    try {
        for (const { name, isUser } of getStatCharacters()) {
            const rules = consequencesFor(name, isUser);
            if (syncAutoConditions(name, isUser, rules)) n++;
        }
        if (n) {
            saveChatScope();
            notifyStatsChanged({ source: 'consequences' });
        }
    } finally {
        running = false;
    }
    return n;
}

// Runs after every change to current stat values (see characterStats.js).
setStatValuesHook(syncAllConsequences);
