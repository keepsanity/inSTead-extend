/**
 * inSTead - SillyTavern Extension
 *
 * Rewrites a character message against editorial instructions and standing rules,
 * and files the result as a new swipe.
 *
 * This file is wiring only. The work lives in ./src:
 *   settings.js      settings store, migrations, rule accessors
 *   prompt.js        passage splitting and prompt construction (always English)
 *   generate.js      Connection Manager request
 *   revision.js      swipe bookkeeping
 *   popup.js         the revision popup
 *   settingsUi.js    the settings drawer
 *   messageButton.js the per-message button
 */

import { eventSource, event_types } from '../../../../script.js';
import { EXTENSION_NAME, loadSettings } from './src/settings.js';
import { addSettingsControls, populateProfileSelect, refreshCharacterRules, refreshRules } from './src/settingsUi.js';
import { addButtonToMessage, addButtonsToAllMessages, observeChat, BUTTON_CLASS } from './src/messageButton.js';
import { showFeedbackPopup } from './src/popup.js';

function onRevisionButtonClick(event) {
    const target = event.target.closest(`.${BUTTON_CLASS}`);
    if (!target) {
        return;
    }

    event.stopPropagation();
    event.preventDefault();

    const messageId = parseInt(target.getAttribute('data-mesid'), 10);
    if (!isNaN(messageId)) {
        showFeedbackPopup(messageId);
    }
}

jQuery(async () => {
    console.log(`[${EXTENSION_NAME}] Initializing...`);

    try {
        loadSettings();

        // Isolated: a broken settings drawer must not cost us the revision button.
        try {
            await addSettingsControls();
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to build the settings drawer:`, error);
        }

        // Delegated, so it also covers buttons added long after this runs.
        $(document).on('click', `.${BUTTON_CLASS}`, onRevisionButtonClick);

        addButtonsToAllMessages();

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, addButtonToMessage);

        eventSource.on(event_types.CHAT_CHANGED, () => {
            // Small delay to ensure the DOM has caught up
            setTimeout(addButtonsToAllMessages, 100);
            refreshCharacterRules();
        });

        // Fires on initial load and on profile switches
        eventSource.on(event_types.APP_READY, () => {
            setTimeout(addButtonsToAllMessages, 100);
            populateProfileSelect();
            refreshCharacterRules();
        });

        eventSource.on(event_types.SETTINGS_LOADED, () => {
            loadSettings();
            setTimeout(addButtonsToAllMessages, 200);
            populateProfileSelect();
            refreshRules();
        });

        observeChat(addButtonsToAllMessages);

        console.log(`[${EXTENSION_NAME}] Initialized successfully`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize:`, error);
    }
});
