import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Kernel, type EffectAdapter } from '@nestos/durable-kernel';
import { createVFS, MemoryBackend } from '@nestos/vfs-core';
import { ToolProgram } from '@nestos/kernel-adapters';
import { AnthropicProvider } from '@nestos/driver-llm';
import {
    createBuiltinDagPluginRegistry, createFlowRevision, DurableFlowExecutor,
    flowToDag, registerDurablePrograms, validateFlowRevision,
} from '@nestos/llm-flow';

vi.setConfig({ testTimeout: 20000 });
vi.mock('../node/process.mjs', () => ({invoke: async (_args: unknown, input: {source: string}) => ({cards: JSON.parse(input.source)})}));
const planners = await vi.importActual<{ recognizeGroups(args: any): unknown; collectCards(args: any, context: unknown): Promise<unknown> }>('../node/batch.mjs');
const draft = () => JSON.parse(readFileSync(new URL('../../../backend/app-core/src/presets/anki-generate.json', import.meta.url), 'utf8'));
const definition = (id: string) => {
    const entry = draft();
    return id === entry.id ? entry : entry.functions.find((fn: any) => fn.id === id);
};
const card = { name: 'apple', unit: 2, symbol: '/ˈæpəl/', chn: '苹果', example_en: 'I eat an apple.',
    example_cn: '我吃一个苹果。', word_family: 'apples', memory_tips: '联想苹果的形状。', difficulty: '1',
    collocations: 'an apple a day 每天一个苹果', image_prompt: 'A student eating a red apple.' };
const runtimePrompt = 'Session request supplied separately from prepared word cards';
let manager: Awaited<ReturnType<typeof createVFS>>['manager'], kernel: Kernel, executor: DurableFlowExecutor;
let responses: string[], requests: Record<string, unknown>[], toolRequests: Record<string, unknown>[];
let useAnthropic: boolean, anthropicBodies: Record<string, any>[];

function preparedFixture(args: any) {
    const groups = [args.source, ...(args.sources ?? []), args.additionalSource].filter(Boolean).map(source =>
        Array.isArray(source) ? source : String(source).trim().startsWith('[')
            ? JSON.parse(String(source)) : [{ name: String(source).split('\n').at(-1), unit: 2 }]);
    if (args.mode === 'grouped' && args.sourceGroupSizes?.length) {
        const source = groups.shift();
        if (args.sourceGroupSizes.reduce((sum: number, size: number) => sum + size, 0) !== source.length) throw new Error('Source group sizes must match reviewed cards');
        let offset = 0;
        groups.unshift(...args.sourceGroupSizes.map((size: number) => source.slice(offset, offset += size)));
    }
    return { cards: groups.flat(), groups };
}

function packageFixture() {
    return { artifacts: { manifest: { path: 'output/anki.manifest.yaml', mimeType: 'application/yaml' },
        package: { path: 'output/deck.apkg', mimeType: 'application/octet-stream' } }, spawn: { idempotencyKey: 'package-test',
        nodes: [{ id: 'package', name: 'Package fixture', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {}, config: { value: 'PACKED' } }],
        edges: [{ id: 'spawn-package', from: '$parent', to: 'package', kind: 'control' }] } };
}

async function executeToolFixture(request: Record<string, unknown>) {
    toolRequests.push(request);
    const args = request.args as any;
    const handlers: Record<string, () => unknown> = {
        'image.process': () => ({ images: args.images }),
        'anki.prepare': () => preparedFixture(args),
        'anki.recognize': () => planners.recognizeGroups(args),
        'anki.collect': () => planners.collectCards(args, {}),
        'anki.plan': packageFixture,
    };
    if (!handlers[String(request.toolId)]) throw new Error(`Unexpected fixture tool: ${request.toolId}`);
    return { toolId: request.toolId, success: true, data: await handlers[String(request.toolId)](), output: '', durationMs: 0 };
}

