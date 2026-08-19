/**
 * inSTead - SillyTavern Extension
 * Adds editorial feedback capability to character messages
 */

// Third-party extensions are at /scripts/extensions/third-party/[name]/
// So we need to go up 4 levels to reach /scripts/ for script.js
// And 3 levels up to reach /scripts/ then extensions.js for extensions.js
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, saveChatConditional, reloadCurrentChat, saveSettingsDebounced, deleteSwipe } from '../../../../script.js';

const EXTENSION_NAME = 'inSTead';
const TEMPLATE_PATH = 'third-party/inSTead';

/**
 * Matches a status/info block pinned to the end of a message: either an explicit
 * <infoblock> wrapper or a trailing <details> element. The negative lookahead stops
 * a match from swallowing an earlier <details> that appears inside the prose.
 */
const DEFAULT_BLOCK_REGEX = '(?:<infoblock>[\\s\\S]*?<\\/infoblock>|<details>(?:(?!<details>)[\\s\\S])*?<\\/details>)\\s*$';

const defaultSettings = {
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
 * @property {string} forbid What the model should stop doing
 * @property {string} instead What it should do in its place
 * @property {boolean} enabled Pre-checked in the revision popup
 */

let isProcessing = false;

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The avatar filename identifies a character across renames. Returns null in group
 * chats, where `characterId` points at whichever member spoke last and cannot be
 * trusted as "the" character.
 * @returns {string|null}
 */
function getCurrentCharacterKey() {
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
function getCharacterRules(key) {
    if (!key) {
        return [];
    }
    const store = extension_settings.instead.characterRules;
    if (!Array.isArray(store[key])) {
        store[key] = [];
    }
    return store[key];
}

/**
 * Every rule that applies to the chat on screen, global first.
 * @returns {Rule[]}
 */
function getApplicableRules() {
    const characterKey = getCurrentCharacterKey();
    return [
        ...extension_settings.instead.rules,
        ...(characterKey ? getCharacterRules(characterKey) : []),
    ].filter(rule => rule.forbid?.trim());
}

function createRule() {
    return {
        id: crypto.randomUUID(),
        forbid: '',
        instead: '',
        enabled: true,
    };
}

/* -------------------------------------------------------------------------- */
/* Message buttons                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Add feedback icon to a specific message
 */
function addFeedbackIconToMessage(messageId) {
    try {
        // Validate messageId
        if (messageId === null || messageId === undefined || isNaN(messageId) || messageId < 0) {
            return;
        }

        const context = getContext();
        const chat = context.chat;
        if (!chat || !Array.isArray(chat) || messageId >= chat.length) {
            return;
        }

        const message = chat[messageId];
        if (!message) {
            return;
        }

        // Only add to character messages (not user messages)
        if (message.is_user) {
            return;
        }

        const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (!messageElement) {
            return;
        }

        // Check if icon already exists
        if (messageElement.querySelector('.instead-feedback-icon')) {
            return;
        }

        // Find the message buttons container - try extraMesButtons first, then mes_buttons
        let buttonsContainer = messageElement.querySelector('.extraMesButtons');
        if (!buttonsContainer) {
            buttonsContainer = messageElement.querySelector('.mes_buttons');
        }
        if (!buttonsContainer) {
            console.debug(`[${EXTENSION_NAME}] No buttons container found for message ${messageId}`);
            return;
        }

        // Create feedback icon button.
        // Match ST's native markup: the icon classes live on the button div itself,
        // not on a nested <i>, so it sizes and aligns like its siblings.
        const feedbackButton = document.createElement('div');
        feedbackButton.className = 'mes_button instead-feedback-icon fa-solid fa-arrows-rotate interactable';
        feedbackButton.title = 'Request revision with feedback';
        feedbackButton.setAttribute('data-mesid', messageId);
        feedbackButton.tabIndex = 0;

        // Append at the end, after the native buttons (Copy is normally last)
        buttonsContainer.appendChild(feedbackButton);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error adding feedback icon to message ${messageId}:`, error);
    }
}

/**
 * Add feedback icons to all character messages
 */
function addFeedbackIconsToMessages() {
    const context = getContext();
    if (!context.chat || !Array.isArray(context.chat) || context.chat.length === 0) {
        return;
    }

    const messages = document.querySelectorAll('.mes');
    messages.forEach((messageElement) => {
        const mesidAttr = messageElement.getAttribute('mesid');
        if (mesidAttr !== null && mesidAttr !== '') {
            const messageId = parseInt(mesidAttr, 10);
            if (!isNaN(messageId) && messageId >= 0) {
                addFeedbackIconToMessage(messageId);
            }
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Revision popup                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Get the revision metadata stored on the currently displayed swipe, if any.
 * Returns null when the current swipe was not produced by this extension.
 */
function getRevisionForCurrentSwipe(message) {
    if (!message) {
        return null;
    }

    // When swipes exist, the swipe entry is the only source of truth. message.extra
    // keeps the last revision's fields even after swiping back to the original, so
    // falling back to it here would report a revision that is not on screen.
    const hasSwipeInfo = Array.isArray(message.swipe_info) && message.swipe_id !== undefined;
    const extra = hasSwipeInfo ? message.swipe_info[message.swipe_id]?.extra : message.extra;

    if (!extra?.instead_feedback) {
        return null;
    }

    return {
        feedback: extra.instead_feedback,
        source: extra.instead_source ?? null,
        ruleIds: Array.isArray(extra.instead_rules) ? extra.instead_rules : null,
    };
}

/**
 * Checkbox list of the rules that apply here.
 * @param {Rule[]} rules
 * @param {string[]|null} preselected Rule ids to tick instead of the saved defaults
 */
function renderRulePicker(rules, preselected) {
    if (!rules.length) {
        return '';
    }

    const items = rules.map(rule => {
        const checked = preselected ? preselected.includes(rule.id) : rule.enabled;
        const instead = rule.instead?.trim()
            ? `<span class="instead-rule-pick-instead">→ ${escapeHtml(rule.instead)}</span>`
            : '';
        return `
            <label class="instead-rule-pick">
                <input type="checkbox" data-rule-id="${escapeHtml(rule.id)}"${checked ? ' checked' : ''}>
                <span class="instead-rule-pick-text">
                    <span class="instead-rule-pick-forbid">${escapeHtml(rule.forbid)}</span>
                    ${instead}
                </span>
            </label>
        `;
    }).join('');

    return `
        <div class="instead-rules-picker">
            <div class="instead-rules-picker-title">Standing rules</div>
            ${items}
        </div>
    `;
}

/**
 * Show feedback popup dialog
 */
function showFeedbackPopup(messageId) {
    if (isProcessing) {
        toastr.warning('Please wait for the current revision to complete.');
        return;
    }

    const context = getContext();
    const message = context.chat[messageId];

    // If the swipe on screen is itself an inSTead revision, this is a retry:
    // pre-fill the previous feedback and rewrite from the passage it was based on.
    const previous = getRevisionForCurrentSwipe(message);
    const sourceText = previous?.source ?? message.mes;
    const rules = getApplicableRules();

    const popupHtml = `
        <div class="instead-popup-overlay">
            <div class="instead-popup-container">
                <div class="instead-popup-header">
                    <h3>${previous ? 'Revise again' : 'Feedback to the current message:'}</h3>
                    <button class="instead-popup-close">&times;</button>
                </div>
                <div class="instead-popup-body">
                    <div class="instead-original-message">
                        <strong>${previous ? 'Rewriting from:' : 'Original message:'}</strong>
                        <div class="instead-message-preview">${escapeHtml(sourceText)}</div>
                    </div>
                    ${renderRulePicker(rules, previous?.ruleIds ?? null)}
                    <textarea
                        class="instead-feedback-input text_pole"
                        placeholder="Enter your editorial feedback here..."
                        rows="6"
                    >${escapeHtml(previous?.feedback ?? '')}</textarea>
                </div>
                <div class="instead-popup-footer">
                    <button class="instead-cancel-btn menu_button">Cancel</button>
                    ${previous ? '<button class="instead-replace-btn menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i>Replace</button>' : ''}
                    <button class="instead-send-btn menu_button menu_button_icon">
                        <i class="fa-solid fa-paper-plane"></i>
                        ${previous ? 'Add swipe' : 'Send'}
                    </button>
                </div>
            </div>
        </div>
    `;

    // Add popup to page
    const popupElement = document.createElement('div');
    popupElement.innerHTML = popupHtml;
    document.body.appendChild(popupElement.firstElementChild);

    const popup = document.querySelector('.instead-popup-overlay');
    const feedbackInput = popup.querySelector('.instead-feedback-input');
    const sendBtn = popup.querySelector('.instead-send-btn');
    const replaceBtn = popup.querySelector('.instead-replace-btn');
    const cancelBtn = popup.querySelector('.instead-cancel-btn');
    const closeBtn = popup.querySelector('.instead-popup-close');

    // Focus on textarea
    setTimeout(() => feedbackInput.focus(), 100);

    // Close handlers
    const closePopup = () => {
        popup.remove();
    };

    closeBtn.addEventListener('click', closePopup);
    cancelBtn.addEventListener('click', closePopup);
    popup.addEventListener('click', (e) => {
        if (e.target === popup) closePopup();
    });

    /**
     * @param {boolean} replaceCurrentSwipe Drop the swipe on screen before generating
     */
    const submit = async (replaceCurrentSwipe) => {
        const feedback = feedbackInput.value.trim();
        const checkedIds = [...popup.querySelectorAll('.instead-rule-pick input:checked')]
            .map(input => input.dataset.ruleId);
        const selectedRules = rules.filter(rule => checkedIds.includes(rule.id));

        if (!feedback && !selectedRules.length) {
            toastr.warning('Enter some feedback or tick at least one rule.');
            return;
        }

        closePopup();
        await processRevisionRequest(messageId, feedback, sourceText, selectedRules, replaceCurrentSwipe);
    };

    sendBtn.addEventListener('click', () => submit(false));
    replaceBtn?.addEventListener('click', () => submit(true));

    // Allow Enter key with Ctrl/Cmd to send
    feedbackInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            // Prevent SillyTavern's global Ctrl+Enter handler from firing
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            submit(Boolean(replaceBtn));
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

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
function splitTrailingBlock(text) {
    const settings = extension_settings.instead;
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
 * Process the revision request with user feedback
 * @param {number} messageId Message being revised
 * @param {string} feedback Editorial instructions from the user
 * @param {string} sourceText The passage to rewrite
 * @param {Rule[]} rules Standing rules ticked for this revision
 * @param {boolean} replaceCurrentSwipe Delete the swipe on screen first
 */
async function processRevisionRequest(messageId, feedback, sourceText, rules, replaceCurrentSwipe) {
    if (isProcessing) return;

    isProcessing = true;

    try {
        toastr.info('Generating revision with your feedback...');

        // The info block never reaches the model; it is stitched back on afterwards.
        const { body, block } = splitTrailingBlock(sourceText);
        const revisedBody = await generateRevision(body, feedback, rules);

        if (!revisedBody) {
            toastr.error('Failed to generate revision.');
            return;
        }

        const revisedText = block ? `${revisedBody}\n\n${block}` : revisedBody;

        // Only drop the old swipe once we know we have something to put in its place.
        if (replaceCurrentSwipe) {
            const message = getContext().chat[messageId];
            if (Array.isArray(message?.swipes) && message.swipes.length > 1) {
                await deleteSwipe(message.swipe_id, messageId);
            }
        }

        // Re-read the message: deleteSwipe mutates swipes/swipe_id in place.
        finalizeRevision(messageId, feedback, sourceText, revisedText, rules);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error processing revision:`, error);
        toastr.error(error?.message ?? 'An error occurred while processing the revision.');
    } finally {
        isProcessing = false;
    }
}

/**
 * Append the revision as a new swipe and switch to it
 */
function finalizeRevision(messageId, feedback, sourceText, revisedText, rules) {
    const message = getContext().chat[messageId];

    // Initialize swipes array if it doesn't exist
    if (!Array.isArray(message.swipes)) {
        // First swipe should be the current message content
        message.swipes = [message.mes];
        message.swipe_info = [message.extra ? { extra: { ...message.extra } } : {}];
        message.swipe_id = 0;
    }

    // Ensure swipe_info array exists and matches swipes length
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({}));
    }

    // Pad swipe_info to match swipes array if needed
    while (message.swipe_info.length < message.swipes.length) {
        message.swipe_info.push({});
    }

    // Keep the source passage and the rules used alongside the feedback, so a retry
    // rewrites from the same starting point under the same constraints instead of
    // re-revising a revision.
    const newSwipeExtra = {
        api: 'inSTead',
        model: 'revision',
        instead_revised: true,
        instead_feedback: feedback,
        instead_source: sourceText,
        instead_rules: rules.map(rule => rule.id),
    };

    // Add the revision as a new swipe
    message.swipes.push(revisedText);
    message.swipe_info.push({
        send_date: new Date().toISOString(),
        gen_started: new Date().toISOString(),
        gen_finished: new Date().toISOString(),
        extra: newSwipeExtra,
    });

    // Switch to the new swipe
    message.swipe_id = message.swipes.length - 1;
    message.mes = revisedText;

    // Update extra to mark as revised
    message.extra = { ...(message.extra ?? {}), ...newSwipeExtra };

    // Save and re-render
    saveChatConditional().then(() => reloadCurrentChat());

    toastr.success('Revision added as new swipe! Swipe left to see the original.');
}

