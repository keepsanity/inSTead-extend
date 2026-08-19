/**
 * The settings drawer: connection profile, info block handling and the rule editor.
 */

import { getContext, renderExtensionTemplateAsync } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { t } from '../../../../i18n.js';
import {
    DEFAULT_BLOCK_REGEX,
    TEMPLATE_PATH,
    createRule,
    defaultSettings,
    getCharacterRules,
    getCurrentCharacterKey,
    getSettings,
} from './settings.js';
import { getSupportedProfiles } from './generate.js';

const GLOBAL_LIST_ID = 'instead_global_rules';
const CHAR_LIST_ID = 'instead_char_rules';

/** Which settings array each rules list on screen is editing. */
const RULE_LISTS = {
    [GLOBAL_LIST_ID]: () => getSettings().rules,
    [CHAR_LIST_ID]: () => {
        const key = getCurrentCharacterKey();
        return key ? getCharacterRules(key) : null;
    },
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @param {import('./settings.js').Rule} rule
 */
function renderRuleRow(rule) {
    const row = document.createElement('div');
    row.className = 'instead-rule';
    row.dataset.id = rule.id;
    row.innerHTML = `
        <div class="instead-rule-head">
            <label class="checkbox_label instead-rule-toggle">
                <input type="checkbox" class="instead-rule-enabled"${rule.enabled ? ' checked' : ''}>
                <span>${t`On by default`}</span>
            </label>
            <div class="instead-rule-delete fa-solid fa-trash-can interactable" tabindex="0"></div>
        </div>
        <textarea class="text_pole instead-rule-text" rows="2"></textarea>
    `;

    const textarea = row.querySelector('.instead-rule-text');
    // Set as properties, not attributes, so quotes in the text cannot break markup
    textarea.placeholder = t`Write the rule however you like.`;
    textarea.value = rule.text ?? '';
    return row;
}

/**
 * @param {HTMLElement} container
 * @param {import('./settings.js').Rule[]} rules
 */
function renderRuleList(container, rules) {
    if (!container) {
        return;
    }
    container.innerHTML = '';

    if (!rules.length) {
        const empty = document.createElement('div');
        empty.className = 'instead-rules-empty';
        empty.textContent = t`No rules yet.`;
        container.appendChild(empty);
        return;
    }

    for (const rule of rules) {
        container.appendChild(renderRuleRow(rule));
    }
}

function renderGlobalRules() {
    renderRuleList(document.getElementById(GLOBAL_LIST_ID), getSettings().rules);
}

/**
 * Redraw both rule lists. Used after the settings object is swapped wholesale,
 * e.g. when SillyTavern reloads settings on a profile switch.
 */
export function refreshRules() {
    renderGlobalRules();
    refreshCharacterRules();
}

/**
 * Refresh the character rules section for whatever chat is open.
 */
export function refreshCharacterRules() {
    const label = document.getElementById('instead_char_label');
    const hint = document.getElementById('instead_char_hint');
    const list = document.getElementById(CHAR_LIST_ID);

    // The drawer may not be built yet when an early event fires.
    if (!label || !hint || !list) {
        return;
    }

    const context = getContext();
    const key = getCurrentCharacterKey();

    // Note: never mark the add button `.disabled`. ST styles that with
    // `pointer-events: none`, and since characterId is still undefined while the
    // app boots, the button would come up permanently dead.
    if (!key) {
        label.textContent = t`Character`;
        list.innerHTML = '';
        hint.textContent = context.groupId
            ? t`Group chats use global rules only — inSTead cannot tell which member a message belongs to.`
            : t`Select a character to add rules that apply only to them.`;
        return;
    }

    const name = context.characters[context.characterId]?.name ?? t`Character`;
    label.textContent = name;
    hint.textContent = t`Applied on top of the global rules whenever you are chatting with ${name}.`;
    renderRuleList(list, getCharacterRules(key));
}

/**
 * Fill the profile dropdown with the profiles Connection Manager can actually drive.
 */
export function populateProfileSelect() {
    const select = document.getElementById('instead_profile');
    if (!select) {
        return;
    }

    const profiles = getSupportedProfiles();
    const selected = getSettings().profileId;

    select.innerHTML = '';
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = t`— Use the currently selected profile —`;
    select.appendChild(fallback);

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

/* -------------------------------------------------------------------------- */
/* Behaviour                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Scroll a freshly added rule into view and put the caret in it. On a phone the
 * settings drawer is long enough that a new row can land off screen, which reads
 * as "the button did nothing".
 */
function focusRule(listId, ruleId) {
    const input = document.querySelector(`#${listId} .instead-rule[data-id="${ruleId}"] .instead-rule-text`);
    if (!input) {
        return;
    }
    input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    input.focus();
}

/**
 * Resolve the rule array and rule object an event landed in.
 * @param {Element} target
 */
function resolveRule(target) {
    const listId = target.closest?.('.instead-rules-list')?.id;
    const rules = RULE_LISTS[listId]?.();
    if (!rules) {
        return {};
    }
    const id = target.closest('.instead-rule')?.dataset.id;
    return { rules, rule: rules.find(r => r.id === id), listId };
}

function rerenderList(listId) {
    if (listId === CHAR_LIST_ID) {
        refreshCharacterRules();
        return;
    }
    renderGlobalRules();
}

/**
 * All rule editing is delegated from `document`, not bound to the containers.
 * Direct listeners depend on the nodes existing at bind time and dying with them;
 * delegation survives every re-render and any ordering surprise during startup.
 */
function bindRuleHandlers() {
    $(document).on('input', '.instead-rules-list .instead-rule-text', function () {
        const { rule } = resolveRule(this);
        if (!rule) return;
        rule.text = this.value;
        saveSettingsDebounced();
    });

    $(document).on('change', '.instead-rules-list .instead-rule-enabled', function () {
        const { rule } = resolveRule(this);
        if (!rule) return;
        rule.enabled = this.checked;
        saveSettingsDebounced();
    });

    $(document).on('click', '.instead-rules-list .instead-rule-delete', function () {
        const { rules, rule, listId } = resolveRule(this);
        if (!rule) return;
        rules.splice(rules.indexOf(rule), 1);
        saveSettingsDebounced();
        rerenderList(listId);
    });

    $(document).on('click', '#instead_add_global', () => {
        const rule = createRule();
        getSettings().rules.push(rule);
        saveSettingsDebounced();
        renderGlobalRules();
        focusRule(GLOBAL_LIST_ID, rule.id);
    });

    $(document).on('click', '#instead_add_char', () => {
        const key = getCurrentCharacterKey();
        if (!key) {
            // The button stays live on purpose: a dead button just looks broken,
            // whereas this says why nothing happened.
            toastr.info(getContext().groupId
                ? t`Group chats use global rules only.`
                : t`Open a character chat first.`);
            return;
        }
        const rule = createRule();
        getCharacterRules(key).push(rule);
        saveSettingsDebounced();
        refreshCharacterRules();
        focusRule(CHAR_LIST_ID, rule.id);
    });
}

function bindGeneralHandlers() {
    const settings = getSettings();

    $('#instead_profile').on('change', function () {
        getSettings().profileId = String($(this).val() ?? '');
        saveSettingsDebounced();
    });

    $('#instead_max_tokens').val(settings.maxTokens).on('input', function () {
        const value = Number($(this).val());
        getSettings().maxTokens = Number.isFinite(value) && value > 0 ? value : defaultSettings.maxTokens;
        saveSettingsDebounced();
    });

    $('#instead_preserve_block').prop('checked', settings.preserveBlock).on('change', function () {
        getSettings().preserveBlock = $(this).prop('checked');
        saveSettingsDebounced();
    });

    const $blockRegex = $('#instead_block_regex').val(settings.blockRegex);
    $blockRegex.on('input', function () {
        const pattern = String($(this).val() ?? '');
        // Keep a broken pattern out of the settings: splitTrailingBlock would just
        // skip it, and the message would silently lose its block.
        try {
            new RegExp(pattern);
            $(this).removeClass('instead-invalid');
            getSettings().blockRegex = pattern;
            saveSettingsDebounced();
        } catch {
            $(this).addClass('instead-invalid');
        }
    });

    $('#instead_reset_regex').on('click', function (event) {
        event.preventDefault();
        getSettings().blockRegex = DEFAULT_BLOCK_REGEX;
        $blockRegex.val(DEFAULT_BLOCK_REGEX).removeClass('instead-invalid');
        saveSettingsDebounced();
    });
}

/**
 * Build the settings drawer and wire it up.
 */
export async function addSettingsControls() {
    const html = await renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    $('#extensions_settings2').append(html);

    bindGeneralHandlers();
    bindRuleHandlers();

    renderGlobalRules();
    refreshCharacterRules();
    populateProfileSelect();
}
