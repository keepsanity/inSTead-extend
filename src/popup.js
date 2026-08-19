/**
 * The revision popup: pick rules, write feedback, send.
 */

import { getContext } from '../../../../extensions.js';
import { t } from '../../../../i18n.js';
import { getApplicableRules } from './settings.js';
import { getRevisionForCurrentSwipe, processRevisionRequest, isRevisionInProgress } from './revision.js';
import { escapeHtml } from './dom.js';

/**
 * Checkbox list of the rules that apply here.
 * @param {import('./settings.js').Rule[]} rules
 * @param {string[]|null} preselected Rule ids to tick instead of the saved defaults
 */
function renderRulePicker(rules, preselected) {
    if (!rules.length) {
        return '';
    }

    const items = rules.map(rule => {
        const checked = preselected ? preselected.includes(rule.id) : rule.enabled;
        return `
            <label class="instead-rule-pick">
                <input type="checkbox" data-rule-id="${escapeHtml(rule.id)}"${checked ? ' checked' : ''}>
                <span class="instead-rule-pick-text">${escapeHtml(rule.text)}</span>
            </label>
        `;
    }).join('');

    return `
        <div class="instead-rules-picker">
            <div class="instead-rules-picker-title">${escapeHtml(t`Standing rules`)}</div>
            ${items}
        </div>
    `;
}

/**
 * @param {number} messageId
 */
export function showFeedbackPopup(messageId) {
    if (isRevisionInProgress()) {
        toastr.warning(t`Please wait for the current revision to complete.`);
        return;
    }

    // The button carries a mesid captured when it was injected, so it can outlive
    // the message it points at while the chat is being rebuilt.
    const message = getContext().chat[messageId];
    if (!message) {
        toastr.warning(t`That message is no longer available.`);
        return;
    }

    // If the swipe on screen is itself an inSTead revision, this is a retry:
    // pre-fill the previous feedback and rewrite from the passage it was based on.
    const previous = getRevisionForCurrentSwipe(message);
    const sourceText = previous?.source ?? message.mes;
    const rules = getApplicableRules();

    const title = previous ? t`Revise again` : t`Feedback on this message`;
    const sourceLabel = previous ? t`Rewriting from:` : t`Original message:`;
    const confirmLabel = previous ? t`Add swipe` : t`Send`;

    const popupHtml = `
        <div class="instead-popup-overlay">
            <div class="instead-popup-container">
                <div class="instead-popup-header">
                    <h3>${escapeHtml(title)}</h3>
                    <button class="instead-popup-close">&times;</button>
                </div>
                <div class="instead-popup-body">
                    <div class="instead-original-message">
                        <strong>${escapeHtml(sourceLabel)}</strong>
                        <div class="instead-message-preview">${escapeHtml(sourceText)}</div>
                    </div>
                    ${renderRulePicker(rules, previous?.ruleIds ?? null)}
                    <textarea
                        class="instead-feedback-input text_pole"
                        placeholder="${escapeHtml(t`Enter your editorial feedback here...`)}"
                        rows="6"
                    >${escapeHtml(previous?.feedback ?? '')}</textarea>
                </div>
                <div class="instead-popup-footer">
                    <button class="instead-cancel-btn menu_button">${escapeHtml(t`Cancel`)}</button>
                    ${previous ? `<button class="instead-replace-btn menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i>${escapeHtml(t`Replace`)}</button>` : ''}
                    <button class="instead-send-btn menu_button menu_button_icon">
                        <i class="fa-solid fa-paper-plane"></i>
                        ${escapeHtml(confirmLabel)}
                    </button>
                </div>
            </div>
        </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = popupHtml;
    document.body.appendChild(wrapper.firstElementChild);

    const popup = document.querySelector('.instead-popup-overlay');
    const feedbackInput = popup.querySelector('.instead-feedback-input');
    const sendBtn = popup.querySelector('.instead-send-btn');
    const replaceBtn = popup.querySelector('.instead-replace-btn');
    const cancelBtn = popup.querySelector('.instead-cancel-btn');
    const closeBtn = popup.querySelector('.instead-popup-close');

    setTimeout(() => feedbackInput.focus(), 100);

    const closePopup = () => popup.remove();

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
            toastr.warning(t`Enter some feedback or tick at least one rule.`);
            return;
        }

        closePopup();
        await processRevisionRequest(messageId, feedback, sourceText, selectedRules, replaceCurrentSwipe);
    };

    sendBtn.addEventListener('click', () => submit(false));
    replaceBtn?.addEventListener('click', () => submit(true));

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
