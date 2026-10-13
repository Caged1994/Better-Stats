/**
 * Combat prompts — what the AI is asked to do around a fight.
 *
 * It does three things and never computes anything:
 *   1. invents the enemies (name, look, category, what they can do, loot);
 *   2. labels, once, the spells, skills and items that have no combat
 *      profile yet (what they do and how strong they are);
 *   3. tells the story of the fight afterwards, from a record of what
 *      happened.
 * The numbers — hit points, damage, odds — are worked out by
 * src/utils/combatModel.js.
 *
 * Pure text building: no SillyTavern imports, so it can be tested outside
 * the browser. The caller passes in the context it gathered.
 */
import { TIERS, STATUS_IDS, POWERS } from '../../utils/combatModel.js';

export const clip = (text, max) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
};

/** The last message is the freshest and is given room; older ones are shortened. */
export function chatBlock(messages, perMessage = 700, lastMessage = 2200) {
    const list = messages || [];
    const lines = list.map((m, i) => `${m.name ? m.name + ': ' : ''}${clip(m.text, i === list.length - 1 ? lastMessage : perMessage)}`).filter(Boolean);
    return lines.length ? lines.join('\n') : '(no messages yet)';
}

/**
 * The part of a request that asks the AI to label spells, skills and items
 * that have no combat profile yet ("" when there is nothing to label).
 * @param {Array<{key, kind, name, desc, effects, cost}>} toLabel
 */
export function labelRequestText(toLabel = []) {
    if (!toLabel.length) return '';
    let user = `\nLabel these actions in "profiles", using the key given. For each: "type" is damage, heal, status (grants or inflicts a status), mana (restores Mana), cure (removes bad statuses), revive (raises a fallen ally), gear (a weapon or armour; give "atk" and "def" from 0 to 12) or none (passive, a key, food, anything useless in a fight). "power" is ${POWERS.join(', ')}. "stat" is the attribute it scales with (str, dex, con, int, wis, cha) or "none" for fixed effects like potions. "target" is enemy, enemies, ally, allies or self. "status" is ${STATUS_IDS.join(', ')} when it inflicts or grants one.\n`;
    user += toLabel.map(a => `- ${a.key}: ${a.kind} "${a.name}"${a.desc ? ` — ${clip(a.desc, 100)}` : ''}${a.cost ? ` (cost: ${a.cost})` : ''}${a.effects ? ` [bonus ${a.effects}]` : ''}`).join('\n') + '\n';
    return user;
}

/**
 * The request that creates the enemies and labels unlabelled actions.
 * @param {object} o
 * @param {string} o.player - the player's character
 * @param {Array<{name, level, isUser}>} o.party
 * @param {string} [o.situation] - what the player wrote ("three bandits")
 * @param {string} [o.scene] - location / description of the scene
 * @param {string} [o.cardName] - the character card, for context
 * @param {string} [o.cardDescription]
 * @param {Array<{name, text}>} o.messages - recent chat
 * @param {Array<{name, text}>} [o.present] - characters the tracker lists as in the scene, with what it says about them
 * @param {string} [o.currency] - the story's money, for loot amounts
 * @param {Array<{key, owner, kind, name, desc, effects, cost}>} [o.toLabel] - actions without a profile
 * @returns {Array<{role, content}>}
 */