/**
 * Render the ticked rules as instructions the model can act on.
 * A bare prohibition is much weaker than a prohibition paired with a replacement,
 * which is why rules carry an "instead" half.
 * @param {Rule[]} rules
 */
function renderRules(rules) {
    if (!rules.length) {
        return '';
    }

    const lines = rules.map((rule, index) => {
        const head = `${index + 1}. Avoid: ${rule.forbid.trim()}`;
        return rule.instead?.trim()
            ? `${head}\n   Instead: ${rule.instead.trim()}`
            : head;
    });

    return [
        '## Standing constraints',
        'The rewrite must satisfy every constraint below.',
        ...lines,
        '',
    ].join('\n');
}

/**
 * Build the messages sent to the model.
 *
 * Note that this deliberately does NOT go through generateQuietPrompt: that would
 * drag the main chat preset's system prompt along, and those instructions routinely
 * outweigh the revision instructions. Here the editorial rules are the only rules.
 */
function buildRevisionMessages(sourceText, feedback, rules) {
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

/**
 * Generate revision through the configured connection profile.
 * @returns {Promise<string>}
 */
async function generateRevision(sourceText, feedback, rules) {
    const context = getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service || context.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        throw new Error('inSTead requires the Connection Manager extension to be enabled.');
    }

    const settings = extension_settings.instead;
    const profileId = settings.profileId || context.extensionSettings.connectionManager?.selectedProfile;

    if (!profileId) {
        throw new Error('No connection profile selected. Pick one in the inSTead settings.');
    }

    const messages = buildRevisionMessages(sourceText, feedback, rules);

    // includePreset keeps the profile's own sampler settings (temperature and friends)
    // but does not inject its prompt manager entries, which is exactly what we want.
    const response = await service.sendRequest(profileId, messages, Number(settings.maxTokens) || 2048, {
        extractData: true,
        includePreset: true,
        stream: false,
    });

    return (response?.content ?? '').trim();
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

function loadSettings() {
    extension_settings.instead = Object.assign({}, defaultSettings, extension_settings.instead);
    const settings = extension_settings.instead;

    // Settings written by older versions may be missing the rule stores entirely.
    if (!Array.isArray(settings.rules)) {
        settings.rules = [];
    }
    if (!settings.characterRules || typeof settings.characterRules !== 'object') {
        settings.characterRules = {};
    }
}

/**
 * Fill the profile dropdown with the profiles Connection Manager can actually drive.
 */
function populateProfileSelect() {
    const select = document.getElementById('instead_profile');
    if (!select) {
        return;
    }

    const context = getContext();
    let profiles = [];
    try {
        profiles = context.ConnectionManagerRequestService?.getSupportedProfiles() ?? [];
    } catch (error) {
        console.debug(`[${EXTENSION_NAME}] Connection Manager unavailable:`, error);
    }

    const selected = extension_settings.instead.profileId;
    select.innerHTML = '<option value="">— Use the currently selected profile —</option>';
    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name;
        option.selected = profile.id === selected;
        select.appendChild(option);
    }

    // The saved profile may have been deleted since; fall back to the default entry.
    if (selected && !profiles.some(p => p.id === selected)) {
        select.value = '';
    }
}

