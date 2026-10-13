/**
 * Dungeon prompts — what the AI is asked to do around a dungeon.
 *
 * The program has already laid the dungeon out (rooms, links, what each room
 * holds, how dangerous it is). The AI only:
 *   1. dresses it — a name and a sentence for each room, who the enemies are;
 *   2. labels, once, the spells, skills and items that have no combat profile
 *      (in the same request, so there is no extra call);
 *   3. tells the story of the expedition afterwards, from a record.
 *
 * Pure text building (no SillyTavern imports), so it can be tested outside
 * the browser.
 */
import { clip, chatBlock, labelRequestText } from './combatPrompts.js';
import { TIERS, STATUS_IDS, POWERS } from '../../utils/combatModel.js';
import { ROOM_TYPES } from '../../utils/dungeonModel.js';

/** The rooms as a compact list the AI can answer by id. */
export function structureText(state) {
    return state.floors.map(f => {
        const rooms = Object.values(f.rooms).map(r => {
            const t = ROOM_TYPES[r.type]?.label.toLowerCase() || r.type;
            const slots = (r.type === 'combat' || r.type === 'boss') && r.enemies?.length ? ` [${r.enemies.map(e => e.tier).join(', ')}]` : '';
            return ` ${r.id} ${t}${slots}`;
        });
        return `${f.index === 0 && state.floors.length === 1 ? 'Floor' : `Floor ${f.index + 1}`} (${f.rooms[f.start] ? 'entrance ' + f.start : ''}):\n${rooms.join('\n')}`;
    }).join('\n');
}

/**
 * @param {object} o
 * @param {object} o.state - the dungeon (structure built)
 * @param {Array<{name, level, isUser}>} o.party
 * @param {string} [o.player]
 * @param {string} [o.cardName]
 * @param {string} [o.cardDescription]
 * @param {Array<{name, text}>} [o.messages]
 * @param {Array<{key, kind, name, desc, effects, cost}>} [o.toLabel]
 * @returns {Array<{role, content}>}
 */
export function buildDungeonDressingPrompt({ state, party = [], player = '', cardName = '', cardDescription = '', messages = [], toLabel = [] } = {}) {
    const partyLevel = party.length ? Math.round(party.reduce((s, p) => s + (p.level || 1), 0) / party.length) : 1;
    let sys = `You are the game master of a roleplay, giving a look to a dungeon that a rules engine has already laid out. You only name the rooms, describe each in one sentence, and say who the enemies are. You never change the layout, add or remove rooms, or write numbers. Reply with ONE JSON object and nothing else.\n\n`;
    if (cardName || cardDescription) sys += `<setting>\n${cardName ? `Card: ${cardName}\n` : ''}${clip(cardDescription, 700)}\n</setting>\n\n`;
    sys += `<party>\n${party.map(p => `${p.name}${p.isUser ? ` (the player, ${player})` : ''} — level ${p.level || 1}`).join('\n') || player}\n</party>\n\n`;
    if (messages.length) sys += `<recent_chat>\n${chatBlock(messages, 350, 1200)}\n</recent_chat>\n\n`;

    const theme = (state.theme || '').trim();
    let user = `Party level about ${partyLevel}, ${party.length} fighter${party.length === 1 ? '' : 's'}.\n`;
    user += theme ? `The dungeon: ${clip(theme, 300)}\n` : `Choose a dungeon that fits the story so far (a place the party could plausibly go into).\n`;
    user += `Floors: ${state.floors.length}.\n\nThe layout (room id, kind; in brackets, the category of each enemy):\n${structureText(state)}\n`;
    user += `\nReturn:\n{\n  "title": "name of the dungeon",\n  "floors": [{"name": "…"}],\n  "rooms": {\n    "<room id>": {"name": "up to 4 words", "description": "one sentence"},\n    "<enemy room id>": {"name": "…", "description": "…", "enemies": [{"name": "…", "icon": "one emoji", "description": "one short line", "focus": "str|dex|con|int|wis|cha", "attacks": [{"name": "…", "power": "${POWERS.join('|')}", "stat": "str|dex|int|wis|cha", "status": "optional: ${STATUS_IDS.join('|')}"}]}]},\n    "<trap room id>": {"name": "…", "description": "…", "trap": "what the trap is, a few words"},\n    "<treasure room id>": {"name": "…", "description": "…", "items": ["optional: one ordinary item"]}\n  }${toLabel.length ? ',\n  "profiles": { "<key>": {"type": "…", "power": "…", "stat": "…", "target": "…", "status": "…"} }' : ''}\n}\n`;
    user += `\nRules:\n- Give an entry for EVERY room id listed. Keep every description to one sentence, in the language of the chat.\n- For an enemy room give exactly as many enemies as there are categories in the brackets, in the same order. The category (${TIERS.join(', ')}) says how dangerous each is and cannot be changed: a minion is weak, a boss is a real threat. Names fit the dungeon and are all different. 1 or 2 attacks each, with a name that suits the enemy. No hit points, damage or other numbers.\n- Everything must be consistent with the dungeon's theme and with itself (one dungeon, one place).\n`;
    user += labelRequestText(toLabel);
    return [{ role: 'system', content: sys.trim() }, { role: 'user', content: user.trim() }];
}

/**
 * The request that tells the story of a finished expedition.
 * @param {object} o
 * @param {object} o.summary - dungeonModel.summarizeForNarration()
 */
export function buildDungeonNarrationPrompt({ summary, player = '', messages = [], cardName = '', cardDescription = '' } = {}) {
    let sys = `You are narrating the aftermath of an expedition into a dungeon in an ongoing roleplay. Write in the voice and tense of the story so far, in the same language as the recent chat.\n\n`;
    if (cardName || cardDescription) sys += `<setting>\n${cardName ? `Card: ${cardName}\n` : ''}${clip(cardDescription, 700)}\n</setting>\n\n`;
    if (messages.length) sys += `<recent_chat>\n${chatBlock(messages, 400, 800)}\n</recent_chat>\n\n`;
    const s = summary || {};
    const outcome = { cleared: 'The party reached the end and overcame what was there.', left: 'The party turned back and left the dungeon.', defeated: 'The party was beaten and driven out.' }[s.result] || 'The expedition ended.';
    let user = `The expedition into "${s.title || 'the dungeon'}" is over. ${outcome}\n\nRecord (facts, do not contradict them):\n`;
    user += `Party: ${(s.party || []).join(', ') || player}\n`;
    user += `Explored ${s.rooms || '?'} rooms over ${s.floorsReached || 1} floor${(s.floorsReached || 1) === 1 ? '' : 's'}; ${s.fights || 0} fight${s.fights === 1 ? '' : 's'}; ${s.trapsMet || 0} trap${s.trapsMet === 1 ? '' : 's'} (${s.trapsFailed || 0} sprung); ${s.chests || 0} chest${s.chests === 1 ? '' : 's'} opened.\n`;
    if (s.highlights?.length) user += `Key moments:\n${s.highlights.map(h => `- ${h}`).join('\n')}\n`;
    if (s.money || s.items?.length) user += `Found: ${[s.items?.length ? s.items.join(', ') : '', s.money ? `${s.money} money` : ''].filter(Boolean).join(' and ')}.\n`;
    user += `\nWrite 1 to 3 short paragraphs about how the expedition went and how it ended, following the record. Do not decide what ${player || 'the player'} thinks, says or does next, and do not repeat the record as a list or add statistics. End where the story can pick up.`;
    return [{ role: 'system', content: sys.trim() }, { role: 'user', content: user.trim() }];
}
