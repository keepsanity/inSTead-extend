/**
 * Talking to the model through Connection Manager.
 */

import { getContext } from '../../../../extensions.js';
import { extractMessageFromData } from '../../../../../script.js';
import { t } from '../../../../i18n.js';
import { getSettings } from './settings.js';
import { buildRevisionMessages } from './prompt.js';

/**
 * Generate a revision through the configured connection profile.
 * @param {string} sourceText
 * @param {string} feedback
 * @param {import('./settings.js').Rule[]} rules
 * @param {object} [referenceContext] Selected reference material, collected before the request
 * @returns {Promise<string>}
 */
export async function generateRevision(sourceText, feedback, rules, referenceContext = {}) {
    const context = getContext();
    const service = context.ConnectionManagerRequestService;

    if (!service || context.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        throw new Error(t`inSTead requires the Connection Manager extension to be enabled.`);
    }

    const settings = getSettings();
    const profileId = settings.profileId || context.extensionSettings.connectionManager?.selectedProfile;

    if (!profileId) {
        throw new Error(t`No connection profile selected. Pick one in the inSTead settings.`);
    }

    const messages = buildRevisionMessages(sourceText, feedback, rules, referenceContext);
    const api = service.validateProfile(service.getProfile(profileId)).selected;

    // includePreset keeps the profile's own sampler settings (temperature and friends)
    // but does not inject its prompt manager entries, which is exactly what we want.
    const response = await service.sendRequest(profileId, messages, Number(settings.maxTokens) || 2048, {
        // Keep finish reasons: extracted responses contain only content/reasoning.
        extractData: false,
        includePreset: true,
        stream: false,
    });

    const reason = response?.choices?.[0]?.finish_reason
        ?? response?.stop_reason
        ?? response?.candidates?.[0]?.finishReason
        ?? response?.finish_reason;
    const normalizedReason = String(reason ?? '').toLowerCase();
    if (['length', 'max_tokens', 'max_output_tokens', 'model_length'].includes(normalizedReason)
        || response?.incomplete_details?.reason === 'max_output_tokens') {
        throw new Error(t`The revision hit the output token limit and was not saved. Increase Response length (tokens) in the inSTead settings and try again. Reasoning models may use part of this budget for thinking.`);
    }
    if (['content_filter', 'safety', 'recitation', 'blocklist', 'prohibited_content'].includes(normalizedReason)) {
        throw new Error(t`The provider stopped the revision before completion. The existing message was kept.`);
    }

    return (extractMessageFromData(response, api) ?? '').trim();
}

/**
 * Connection profiles Connection Manager can actually drive, or an empty list when
 * the extension is unavailable.
 * @returns {Array<{id: string, name: string}>}
 */
export function getSupportedProfiles() {
    try {
        return getContext().ConnectionManagerRequestService?.getSupportedProfiles() ?? [];
    } catch (error) {
        console.debug('[inSTead] Connection Manager unavailable:', error);
        return [];
    }
}