/**
 * Build one editable rule row.
 * @param {Rule} rule
 */
function renderRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'instead-rule';
    row.dataset.id = rule.id;
    row.innerHTML = `
        <div class="instead-rule-head">
            <label class="checkbox_label instead-rule-toggle">
                <input type="checkbox" class="instead-rule-enabled"${rule.enabled ? ' checked' : ''}>
                <span>On by default</span>
            </label>
            <div class="instead-rule-delete fa-solid fa-trash-can interactable" tabindex="0"></div>
        </div>
        <input class="text_pole instead-rule-forbid" placeholder="Avoid: resolving conflict within a single turn">
        <input class="text_pole instead-rule-instead" placeholder="Instead: end the passage with the tension unresolved">
    `;

    // Set values as properties, not attributes, so quotes in the text cannot break markup
    row.querySelector('.instead-rule-forbid').value = rule.forbid ?? '';
    row.querySelector('.instead-rule-instead').value = rule.instead ?? '';
    return row;
}

/**
 * @param {HTMLElement} container
 * @param {Rule[]} rules Live array; edits mutate it in place
 */
function renderRuleList(container, rules) {
    container.innerHTML = '';

    if (!rules.length) {
        const empty = document.createElement('div');
        empty.className = 'instead-rules-empty';
        empty.textContent = 'No rules yet.';
        container.appendChild(empty);
        return;
    }

    for (const rule of rules) {
        container.appendChild(renderRuleRow(rule));
    }
}

