/**
 * Talking to the model through Connection Manager.
 */

import { getContext } from '../../../../extensions.js';
import { t } from '../../../../i18n.js';
import { getSettings } from './settings.js';
import { buildRevisionMessages } from './prompt.js';

/**
 * Generate a revision through the configured connection profile.
 * @param {string} sourceText
 * @param {string} feedback
 * @param {import('./settings.js').Rule[]} rules
 * @returns {Promise<string>}
 */
export async function generateRevision(sourceText, feedback, rules) {
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
