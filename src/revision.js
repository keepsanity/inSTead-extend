/**
 * Turning a generated revision into a swipe on the message.
 */

import { getContext } from '../../../../extensions.js';
import { saveChatConditional, reloadCurrentChat, deleteSwipe } from '../../../../../script.js';
import { t } from '../../../../i18n.js';
import { EXTENSION_NAME } from './settings.js';
import { splitTrailingBlock } from './prompt.js';
import { generateRevision } from './generate.js';

let isProcessing = false;

export function isRevisionInProgress() {
    return isProcessing;
}

/**
 * Read the revision metadata stored on the swipe currently on screen.
 * Returns null when that swipe was not produced by this extension.
 * @param {object} message
 */
export function getRevisionForCurrentSwipe(message) {
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
 * @param {number} messageId Message being revised
 * @param {string} feedback Editorial instructions from the user
 * @param {string} sourceText The passage to rewrite
 * @param {import('./settings.js').Rule[]} rules Standing rules ticked for this revision
 * @param {boolean} replaceCurrentSwipe Delete the swipe on screen first
 */
export async function processRevisionRequest(messageId, feedback, sourceText, rules, replaceCurrentSwipe) {
    if (isProcessing) return;

    isProcessing = true;

    // Generation takes seconds, and messageId only means anything within the chat it
    // was captured in. Remember which chat that was so the result cannot be written
    // into a different one.
    const originChatId = getContext().getCurrentChatId();

    try {
        toastr.info(t`Generating revision with your feedback...`);

        // The info block never reaches the model; it is stitched back on afterwards.
        const { body, block } = splitTrailingBlock(sourceText);
        const revisedBody = await generateRevision(body, feedback, rules);

        if (!revisedBody) {
            toastr.error(t`Failed to generate revision.`);
            return;
        }

        const revisedText = block ? `${revisedBody}\n\n${block}` : revisedBody;

        if (getContext().getCurrentChatId() !== originChatId) {
            toastr.warning(t`The chat changed while the revision was generating, so it was discarded.`);
            return;
        }

        const message = getContext().chat[messageId];
        if (!message) {
            toastr.error(t`That message is no longer available.`);
            return;
        }

        // Only drop the old swipe once we know we have something to put in its place.
        if (replaceCurrentSwipe && Array.isArray(message.swipes) && message.swipes.length > 1) {
            // Via deleteSwipe rather than swipes.splice: it keeps swipe_info in
            // step, marks the chat tainted and emits MESSAGE_SWIPE_DELETED.
            await deleteSwipe(message.swipe_id, messageId);
        }

        await finalizeRevision(messageId, feedback, sourceText, revisedText, rules);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error processing revision:`, error);
        toastr.error(error?.message ?? t`An error occurred while processing the revision.`);
    } finally {
        isProcessing = false;
    }
}

/**
 * Append the revision as a new swipe and switch to it.
 */
async function finalizeRevision(messageId, feedback, sourceText, revisedText, rules) {
    // Re-read the message: deleteSwipe mutates swipes/swipe_id in place.
    const message = getContext().chat[messageId];
    if (!message) {
        toastr.error(t`That message is no longer available.`);
        return;
    }

    if (!Array.isArray(message.swipes)) {
        // First swipe should be the current message content
        message.swipes = [message.mes];
        message.swipe_info = [message.extra ? { extra: { ...message.extra } } : {}];
        message.swipe_id = 0;
    }

    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({}));
    }

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

    message.swipes.push(revisedText);
    message.swipe_info.push({
        send_date: new Date().toISOString(),
        gen_started: new Date().toISOString(),
        gen_finished: new Date().toISOString(),
        extra: newSwipeExtra,
    });

    message.swipe_id = message.swipes.length - 1;
    message.mes = revisedText;
    message.extra = { ...(message.extra ?? {}), ...newSwipeExtra };

    // Awaited, and the toast only fires once it has actually landed. Announcing
    // success before the save settles would leave the old text on screen under a
    // green success toast whenever the write fails.
    try {
        await saveChatConditional();
        await reloadCurrentChat();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to save the revision:`, error);
        toastr.error(t`The revision was generated but could not be saved.`);
        return;
    }

    toastr.success(t`Revision added as a new swipe. Swipe left to see the original.`);
}
