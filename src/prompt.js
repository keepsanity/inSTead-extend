/**
 * Prompt construction and passage handling.
 *
 * Everything sent to the model in this file stays in English no matter what the
 * UI language is. Models follow English instructions more reliably, and the
 * passage itself already carries the language of the chat — the system prompt
 * tells the model to preserve it.
 */

import { EXTENSION_NAME, getSettings } from './settings.js';

/**
 * Separate the trailing status/info block from the prose.
 *
 * Asking the model to reproduce the block never works reliably — it rewrites it,
 * reformats it, or drops it. Holding it back entirely is the only way to guarantee
 * it survives byte for byte, and it saves the tokens too.
 *
 * @param {string} text
 * @returns {{ body: string, block: string }}
 */
export function splitTrailingBlock(text) {
    const settings = getSettings();
    if (!settings.preserveBlock || !settings.blockRegex) {
        return { body: text, block: '' };
    }

    let regex;
    try {
        regex = new RegExp(settings.blockRegex);
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] Invalid block regex, ignoring:`, error);
        return { body: text, block: '' };
    }

    const match = regex.exec(text);
    if (!match) {
        return { body: text, block: '' };
    }

    const body = text.slice(0, match.index).trimEnd();

    // A match that covers the whole message leaves nothing to revise.
    if (!body) {
        return { body: text, block: '' };
    }

    return { body, block: text.slice(match.index).trim() };
}

/**
 * Render the ticked rules as a numbered constraint list, in whatever words the
 * user wrote them.
 * @param {import('./settings.js').Rule[]} rules
 */
function renderRules(rules) {
    if (!rules.length) {
        return '';
    }

    return [
        '## Standing constraints',
        'The rewrite must satisfy every constraint below.',
        ...rules.map((rule, index) => `${index + 1}. ${rule.text.trim()}`),
        '',
    ].join('\n');
}

/**
 * Build the messages sent to the model.
 *
 * Note that this deliberately does NOT go through generateQuietPrompt: that would
 * drag the main chat preset's system prompt along, and those instructions routinely
 * outweigh the revision instructions. Here the editorial rules are the only rules.
 *
 * @param {string} sourceText Passage to rewrite, info block already stripped
 * @param {string} feedback One-off instructions from the popup
 * @param {import('./settings.js').Rule[]} rules Standing rules ticked for this run
 */
export function buildRevisionMessages(sourceText, feedback, rules) {
    const system = [
        'You are a line editor. You rewrite a single passage so that it satisfies the editorial instructions you are given.',
        '',
        'Output rules:',
        '- Output ONLY the rewritten passage.',
        '- Never add a preamble, a summary, notes, or any commentary about the changes you made.',
        '- Never wrap the output in quotation marks or code fences.',
        '- Do not carry the story past the point where the original passage ends. No new events, no new scenes.',
        '- Preserve the narrator, tense, point of view, language and formatting conventions of the original.',
        '- Keep roughly the same length unless the instructions ask for a different one.',
        '',
        'When an instruction only says what to avoid, do not simply delete the offending',
        'text: replace it with the most natural alternative for the surrounding passage.',
        'Deleting leaves a hole; substituting is what the instruction is actually asking for.',
    ].join('\n');

    const user = [
        renderRules(rules),
        '## Passage to rewrite',
        '<passage>',
        sourceText,
        '</passage>',
        '',
        ...(feedback ? ['## Notes for this revision', feedback, ''] : []),
        'Rewrite the passage now. Output the rewritten passage only.',
    ].filter(Boolean).join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}