beforeEach(async () => {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const fs = await manager.openFileSystem('/test');
    kernel = new Kernel({ catalog: { fs }, pollMs: 5 });
    kernel.registerStorageResolver({ kind: 'test', async resolve() { return { fs, rootPath: '/s' }; } });
    registerDurablePrograms(kernel);
    kernel.registerProgram(new ToolProgram());
    responses = []; requests = []; toolRequests = []; useAnthropic = false; anthropicBodies = [];
    const anthropic = new AnthropicProvider({provider: 'anthropic', apiKey: 'fixture-key', apiBaseUrl: 'https://fixture.invalid',
        fetch: async (_url, options) => {
            anthropicBodies.push(JSON.parse(String(options?.body)));
            return new Response(JSON.stringify({id: 'fixture', type: 'message', role: 'assistant', model: 'fixture',
                content: [{type: 'text', text: responses.shift() ?? '{}'}], stop_reason: 'end_turn', usage: {input_tokens: 1, output_tokens: 1}}),
            {headers: {'content-type': 'application/json'}});
        }});
    kernel.registerEffect({ kind: 'tool.call', version: '1', execute: executeToolFixture } as EffectAdapter);
    kernel.registerEffect({ kind: 'llm.chat', version: '1', async execute(request: Record<string, unknown>) {
        requests.push(request);
        if (useAnthropic) return anthropic.create(request.request as never);
        return { choices: [{ index: 0, message: { role: 'assistant', content: responses.shift() ?? '{}' }, finish_reason: 'stop' }] };
    } } as EffectAdapter);
    executor = new DurableFlowExecutor({ kernel, plugins: createBuiltinDagPluginRegistry(), resolveTools: async (_session, ids) => ({
        definitions: ids.map(name => ({ type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } })), externalIds: [],
    }) });
    await kernel.initialize();
    await kernel.createSession({ id: 's', storage: { kind: 'test', locator: null } });
});

afterEach(async () => { kernel.dispose(); await executor.waitIdle(); await manager.dispose(); });

async function submit(parameters: Record<string, any> = {}) {
    const spec = await flowToDag(createFlowRevision(draft(), 1), node => node.plugin === 'builtin.agent'
        || (node.config as any).invocationContext === 'isolated' ? {} : {inputs: {...node.inputs, prompt: '${input.prompt}'}}, undefined,
        undefined, [], undefined, false, undefined, undefined,
        async (flow, bindings) => ({ ...flow, connections: flow.connections?.map(slot => ({ ...slot,
            connectionId: bindings?.[slot.name] || (slot.required === false && !(slot.name === 'vision' && parameters.images) ? undefined : `test-${slot.name}`) })) }));
    spec.input = {prompt: runtimePrompt};
    return executor.submit('s', spec, parameters);
}

it('loads the application recovery definition as one Flow with its complete internal function library', () => {
    const oldDirectory = new URL('../flows', import.meta.url);
    expect(existsSync(oldDirectory) ? readdirSync(oldDirectory).filter(name => name.endsWith('.flow')) : []).toEqual([]);
    expect(draft().id).toBe('anki-generate');
    expect(draft().functions.map((fn: any) => fn.id)).toEqual(['anki-build', 'anki-recognize-group', 'anki-complete-batch']);
    for (const id of ['anki-build', 'anki-generate', 'anki-complete-batch', 'anki-recognize-group']) {
        const external = definition(id);
        expect(validateFlowRevision(createFlowRevision(external, 1), createBuiltinDagPluginRegistry())).toEqual([]);
    }
    const edited = draft(); edited.nodes[0].name = 'User edit';
    expect(draft().nodes[0].name).not.toBe('User edit');
});

it('uses generic repeated Flow calls without passing agent or graph templates to tools', () => {
    const batch = definition('anki-build').nodes.find((node: any) => node.id === 'batch');
    expect(batch).toMatchObject({ plugin: 'builtin.transform', config: { operation: 'batch', batchSize: 20, parameter: 'cards' } });
    expect(batch).not.toHaveProperty('capabilities');
    const recognition = draft().nodes.find((node: any) => node.id === 'recognition').config.args;
    for (const field of ['template', 'preprocess', 'recognize']) expect(recognition).not.toHaveProperty(field);
    for (const [id, reference, call] of [['anki-build', '${nodes.batch.outputs.result}', 'dispatch-batches'], ['anki-generate', '${nodes.recognition.outputs.result.parameterSets}', 'dispatch-recognition']]) {
        const flow = definition(id);
        expect(flow.nodes.find((node: any) => node.id === call)).toMatchObject({
            plugin: 'builtin.flow', pluginVersion: '2.0.0', config: { parameterSets: reference, maxConcurrency: 4 },
        });
    }
});

