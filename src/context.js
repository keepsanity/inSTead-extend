/** Optional reference material for one revision. No main chat prompt is injected. */
import { getContext } from '../../../../extensions.js';
import { getCharacterCardFields, getMaxPromptTokens } from '../../../../../script.js';
import { getWorldInfoPrompt, world_info_include_names } from '../../../../world-info.js';
import { NOTE_MODULE_NAME } from '../../../../authors-note.js';

export function normalizeContextOptions(options = {}) {
    return {
        character: options?.character === true,
        lore: options?.lore === true,
        history: options?.history === true,
    };
}

/** Include every WI placement, including depth, examples, author's note and outlets. */
export function flattenLore(result) {
    return [
        result.worldInfoBefore, result.worldInfoAfter,
        ...(result.worldInfoExamples ?? []).map(entry => entry.content),
        ...(result.worldInfoDepth ?? []).flatMap(entry => entry.entries ?? []),
        ...(result.anBefore ?? []), ...(result.anAfter ?? []),
        ...Object.values(result.outletEntries ?? {}).flat(),
    ].filter(text => typeof text === 'string' && text.trim()).join('\n\n');
}

/** History ends before the target, even when revising an older message. */
export async function buildRevisionContext(messageId, sourceText, options = {}) {
    const selected = normalizeContextOptions(options);
    if (!Object.values(selected).some(Boolean)) return {};

    const context = getContext();
    const message = context.chat[messageId];
    if (!Number.isInteger(messageId) || messageId < 0 || !message) {
        throw new Error('That message is no longer available.');
    }
    const history = context.chat.slice(0, messageId).map(item => ({
        name: item.name ?? '',
        role: item.is_user ? 'user' : item.is_system ? 'system' : 'assistant',
        content: item.mes ?? '',
    }));
    const result = {};
    if (selected.history) result.history = history;

    if (selected.character || selected.lore) {
        // In groups, prefer the target speaker over the last active speaker.
        const speakerId = context.characters.findIndex(character =>
            character.avatar === message.original_avatar);
        const chid = speakerId >= 0 ? speakerId : context.characterId;
        const card = getCharacterCardFields({ chid });
        if (selected.character) {
            result.character = [
                ['Name', context.characters[chid]?.name],
                ['Description', card.description], ['Personality', card.personality],
                ['Scenario', card.scenario], ['Example dialogue', card.mesExamples],
            ].filter(([, value]) => value?.trim())
                .map(([label, value]) => `${label}:\n${value}`).join('\n\n');
        }
        if (selected.lore) {
            const scan = [...history, { name: message.name, content: sourceText }]
                .map(item => world_info_include_names ? `${item.name}: ${item.content}` : item.content)
                .reverse();
            // ST's WI scan can update Author's Note even in dry-run mode.
            const prompts = context.extensionPrompts;
            const note = prompts[NOTE_MODULE_NAME];
            const originalNote = note ? { ...note } : undefined;
            try {
                const lore = await getWorldInfoPrompt(scan, getMaxPromptTokens(), true, {
                    personaDescription: card.persona,
                    characterDescription: card.description,
                    characterPersonality: card.personality,
                    characterDepthPrompt: card.charDepthPrompt,
                    scenario: card.scenario,
                    creatorNotes: card.creatorNotes,
                    trigger: 'quiet',
                });
                result.lore = flattenLore(lore);
            } finally {
                if (originalNote) prompts[NOTE_MODULE_NAME] = originalNote;
                else delete prompts[NOTE_MODULE_NAME];
            }
        }
    }
    return result;
}