export function buildEncounterSetupPrompt({ player, party = [], situation = '', scene = '', cardName = '', cardDescription = '', messages = [], present = [], currency = '', toLabel = [] } = {}) {
    const partyLevel = party.length ? Math.round(party.reduce((s, p) => s + (p.level || 1), 0) / party.length) : 1;
    let sys = `You are the game master preparing a turn-based fight for a roleplay. A separate rules engine will work out all numbers, so you only describe who the enemies are and what they can do. Reply with ONE JSON object and nothing else.\n\n`;
    if (cardName || cardDescription) sys += `<setting>\n${cardName ? `Card: ${cardName}\n` : ''}${clip(cardDescription, 900)}\n</setting>\n\n`;
    sys += `<party>\n${party.map(p => `${p.name}${p.isUser ? ` (the player, ${player})` : ''} — level ${p.level || 1}`).join('\n') || player}\n</party>\n\n`;
    sys += `<recent_chat>\n${chatBlock(messages)}\n</recent_chat>\n\n`;
    if (present.length) sys += `<characters_in_scene>\nThe scene tracker lists these characters as present, with what it says about them (the enemies are often among them):\n${present.map(c => `- ${c.name}${c.text ? `: ${clip(c.text, 400)}` : ''}`).join('\n')}\n</characters_in_scene>\n\n`;
    if (scene) sys += `Where it happens: ${clip(scene, 300)}\n\n`;

    let user = `The fight starts now. Party level about ${partyLevel}, ${party.length} fighter${party.length === 1 ? '' : 's'}.\n`;
    user += situation.trim()
        ? `The player says the enemies are: ${clip(situation, 400)}\n`
        : `Work out from the recent chat who the party is fighting.\n`;
    user += `\nReturn:\n{\n  "environment": "one short sentence about the place",\n  "enemies": [\n    {"name": "…", "icon": "one emoji", "description": "one short line that keeps what the story says about them", "tier": "${TIERS.join('|')}", "levelDelta": 0, "focus": "str|dex|con|int|wis|cha", "attacks": [{"name": "…", "power": "${POWERS.join('|')}", "stat": "str|dex|int|wis|cha", "status": "optional: ${STATUS_IDS.join('|')}"}], "loot": {"money": 0, "items": ["optional short names"]}}\n  ]${toLabel.length ? ',\n  "profiles": { "<key>": {"type": "…", "power": "…", "stat": "…", "target": "…", "status": "…"} }' : ''}\n}\n`;
    user += `\nRules for the enemies:\n- 1 to 6 enemies that fit the scene. If the player's words, the latest message or the scene list already say who the enemies are, use exactly those: the same number, the same names, the same sex, age and look. Never rename them, add or drop any, or change what they are. Only invent what is not said.
- An enemy that has no name in the story gets a plain label ("Bandit 1", "Bandit 2"…) in the language of the chat, not an invented name. Enemies you add yourself may have a name that fits.\n- tier says how dangerous each is: minion (weak, one of a crowd), normal, elite (clearly stronger), boss (rare, a real threat). Most fights are minions and normals. levelDelta is −2…+3 against the party.\n- 1 to 3 attacks each, with a name that suits the enemy. Do not write any hit points, damage or other numbers.\n- loot is optional and small: money in ${currency || 'the story\'s currency'} (a plausible pocketful, not a fortune) and at most one or two ordinary items.\n`;
    user += labelRequestText(toLabel);
    return [{ role: 'system', content: sys.trim() }, { role: 'user', content: user.trim() }];
}

/**
 * The request that tells the story of a finished fight.
 * @param {object} o
 * @param {object} o.summary - combatModel.summarizeForNarration()
 * @param {string} o.player
 * @param {Array<{name, text}>} o.messages - recent chat before the fight
 * @param {string} [o.cardName]
 * @param {string} [o.cardDescription]
 * @returns {Array<{role, content}>}
 */
export function buildCombatNarrationPrompt({ summary, player, messages = [], cardName = '', cardDescription = '' } = {}) {
    let sys = `You are narrating the aftermath of a fight in an ongoing roleplay. Write in the voice and tense of the story so far, in the same language as the recent chat.\n\n`;
    if (cardName || cardDescription) sys += `<setting>\n${cardName ? `Card: ${cardName}\n` : ''}${clip(cardDescription, 900)}\n</setting>\n\n`;
    sys += `<recent_chat>\n${chatBlock(messages, 500)}\n</recent_chat>\n\n`;
    const s = summary || {};
    const outcome = { victory: 'The party won.', defeat: 'The party was beaten.', fled: 'The party got away.' }[s.result] || 'The fight ended.';
    let user = `A fight just ended. ${outcome} It lasted ${s.rounds || 1} round${s.rounds === 1 ? '' : 's'}${s.environment ? ` (${clip(s.environment, 120)})` : ''}.\n\n`;
    user += `Record (facts, do not contradict them):\n`;
    user += `Party: ${(s.party || []).map(p => `${p.name} ${p.down ? 'knocked out' : `at ${p.hp} HP`}`).join('; ') || player}\n`;
    user += `Enemies: ${(s.enemies || []).map(e => `${e.name} ${e.defeated ? 'defeated' : 'still standing'}`).join('; ') || 'none'}\n`;
    if (s.highlights?.length) user += `Key moments:\n${s.highlights.map(h => `- ${h}`).join('\n')}\n`;
    if (s.rewards && (s.rewards.xp || s.rewards.money || s.rewards.items?.length)) {
        user += `Spoils: ${[s.rewards.items?.length ? s.rewards.items.join(', ') : '', s.rewards.money ? `${s.rewards.money} money` : ''].filter(Boolean).join(' and ') || 'nothing of note'}.\n`;
    }
    user += `\nWrite 1 to 3 short paragraphs describing how the fight played out and how it ended, following the record. Do not decide what ${player} thinks, says or does next, and do not repeat the record as a list or add statistics. End where the story can pick up.`;
    return [{ role: 'system', content: sys.trim() }, { role: 'user', content: user.trim() }];
}
