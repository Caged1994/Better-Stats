/**
 * Sphere grid prompt — what the AI is asked to do for a character's grid.
 *
 * The program has already built the grid and decided what every spell, skill
 * and passive does. The AI only names them, gives each a sentence and an
 * emoji. Pure text building, so it can be tested outside the browser.
 */
import { clip, chatBlock } from './combatPrompts.js';
import { describeNode } from '../../utils/sphereModel.js';

const POWER_WORD = { light: 'weak', medium: 'solid', heavy: 'strong' };

function slotLine(n) {
    if (n.type === 'passive') return `${n.id}: passive skill, ${describeNode(n)}`;
    const p = n.slot.profile;
    const what = p.type === 'damage' ? `${POWER_WORD[p.power] || ''} ${p.target === 'enemies' ? 'attack on all enemies' : 'attack on one enemy'}${p.status ? ` that may cause ${p.status}` : ''}${p.stat && p.stat !== 'none' ? ` (${p.stat.toUpperCase()})` : ''}`
        : p.type === 'heal' ? `${POWER_WORD[p.power] || ''} healing of an ally`
        : p.type === 'status' ? `${p.target === 'enemy' ? 'puts a curse on an enemy' : 'gives a boon'}: ${p.status}`
        : p.type;
    return `${n.id}: ${n.slot.kind === 'spell' ? 'spell' : 'skill'}, ${what.trim()}`;
}

/**
 * @param {object} o
 * @param {object} o.grid
 * @param {string} o.character
 * @param {string} [o.description] - who they are
 * @param {string} [o.cardName]
 * @param {string} [o.cardDescription]
 * @param {Array<{name, text}>} [o.messages]
 * @param {string[]} [o.known] - what they already know (so names do not repeat)
 */
export function buildSphereDressingPrompt({ grid, character = '', description = '', cardName = '', cardDescription = '', messages = [], known = [] } = {}) {
    let sys = 'You are the game master of a roleplay, naming the abilities on a character\'s growth grid. A rules engine has already decided what each one does. You only give each a name, one sentence and one emoji. You never change what they do or write numbers. Reply with ONE JSON object and nothing else.\n\n';
    if (cardName || cardDescription) sys += `<setting>\n${cardName ? `Card: ${cardName}\n` : ''}${clip(cardDescription, 700)}\n</setting>\n\n`;
    if (messages.length) sys += `<recent_chat>\n${chatBlock(messages, 300, 900)}\n</recent_chat>\n\n`;
    const slots = Object.values(grid.nodes).filter(n => n.type === 'ability' || n.type === 'passive');
    let user = `Character: ${character}${description ? ` — ${clip(description, 300)}` : ''}\n`;
    if (grid.theme) user += `Flavour of the grid: ${clip(grid.theme, 250)}\n`;
    if (known.length) user += `Already known (do not reuse): ${known.slice(0, 20).join(', ')}\n`;
    user += `\nAbilities to name:\n${slots.map(slotLine).join('\n')}\n`;
    user += '\nReturn:\n{ "nodes": { "<id>": { "name": "up to 3 words", "description": "one short sentence", "icon": "one emoji" } } }\n';
    user += '\nRules:\n- An entry for EVERY id listed, all names different.\n- Fit who the character is and the setting. A spell sounds magical, a skill physical; stronger ones sound grander.\n- The kind and strength given are fixed: name what they say, not something else.\n- Names and sentences in the language of the chat.';
    return [{ role: 'system', content: sys.trim() }, { role: 'user', content: user.trim() }];
}