it('collects missing words, repairs model output and sends complete cards to the external planning tool', async () => {
    responses = ['not JSON', JSON.stringify({ cards: [card] })];
    const run = await submit({ requirements: '保留我的例句 ${param.secret}' });
    await vi.waitFor(() => expect(run.nodes.has('collect')).toBe(true));
    const input = run.nodes.get('collect')!;
    await vi.waitFor(async () => expect((await input.status()).task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(0);
    await input.respond({ interactionId: 'input-1', value: { words: 'Unit 2\napple' } });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(2);
    const requestText = JSON.stringify(requests[0]);
    expect(requestText).toContain('apple');
    expect(requestText).toContain('保留我的例句 ${param.secret}');
    expect(requestText).toContain('test-text');
    expect(toolRequests.map(request => request.toolId)).toEqual(['anki.prepare', 'anki.prepare', 'anki.collect', 'anki.plan']);
    expect((toolRequests.at(-1)!.args as { cards: unknown }).cards).toMatchObject({ cards: [card] });
    expect((await run.nodes.get('build/package')!.status()).task.output).toMatchObject({ outputs: { result: { content: 'PACKED' } } });
});

it('fails after exhausted JSON repairs without publishing invalid cards', async () => {
    useAnthropic = true;
    responses = Array(3).fill('not JSON');
    const run = await submit({ words: JSON.stringify([{ name: 'apple', unit: 2, chn: '苹果' }]) });
    expect((await run.root.wait({ timeoutMs: 15000 })).status).toBe('failed');
    expect(requests).toHaveLength(3);
    expect(anthropicBodies).toHaveLength(3);
    expect(requests.every(request => (request.request as any).responseFormat.type === 'text')).toBe(true);
    expect(toolRequests.map(request => request.toolId)).toEqual(['anki.prepare', 'anki.prepare']);
});

it('keeps expression-like source text as data in repeated function arguments', async () => {
    const literal = '手工释义 ${param.privateToken}';
    responses = [JSON.stringify({ cards: [{ ...card, chn: literal }] })];
    const words = JSON.stringify([{ name: card.name, unit: card.unit, chn: literal }]);
    const run = await submit({ words });
    expect((await run.root.wait({ timeoutMs: 15000 })).status).toBe('succeeded');
    expect(JSON.stringify(requests[0])).toContain(literal);
    expect(toolRequests.at(-1)?.args).toMatchObject({ cards: { cards: [{ chn: literal }] } });
});

it('transcribes image inputs, waits for explicit correction and sends only corrected cards to the shared Flow', async () => {
    const image = 'data:image/png;base64,aGVsbG8=';
    responses = [JSON.stringify({ cards: [{ name: 'apple', unit: 2, symbol: '', chn: '苹果?' }] }), JSON.stringify({ cards: [card] })];
    const run = await submit({ images: [{ type: 'image_url', image_url: { url: image } }] });
    await vi.waitFor(async () => {
        const status = await run.root.status();
        if (status.task.status === 'failed') throw new Error(JSON.stringify(status.task.exit));
        expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined();
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0])).toContain(image);
    expect(JSON.stringify(requests[0])).toContain('test-vision');
    expect(toolRequests.map(request => request.toolId)).toEqual(['anki.recognize', 'image.process', 'anki.collect']);
    expect(toolRequests[1]).toMatchObject({toolId:'image.process',args:{recipe:{color:'grayscale',resize:{maxEdge:2048}}}});
    const review = run.nodes.get('review')!;
    const interaction = (await review.status()).task.interactions['input-1'];
    expect(interaction.payload).toMatchObject({ values: { cards: [{ chn: '苹果?' }] } });
    await review.respond({ interactionId: 'input-1', value: { cards: [{ name: 'apple', unit: 2, symbol: '/a/', chn: '青苹果' }] } });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain('青苹果');
    expect(JSON.stringify(requests[1])).not.toContain(image);
    expect(toolRequests.at(-1)?.args).toMatchObject({ source: [{ chn: '青苹果', symbol: '/a/' }] });
});

it('requests replacement images for unsupported image data before invoking a model', async () => {
    const run = await submit({ images: ['file:///etc/private.png'] });
    await vi.waitFor(async () => expect((await run.nodes.get('collect-images')?.status())?.task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(0);
    await run.root.cancel();
});

it('uses supplied text when images is an explicit empty array', async () => {
    responses = [JSON.stringify({ cards: [card] })];
    const run = await submit({ words: 'apple', images: [] });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(1);
    expect(run.nodes.has('collect-images')).toBe(false);
    expect(toolRequests.some(request => request.toolId === 'anki.recognize')).toBe(false);
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
});

it.each(['combined', 'grouped'])('processes text groups in %s mode and packages every card together', async processingMode => {
    const pear = { ...card, name: 'pear', chn: '梨' };
    responses = processingMode === 'combined' ? [JSON.stringify({ cards: [card, pear] })]
        : [JSON.stringify({ cards: [card] }), JSON.stringify({ cards: [pear] })];
    const run = await submit({ processingMode, wordsGroups: [JSON.stringify([{ name: 'apple', unit: 2 }]), JSON.stringify([{ name: 'pear', unit: 2 }])] });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(processingMode === 'combined' ? 1 : 2);
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
    expect(toolRequests.at(-1)?.args).toMatchObject({ cards: { cards: [card, pear] } });
    expect(run.nodes.has('collect-images')).toBe(false);
    expect(run.nodes.has('review')).toBe(false);
});

it.each(['combined', 'grouped'])('recognizes multiple images in %s mode before one corrected package', async processingMode => {
    const pear = { ...card, name: 'pear', chn: '梨' };
    const source = [card, pear].map(({ name, unit, symbol, chn }) => ({ name, unit, symbol, chn }));
    responses = processingMode === 'combined' ? [JSON.stringify({ cards: source })]
        : source.map(value => JSON.stringify({ cards: [value] }));
    responses.push(...(processingMode === 'combined' ? [JSON.stringify({ cards: [card, pear] })] : [card, pear].map(value => JSON.stringify({ cards: [value] }))));
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
    const run = await submit({ images: [image, image], processingMode });
    await vi.waitFor(async () => expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined());
    const review = run.nodes.get('review')!;
    expect((await review.status()).task.interactions['input-1'].payload).toMatchObject({ values: { cards: source } });
    expect(toolRequests.filter(request => request.toolId === 'image.process')).toHaveLength(processingMode === 'combined' ? 1 : 2);
    await review.respond({ interactionId: 'input-1', value: { cards: source } });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
    expect(toolRequests.at(-1)?.args).toMatchObject({ cards: { cards: [card, pear] } });
    expect(requests).toHaveLength(processingMode === 'combined' ? 2 : 4);
});

it('does not publish a package after bounded local schema repairs still leave required fields missing', async () => {
    responses = [JSON.stringify({ cards: [{ name: 'apple', unit: 2 }] })];
    const run = await submit({ words: 'apple' });
    expect((await run.root.wait({ timeoutMs: 15000 })).status).toBe('failed');
    expect(requests).toHaveLength(3);
    expect(toolRequests.some(request => request.toolId === 'anki.collect')).toBe(false);
    expect(toolRequests.some(request => request.toolId === 'anki.plan')).toBe(false);
});

it('repairs missing card fields locally while requesting plain text from the model provider', async () => {
    const { difficulty: _difficulty, collocations: _collocations, ...incomplete } = card;
    responses = [JSON.stringify({ cards: [incomplete] }), JSON.stringify({ cards: [card] })];
    const run = await submit({ words: 'apple' });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ request: { responseFormat: { type: 'text' } } });
    expect(JSON.stringify(requests[1])).toContain('difficulty');
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
});

it.each([['symbol', ''], ['symbol', ' \t '], ['memory_tips', '\n  ']])(
    'repairs a phrase with invalid generated %s=%j before the real collector accepts it', async (field, invalid) => {
        useAnthropic = true;
        const expected = {...card, name: 'look after', symbol: '/lʊk ˈɑːftə/'};
        responses = [JSON.stringify({cards: [{...expected, [field]: invalid}]}), JSON.stringify({cards: [expected]})];
        const run = await submit({words: JSON.stringify([{name: expected.name, unit: expected.unit, symbol: '', chn: expected.chn}])});
        const exit = await run.root.wait({timeoutMs: 15000});
        expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
        expect(requests).toHaveLength(2); expect(anthropicBodies).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain(field);
        expect(toolRequests.at(-1)?.args).toMatchObject({cards: {cards: [expected]}});
        expect((await run.nodes.get('build/package')!.status()).task.output).toMatchObject({outputs: {result: {content: 'PACKED'}}});
    });

it('runs image recognition and card generation through Anthropic text responses with bounded local JSON repairs', async () => {
    useAnthropic = true;
    const source = [{name: card.name, unit: card.unit, symbol: card.symbol, chn: card.chn}];
    const {difficulty: _difficulty, ...incomplete} = card;
    responses = ['not JSON', JSON.stringify({cards: source}), JSON.stringify({cards: [incomplete]}), JSON.stringify({cards: [card]})];
    const images = [{type: 'image_url', image_url: {url: 'data:image/png;base64,aGVsbG8='}}];
    const run = await submit({images, generateImages: false, generateAudio: false});
    await vi.waitFor(async () => expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined());
    expect(requests).toHaveLength(2);
    expect(toolRequests.some(request => request.toolId === 'anki.plan')).toBe(false);
    await run.nodes.get('review')!.respond({interactionId: 'input-1', value: {cards: source}});
    const exit = await run.root.wait({timeoutMs: 15000});
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(requests).toHaveLength(4); expect(anthropicBodies).toHaveLength(4);
    expect((await run.nodes.get('normalize')!.status()).task.input).toMatchObject({inputs: {prompt: runtimePrompt}});
    expect(requests.every(request => (request.request as any).responseFormat.type === 'text')).toBe(true);
    expect(anthropicBodies.every(body => !body.response_format && !body.output_config?.format)).toBe(true);
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
    expect(toolRequests.at(-1)?.args).toMatchObject({cards: {cards: [card]}, source});
    expect((await run.nodes.get('build/package')!.status()).task.output).toMatchObject({outputs: {result: {content: 'PACKED'}}});
});

it('keeps text supplied alongside images when compiling the single package', async () => {
    const pear = { ...card, name: 'pear', chn: '梨' };
    const source = [{ name: 'apple', unit: 2, symbol: '', chn: '苹果' }];
    responses = [JSON.stringify({ cards: source }), JSON.stringify({ cards: [card, pear] })];
    const images = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }];
    const run = await submit({ images, words: 'pear' });
    await vi.waitFor(async () => expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined());
    await run.nodes.get('review')!.respond({ interactionId: 'input-1', value: { cards: source } });
    const exit = await run.root.wait({ timeoutMs: 15000 });
    expect(exit.status, JSON.stringify(exit)).toBe('succeeded');
    expect(toolRequests.at(-1)?.args).toMatchObject({ source: [...source, { name: 'pear', unit: 2 }] });
    expect(toolRequests.filter(request => request.toolId === 'anki.plan')).toHaveLength(1);
});

it('rejects a grouped review that removes cards without updating group sizes', async () => {
    const source = [card, { ...card, name: 'pear' }].map(({ name, unit, symbol, chn }) => ({ name, unit, symbol, chn }));
    responses = source.map(value => JSON.stringify({ cards: [value] }));
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
    const run = await submit({ images: [image, image], processingMode: 'grouped' });
    await vi.waitFor(async () => expect((await run.nodes.get('review')?.status())?.task.interactions['input-1']).toBeDefined());
    await run.nodes.get('review')!.respond({ interactionId: 'input-1', value: { cards: source.slice(0, 1) } });
    expect((await run.root.wait({ timeoutMs: 15000 })).status).toBe('failed');
    expect(requests).toHaveLength(2);
    expect(toolRequests.some(request => request.toolId === 'anki.plan')).toBe(false);
});