/**
 * One delegated handler per list, so rows added later keep working.
 * @param {HTMLElement} container
 * @param {() => Rule[]} getRules
 * @param {() => void} rerender
 */
function bindRuleList(container, getRules, rerender) {
    const findRule = (target) => {
        const id = target.closest('.instead-rule')?.dataset.id;
        return getRules().find(rule => rule.id === id);
    };

    container.addEventListener('input', (event) => {
        const rule = findRule(event.target);
        if (!rule) return;

        if (event.target.classList.contains('instead-rule-forbid')) {
            rule.forbid = event.target.value;
        } else if (event.target.classList.contains('instead-rule-instead')) {
            rule.instead = event.target.value;
        } else {
            return;
        }
        saveSettingsDebounced();
    });

    container.addEventListener('change', (event) => {
        if (!event.target.classList.contains('instead-rule-enabled')) return;
        const rule = findRule(event.target);
        if (!rule) return;
        rule.enabled = event.target.checked;
        saveSettingsDebounced();
    });

    container.addEventListener('click', (event) => {
        if (!event.target.classList.contains('instead-rule-delete')) return;
        const rules = getRules();
        const index = rules.findIndex(rule => rule.id === event.target.closest('.instead-rule')?.dataset.id);
        if (index === -1) return;
        rules.splice(index, 1);
        saveSettingsDebounced();
        rerender();
    });
}

