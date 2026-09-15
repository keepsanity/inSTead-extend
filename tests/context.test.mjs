import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import test from 'node:test';

// Run with: node --experimental-vm-modules --test tests/context.test.mjs
// Exercise the real modules with ST's host APIs stubbed; no model calls or chat writes.
async function setup({ loreError = false } = {}) {
    const calls = { lore: [], card: [], requests: [] };
    const host = {
        chat: [
            { name: 'User', is_user: true, mes: 'EARLY_HISTORY' },
            { name: 'Character', mes: 'LATEST_HISTORY' },
            { name: 'Character', mes: 'TARGET', original_avatar: 'speaker.png' },
            { name: 'User', is_user: true, mes: 'FUTURE_SECRET' },
        ],
        characterId: 1,
        getCurrentChatId: () => 'original-chat',
        characters: [{ name: 'Character', avatar: 'speaker.png' }, { name: 'Other', avatar: 'other.png' }],
        extensionPrompts: { note: { value: 'ORIGINAL_NOTE', depth: 2 } },
        extensionSettings: { disabledExtensions: [], connectionManager: { selectedProfile: 'editor' } },
        ConnectionManagerRequestService: { sendRequest: async (...args) => {
            calls.requests.push(args);
            return { content: 'REVISED' };
        } },
    };
    const card = { description: 'CARD_DESCRIPTION', personality: 'CARD_PERSONALITY', scenario: 'SCENARIO', mesExamples: 'EXAMPLES' };
    const modules = new Map();
    const mock = (name, exports) => {
        const module = new SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        });
        modules.set(name, module);
    };
    mock('extensions.js', { getContext: () => host });
    mock('script.js', {
        getCharacterCardFields: options => { calls.card.push(options); return card; },
        getMaxPromptTokens: () => 16000,
        saveChatConditional: async () => {}, reloadCurrentChat: async () => {}, deleteSwipe: async () => {},
    });
    mock('authors-note.js', { NOTE_MODULE_NAME: 'note' });
    mock('world-info.js', {
        world_info_include_names: true,
        getWorldInfoPrompt: async (...args) => {
            calls.lore.push(args);
            host.extensionPrompts.note = { value: 'TEMPORARY_WI_NOTE' };
            if (loreError) throw new Error('Lore failed');
            return {
                worldInfoBefore: 'LORE_BEFORE', worldInfoAfter: 'LORE_AFTER',
                worldInfoExamples: [{ content: 'LORE_EXAMPLE' }],
                worldInfoDepth: [{ entries: ['LORE_DEPTH'] }],
                anBefore: ['LORE_AN_BEFORE'], anAfter: ['LORE_AN_AFTER'],
                outletEntries: { custom: ['LORE_OUTLET'] },
            };
        },
    });
    mock('settings.js', { EXTENSION_NAME: 'inSTead', getSettings: () => ({ maxTokens: 2048 }) });
    mock('i18n.js', { t: strings => strings.join('') });
    for (const name of ['context.js', 'prompt.js', 'generate.js', 'revision.js']) {
        const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
        const hostUi = name === 'revision.js' ? 'const toastr = { info() {}, warning() {}, error() {}, success() {} };\n' : '';
        modules.set(name, new SourceTextModule(hostUi + source));
    }
    const link = name => modules.get(name.split('/').at(-1));
    for (const module of modules.values()) {
        if (module.status === 'unlinked') await module.link(link);
        if (module.status === 'linked') await module.evaluate();
    }
    return { host, calls, context: modules.get('context.js').namespace, prompt: modules.get('prompt.js').namespace, generate: modules.get('generate.js').namespace, revision: modules.get('revision.js').namespace };
}

