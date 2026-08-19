/**
 * Settings store: defaults, persistence, migrations and the rule accessors.
 */

import { getContext, extension_settings } from '../../../../extensions.js';
import { uuidv4 } from '../../../../utils.js';

export const EXTENSION_NAME = 'inSTead';

/** Path renderExtensionTemplateAsync expects for this extension's templates. */
export const TEMPLATE_PATH = 'third-party/inSTead';

/**
 * Matches a status/info block pinned to the end of a message: either an explicit
 * <infoblock> wrapper or a trailing <details> element. The negative lookahead stops
 * a match from swallowing an earlier <details> that appears inside the prose.
 */
export const DEFAULT_BLOCK_REGEX = '(?:<infoblock>[\\s\\S]*?<\\/infoblock>|<details>(?:(?!<details>)[\\s\\S])*?<\\/details>)\\s*$';

export const defaultSettings = {
    /** Connection profile used for revisions. Empty = whatever Connection Manager has selected. */
    profileId: '',
    maxTokens: 2048,
    /** Hold the trailing info block back from the model and re-attach it afterwards */
    preserveBlock: true,
    blockRegex: DEFAULT_BLOCK_REGEX,
    /** @type {Rule[]} Applied to every character */
    rules: [],
    /** @type {Record<string, Rule[]>} Keyed by character avatar filename */
    characterRules: {},
};

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} text The constraint, in the user's own words
 * @property {boolean} enabled Pre-checked in the revision popup
 */

/** @returns {typeof defaultSettings} */
export function getSettings() {
    return extension_settings.instead;
}

export function loadSettings() {
    // structuredClone, not a plain spread: a shallow copy of defaultSettings hands
    // every profile the *same* `rules` array and `characterRules` object that live
    // on the module-level defaults, so the first rule anyone adds would be pushed
    // into the defaults and then inherited by every other profile that loads later.
    const saved = extension_settings.instead ?? {};
    extension_settings.instead = Object.assign(structuredClone(defaultSettings), saved);
    const settings = extension_settings.instead;

    // Settings written by older versions may be missing the rule stores entirely.
    if (!Array.isArray(settings.rules)) {
        settings.rules = [];
    }
    if (!settings.characterRules || typeof settings.characterRules !== 'object') {
        settings.characterRules = {};
    }

    migrateRules(settings.rules);
    for (const rules of Object.values(settings.characterRules)) {
        if (Array.isArray(rules)) {
            migrateRules(rules);
        }
    }
}

/**
 * Rules used to be split into a forbid/instead pair. Fold any of those into the
 * single free-text field so nothing the user wrote is lost.
 * @param {Rule[]} rules
 */
function migrateRules(rules) {
    for (const rule of rules) {
        if (typeof rule.text === 'string') {
            continue;
        }
        const forbid = (rule.forbid ?? '').trim();
        const instead = (rule.instead ?? '').trim();
        rule.text = [forbid, instead].filter(Boolean).join(' → ');
        delete rule.forbid;
        delete rule.instead;
    }
}

export function createRule() {
    return {
        // Not crypto.randomUUID(): that only exists in a secure context, so it is
        // undefined whenever SillyTavern is reached over plain HTTP on a LAN address.
        id: uuidv4(),
        text: '',
        enabled: true,
    };
}

/**
 * The avatar filename identifies a character across renames. Returns null in group
 * chats, where `characterId` points at whichever member spoke last and cannot be
 * trusted as "the" character.
 * @returns {string|null}
 */
export function getCurrentCharacterKey() {
    const context = getContext();
    if (context.groupId) {
        return null;
    }
    if (context.characterId === undefined || context.characterId === null) {
        return null;
    }
    return context.characters[context.characterId]?.avatar ?? null;
}

/**
 * @param {string} key Character avatar filename
 * @returns {Rule[]}
 */
export function getCharacterRules(key) {
    if (!key) {
        return [];
    }
    const store = getSettings().characterRules;
    if (!Array.isArray(store[key])) {
        store[key] = [];
    }
    return store[key];
}

/**
 * Every rule that applies to the chat on screen, global first.
 * @returns {Rule[]}
 */
export function getApplicableRules() {
    const characterKey = getCurrentCharacterKey();
    return [
        ...getSettings().rules,
        ...(characterKey ? getCharacterRules(characterKey) : []),
    ].filter(rule => rule.text?.trim());
}