/**
 * Refresh the character rules section for whatever chat is open.
 */
function refreshCharacterRules() {
    const section = document.getElementById('instead_char_section');
    if (!section) {
        return;
    }

    const context = getContext();
    const key = getCurrentCharacterKey();
    const label = document.getElementById('instead_char_label');
    const hint = document.getElementById('instead_char_hint');
    const list = document.getElementById('instead_char_rules');
    const addButton = document.getElementById('instead_add_char');

    if (!key) {
        label.textContent = 'Character';
        list.innerHTML = '';
        addButton.classList.add('disabled');
        hint.textContent = context.groupId
            ? 'Group chats use global rules only — inSTead cannot tell which member a message belongs to.'
            : 'Select a character to add rules that apply only to them.';
        return;
    }

    const name = context.characters[context.characterId]?.name ?? 'Character';
    label.textContent = name;
    addButton.classList.remove('disabled');
    hint.textContent = `Applied on top of the global rules whenever you are chatting with ${name}.`;
    renderRuleList(list, getCharacterRules(key));
}

/**
 * Build the settings drawer
 */
async function addSettingsControls() {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);

    $('#instead_profile').on('change', function () {
        extension_settings.instead.profileId = String($(this).val() ?? '');
        saveSettingsDebounced();
    });

    $('#instead_max_tokens').val(extension_settings.instead.maxTokens).on('input', function () {
        const value = Number($(this).val());
        extension_settings.instead.maxTokens = Number.isFinite(value) && value > 0 ? value : defaultSettings.maxTokens;
        saveSettingsDebounced();
    });

    $('#instead_preserve_block').prop('checked', extension_settings.instead.preserveBlock).on('change', function () {
        extension_settings.instead.preserveBlock = $(this).prop('checked');
        saveSettingsDebounced();
    });

    const $blockRegex = $('#instead_block_regex').val(extension_settings.instead.blockRegex);
    $blockRegex.on('input', function () {
        const pattern = String($(this).val() ?? '');
        // Keep a broken pattern out of the settings: splitTrailingBlock would just
        // skip it, and the message would silently lose its block.
        try {
            new RegExp(pattern);
            $(this).removeClass('instead-invalid');
            extension_settings.instead.blockRegex = pattern;
            saveSettingsDebounced();
        } catch {
            $(this).addClass('instead-invalid');
        }
    });

    $('#instead_reset_regex').on('click', function (event) {
        event.preventDefault();
        extension_settings.instead.blockRegex = DEFAULT_BLOCK_REGEX;
        $blockRegex.val(DEFAULT_BLOCK_REGEX).removeClass('instead-invalid');
        saveSettingsDebounced();
    });

    const globalList = document.getElementById('instead_global_rules');
    const charList = document.getElementById('instead_char_rules');

    bindRuleList(globalList, () => extension_settings.instead.rules, () => {
        renderRuleList(globalList, extension_settings.instead.rules);
    });
    bindRuleList(charList, () => getCharacterRules(getCurrentCharacterKey()), refreshCharacterRules);

    document.getElementById('instead_add_global').addEventListener('click', () => {
        extension_settings.instead.rules.push(createRule());
        saveSettingsDebounced();
        renderRuleList(globalList, extension_settings.instead.rules);
    });

    document.getElementById('instead_add_char').addEventListener('click', () => {
        const key = getCurrentCharacterKey();
        if (!key) {
            toastr.info('Open a single-character chat to add character rules.');
            return;
        }
        getCharacterRules(key).push(createRule());
        saveSettingsDebounced();
        refreshCharacterRules();
    });

    renderRuleList(globalList, extension_settings.instead.rules);
    refreshCharacterRules();
    populateProfileSelect();
}

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Handle click on feedback icon using event delegation
 */
