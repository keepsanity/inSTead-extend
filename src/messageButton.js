/**
 * The revision button that gets injected into each character message.
 */

import { getContext } from '../../../../extensions.js';
import { t } from '../../../../i18n.js';
import { EXTENSION_NAME } from './settings.js';

export const BUTTON_CLASS = 'instead-feedback-icon';

/**
 * Add the revision icon to one message.
 * @param {number} messageId
 */
export function addButtonToMessage(messageId) {
    try {
        if (messageId === null || messageId === undefined || isNaN(messageId) || messageId < 0) {
            return;
        }

        const chat = getContext().chat;
        if (!Array.isArray(chat) || messageId >= chat.length) {
            return;
        }

        const message = chat[messageId];
        // User messages have nothing to revise.
        if (!message || message.is_user) {
            return;
        }

        const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
        if (!messageElement || messageElement.querySelector(`.${BUTTON_CLASS}`)) {
            return;
        }

        const buttonsContainer = messageElement.querySelector('.extraMesButtons')
            ?? messageElement.querySelector('.mes_buttons');
        if (!buttonsContainer) {
            console.debug(`[${EXTENSION_NAME}] No buttons container found for message ${messageId}`);
            return;
        }

        // Match ST's native markup: the icon classes live on the button div itself,
        // not on a nested <i>, so it sizes and aligns like its siblings.
        const button = document.createElement('div');
        button.className = `mes_button ${BUTTON_CLASS} fa-solid fa-arrows-rotate interactable`;
        button.title = t`Request revision with feedback`;
        button.setAttribute('data-mesid', String(messageId));
        button.tabIndex = 0;

        // Append at the end, after the native buttons (Copy is normally last).
        buttonsContainer.appendChild(button);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error adding revision button to message ${messageId}:`, error);
    }
}

/**
 * Add the revision icon to every character message currently rendered.
 */
export function addButtonsToAllMessages() {
    const chat = getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        return;
    }

    document.querySelectorAll('.mes').forEach((messageElement) => {
        const mesidAttr = messageElement.getAttribute('mesid');
        if (mesidAttr === null || mesidAttr === '') {
            return;
        }
        const messageId = parseInt(mesidAttr, 10);
        if (!isNaN(messageId) && messageId >= 0) {
            addButtonToMessage(messageId);
        }
    });
}

/**
 * Messages can arrive without firing an event we listen to (profile switches, for
 * one), so watch the chat container as a backstop.
 * @param {() => void} onNewMessages
 */
export function observeChat(onNewMessages) {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) {
        return;
    }

    let debounceTimer;
    const observer = new MutationObserver((mutations) => {
        const hasNewMessages = mutations.some(mutation =>
            mutation.type === 'childList' && [...mutation.addedNodes].some(node =>
                node.nodeType === Node.ELEMENT_NODE &&
                (node.classList?.contains('mes') || node.querySelector?.('.mes'))));

        if (hasNewMessages) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(onNewMessages, 150);
        }
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
}