for (let mask = 0; mask < 8; mask++) {
    test(`request contains exactly the selected context (combination ${mask})`, async () => {
        const { context, generate, calls, host } = await setup();
        const options = { character: Boolean(mask & 1), lore: Boolean(mask & 2), history: Boolean(mask & 4) };
        const references = await context.buildRevisionContext(2, 'SOURCE_BODY', options);
        assert.equal(await generate.generateRevision('SOURCE_BODY', 'Fix tone', [], references), 'REVISED');
        const [profile, messages] = calls.requests[0];
        const text = JSON.stringify(messages);
        assert.equal(profile, 'editor');
        assert.equal(text.includes('CARD_DESCRIPTION'), options.character);
        assert.equal(text.includes('LORE_BEFORE'), options.lore);
        assert.equal(text.includes('EARLY_HISTORY'), options.history);
        assert.equal(text.includes('LATEST_HISTORY'), options.history);
        assert.equal(text.includes('FUTURE_SECRET'), false);
        assert.equal(text.includes('TARGET'), false);
        assert.equal(text.split('SOURCE_BODY').length - 1, 1);
        assert.equal(calls.lore.length, Number(options.lore));
        assert.equal(calls.card.length, Number(options.character || options.lore));
        assert.equal(host.extensionPrompts.note.value, 'ORIGINAL_NOTE');
        if (options.character || options.lore) assert.equal(calls.card[0].chid, 0);
        if (options.lore) {
            assert.deepEqual(calls.lore[0][0], ['Character: SOURCE_BODY', 'Character: LATEST_HISTORY', 'User: EARLY_HISTORY']);
            assert.equal(calls.lore[0][2], true);
            assert.equal(calls.lore[0][3].trigger, 'quiet');
            for (const placement of ['LORE_AFTER', 'LORE_EXAMPLE', 'LORE_DEPTH', 'LORE_AN_BEFORE', 'LORE_AN_AFTER', 'LORE_OUTLET']) {
                assert.ok(text.includes(placement));
            }
        }
    });
}

test('full history is not capped and never includes later messages', async () => {
    const { context, host } = await setup();
    host.chat = Array.from({ length: 502 }, (_, id) => ({ name: 'User', is_user: true, mes: `message-${id}` }));
    const result = await context.buildRevisionContext(500, 'source', { history: true });
    assert.equal(result.history.length, 500);
    assert.equal(result.history[0].content, 'message-0');
    assert.equal(result.history.at(-1).content, 'message-499');
});

test('failed lore lookup restores Author\'s Note and stops the request', async () => {
    const { context, host, calls } = await setup({ loreError: true });
    await assert.rejects(context.buildRevisionContext(2, 'source', { lore: true }), /Lore failed/);
    assert.deepEqual(host.extensionPrompts.note, { value: 'ORIGINAL_NOTE', depth: 2 });
    assert.equal(calls.requests.length, 0);
});

test('disabled context leaves the existing passage-only prompt unchanged', async () => {
    const { context, prompt, calls } = await setup();
    const references = await context.buildRevisionContext(2, 'source');
    assert.deepEqual(prompt.buildRevisionMessages('source', 'feedback', [], references), prompt.buildRevisionMessages('source', 'feedback', []));
    assert.equal(calls.card.length + calls.lore.length, 0);
});

test('rule-only revisions restore the selected context from the current swipe', async () => {
    const { revision } = await setup();
    const message = {
        swipe_id: 1,
        swipe_info: [{}, { extra: {
            instead_revised: true, instead_feedback: '', instead_source: 'original',
            instead_rules: ['rule-1'], instead_context: { character: true, lore: false, history: true },
        } }],
    };
    const saved = revision.getRevisionForCurrentSwipe(message);
    assert.equal(saved.source, 'original');
    assert.deepEqual(saved.contextOptions, { character: true, lore: false, history: true });
    message.swipe_id = 0;
    assert.equal(revision.getRevisionForCurrentSwipe(message), null);
});

test('older revisions default to no context', async () => {
    const { revision } = await setup();
    const saved = revision.getRevisionForCurrentSwipe({ extra: { instead_feedback: 'old feedback' } });
    assert.deepEqual(saved.contextOptions, { character: false, lore: false, history: false });
});

test('revision pipeline saves context choices while preserving the original swipe', async () => {
    const { revision, host } = await setup();
    const options = { character: true, lore: true, history: false };
    await revision.processRevisionRequest(2, '', 'TARGET', [{ id: 'rule-1', text: 'Fix tone' }], false, options);
    assert.deepEqual(host.chat[2].swipes, ['TARGET', 'REVISED']);
    assert.deepEqual(revision.getRevisionForCurrentSwipe(host.chat[2]).contextOptions, options);
    assert.equal(revision.getRevisionForCurrentSwipe(host.chat[2]).source, 'TARGET');
});

test('switching chats during generation never writes the revision into the new chat', async () => {
    const { revision, host } = await setup();
    host.ConnectionManagerRequestService.sendRequest = async () => {
        host.getCurrentChatId = () => 'different-chat';
        return { content: 'WRONG_CHAT_RESULT' };
    };
    await revision.processRevisionRequest(2, 'Fix tone', 'TARGET', [], false, { history: true });
    assert.equal(host.chat[2].mes, 'TARGET');
    assert.equal(host.chat[2].swipes, undefined);
});