function onFeedbackIconClick(event) {
    const target = event.target.closest('.instead-feedback-icon');
    if (!target) return;

    event.stopPropagation();
    event.preventDefault();

    const messageId = parseInt(target.getAttribute('data-mesid'));
    if (!isNaN(messageId)) {
        showFeedbackPopup(messageId);
    }
}

jQuery(async () => {
    console.log(`[${EXTENSION_NAME}] Initializing...`);

    try {
        loadSettings();
        await addSettingsControls();

        // Use event delegation for click handling (works even if button added later)
        $(document).on('click', '.instead-feedback-icon', onFeedbackIconClick);

        // Add icons to existing messages
        addFeedbackIconsToMessages();

        // Listen for new character messages being rendered
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
            addFeedbackIconToMessage(messageId);
        });

        // Also listen for chat changes to re-add icons and repoint the character rules
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Small delay to ensure DOM is updated
            setTimeout(addFeedbackIconsToMessages, 100);
            refreshCharacterRules();
        });

        // Listen for app ready event (fires on initial load and profile switches)
        eventSource.on(event_types.APP_READY, () => {
            setTimeout(addFeedbackIconsToMessages, 100);
            populateProfileSelect();
        });

        // Listen for settings loaded (fires when switching profiles/accounts)
        eventSource.on(event_types.SETTINGS_LOADED, () => {
            loadSettings();
            setTimeout(addFeedbackIconsToMessages, 200);
            populateProfileSelect();
            renderRuleList(document.getElementById('instead_global_rules'), extension_settings.instead.rules);
            refreshCharacterRules();
        });

        // Use MutationObserver as a fallback to detect when messages are added to the DOM
        // This handles cases where events might not fire properly during profile switches
        const chatContainer = document.getElementById('chat');
        if (chatContainer) {
            const observer = new MutationObserver((mutations) => {
                let hasNewMessages = false;
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE &&
                                (node.classList?.contains('mes') || node.querySelector?.('.mes'))) {
                                hasNewMessages = true;
                                break;
                            }
                        }
                    }
                    if (hasNewMessages) break;
                }
                if (hasNewMessages) {
                    // Debounce to avoid excessive calls
                    clearTimeout(observer.debounceTimer);
                    observer.debounceTimer = setTimeout(addFeedbackIconsToMessages, 150);
                }
            });

            observer.observe(chatContainer, { childList: true, subtree: true });
        }

        console.log(`[${EXTENSION_NAME}] Initialized successfully`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize:`, error);
    }
});
