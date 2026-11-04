import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { packageCards, reconcilePackage } from '../node/package.mjs';
import { batchCards, collectCards, prepareSources, recognizeGroups } from '../node/batch.mjs';

process.env.ANKI_CLI_BIN ??= fileURLToPath(new URL('../target/debug/anki-cli', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
    const files = new Map(); const bytes = Buffer.from('ID3-fixture');
    const ref = { sessionId:'s',taskId:'media',owner:'tasks/media/task.seq',name:`${hash(bytes)}.bin`,sha256:hash(bytes),mimeType:'audio/mpeg',bytes:bytes.length };
    const context = { operationId:'stable-operation',timeoutMs:10000,signal:new AbortController().signal,
        readAsset:async () => bytes,
        vfs:{ readFile:async path => {if(!files.has(path))throw new Error('missing');return files.get(path).toString();},
            writeFile:async (path,text) => files.set(path,Buffer.from(text)),
            readBinaryFile:async path => {if(!files.has(path))throw new Error('missing');return files.get(path);},
            writeBinaryFile:async (path,data) => files.set(path,Buffer.from(data)) },
    };
    const args = { directory:'output',manifest:{version:1,deck:{id:12345,name:'英语单词'},output:'deck.apkg',cards:[{id:'apple.json',kind:'word',data:{name:'apple',chn:'苹果'}}],media:[]},
        media:[{card:0,field:'audio',result:{assets:[ref]}}] };
    return {files,context,args};
}
test('publishes YAML, actual media and apkg, then reconciles verified receipts without executing again', async () => {
    const {files,context,args} = fixture();
    const result = await packageCards(args,context);
    assert.ok(files.get(result.manifestPath).toString().includes('version: 1'));
    assert.equal(files.get(result.packagePath).subarray(0,2).toString(),'PK');
    assert.deepEqual(await reconcilePackage(args,context),{status:'completed',data:result});
    const media = [...files.keys()].find(path => path.endsWith('.mp3'));files.set(media,Buffer.from('corrupt'));
    assert.equal((await reconcilePackage(args,context)).status,'indeterminate');
    assert.equal((await reconcilePackage(args,{...context,operationId:'another-operation'})).status,'indeterminate');
});
test('rejects invalid output paths and media hashes before publishing a package', async () => {
    const {files,context,args} = fixture();args.directory='../outside';
    await assert.rejects(packageCards(args,context));assert.equal(files.size,0);
    args.directory='output';context.readAsset=async () => Buffer.from('tampered');
    await assert.rejects(packageCards(args,context),/checksum/);assert.equal(files.size,0);
});

const word = (name, unit = 1) => ({ name, unit, symbol: '/test/', chn: '测试', example_en: 'A test.', example_cn: '一个测试。', word_family: 'test', memory_tips: 'test', difficulty: '1', collocations: 'a test', image_prompt: 'A test scene.' });
const template = { id: 'generate', name: '补全', plugin: 'builtin.agent', config: { instruction: 'Complete {{cards}}' } };

test('business grouping returns parameter sets without building task graphs', () => {
    const groups = [Array.from({ length: 21 }, (_, index) => word(`a-${index}`)), [word('b')]], cards = groups.flat();
    const combined = batchCards({ cards, groups });
    const grouped = batchCards({ cards, groups, mode: 'grouped' });
    assert.deepEqual(combined.parameterSets.map(args => args.cards.length), [20, 2]);
    assert.deepEqual(grouped.parameterSets.map(args => args.cards.length), [20, 1, 1]);
    assert.deepEqual(grouped.parameterSets.flatMap(args => args.cards), cards);
    assert.equal(Object.hasOwn(grouped, 'spawn'), false);
    const images = [{ asset: 'a' }, { asset: 'b' }, { asset: 'c' }];
    const recognized = recognizeGroups({ images, groups: [[0, 1], [2]], groupUnits: [1, 8], mode: 'grouped' });
    assert.deepEqual(recognized.parameterSets, [{ images: images.slice(0, 2), unit: 1 }, { images: images.slice(2), unit: 8 }]);
    assert.equal(Object.hasOwn(recognized, 'spawn'), false);
    assert.throws(() => recognizeGroups({ images, groups: [[0], [1]], mode: 'grouped' }), /every image exactly once/);
});

test('large batches preserve every card, expose separate agent tasks and join before one result barrier', () => {
    const cards = Array.from({ length: 305 }, (_, index) => ({ name: `word-${index}`, unit: 1 }));
    cards[0].chn = '${param.secret}';
    const result = batchCards({ cards, template: { ...template, config: { instruction: 'Complete {{cards}} Requirements: {{requirements}}' } }, requirements: '${param.secret}' });
    assert.deepEqual(result.batches.map(group => group.length), [...Array(15).fill(20), 5]);
    assert.deepEqual(result.batches.flat(), cards);
    assert.equal(result.spawn.nodes.filter(node => node.plugin === 'builtin.agent').length, 16);
    assert.equal(JSON.stringify(result.spawn).includes('param.secret'), false);
    assert.equal(result.spawn.nodes[0].config.instruction, 'Complete ${nodes.batch.outputs.result.batches.0} Requirements: ${nodes.batch.outputs.result.requirements}');
    assert.equal(result.spawn.edges.filter(edge => edge.to === 'batch-collect').length, 17);
    assert.deepEqual(result.spawn.edges.find(edge => edge.id === 'batch-collect-result'), { id: 'batch-collect-result', from: 'batch-collect', to: '$upstream:batch-result', kind: 'data', output: 'result', input: 'input' });
});

test('combined and grouped content keep explicit boundaries and reject omitted source cards', () => {
    const groups = [Array.from({ length: 13 }, (_, index) => word(`a-${index}`)), [word('b')]], cards = groups.flat();
    assert.deepEqual(batchCards({ cards, groups, template }).batches.map(group => group.length), [14]);
    assert.deepEqual(batchCards({ cards, groups, template, mode: 'grouped' }).batches.map(group => group.length), [13, 1]);
    assert.throws(() => batchCards({ cards, groups: [groups[0]], template }), /every source card/);
    assert.throws(() => batchCards({ cards, batchSize: 21, template }), /1..20/);
});

test('recognition runs each complete image group with starting unit and references persisted images', () => {
    const images = [{ asset: 'a' }, { asset: 'b' }, { asset: 'c' }];
    const preprocess = { plugin: 'builtin.tool', config: { toolId: 'image.process', args: { images: '{{images}}' } } };
    const recognize = { plugin: 'builtin.agent', config: { messageTemplates: [{ role: 'user', content: [{ type: 'text', text: 'Starting unit {{unit}}' }] }, { role: 'user', content: '{{processedImages}}' }] } };
    const args = { images, preprocess, recognize, groups: [[0, 1], [2]], groupUnits: [1, 8], mode: 'grouped' };
    const result = recognizeGroups(args);
    assert.deepEqual(result.groups, [{ images: images.slice(0, 2), unit: 1 }, { images: images.slice(2), unit: 8 }]);
    assert.equal(result.spawn.nodes.length, 5);
    assert.equal(result.spawn.nodes[0].config.args.images, '${nodes.recognition.outputs.result.groups.0.images}');
    assert.equal(result.spawn.nodes[3].config.messageTemplates[1].content, '${nodes.recognition-preprocess-1.outputs.result.images}');
    assert.equal(result.spawn.nodes[3].config.messageTemplates[0].content[0].text, 'Starting unit ${nodes.recognition.outputs.result.groups.1.unit}');
    assert.equal(recognizeGroups({ ...args, mode: 'combined', groupUnits: [1] }).count, 1);
    assert.throws(() => recognizeGroups({ ...args, groups: [[0], [0, 2]] }), /every image exactly once/);
    assert.throws(() => recognizeGroups({ ...args, groups: [[0], [1]] }), /every image exactly once/);
});

test('collection restores order, preserves different units and rejects omissions, collisions and incomplete cards', async () => {
    const { context } = fixture(), expected = [word('fair', 3), word('fair', 8), word('apple')];
    const result = await collectCards({ sources: [{ cards: [expected[1], expected[0]] }, { cards: [expected[2]] }], expected }, context);
    assert.deepEqual(result.cards, expected);
    await assert.rejects(collectCards({ sources: [{ cards: expected.slice(1) }], expected }, context), /all input words/);
    await assert.rejects(collectCards({ sources: [{ cards: [expected[0], expected[0], expected[2]] }], expected }, context), /Duplicate/);
    await assert.rejects(collectCards({ sources: [{ cards: [{ ...expected[0], example_cn: '' }, ...expected.slice(1)] }], expected }, context), /example_cn/);
    await assert.rejects(collectCards({ sources: [{ cards: [{ ...expected[0], audio: 'invented.mp3' }, ...expected.slice(1)] }], expected }, context), /unsupported field/);
    await assert.rejects(collectCards({ sources: [{ cards: [{ name: 'apple', unit: {}, symbol: '', chn: '' }] }] }, context), /unit/);
    await assert.rejects(collectCards({ sources: [{ cards: [{ name: 'apple', unit: 1, symbol: '', chn: '', extra: 'unsafe' }] }] }, context), /unsupported field/);
    const incomplete = { ...expected[2] }; delete incomplete.difficulty; delete incomplete.collocations;
    await assert.rejects(collectCards({ sources: [{ cards: expected.slice(0, 2) }, { cards: [incomplete] }], expected }, context), /Model group 2 card 1: missing required fields: difficulty, collocations/);
});

test('prepare combines source kinds and groups without losing unit or source fields', async () => {
    const { context } = fixture();
    const result = await prepareSources({ source: [{ name: 'fair', unit: 3, chn: '公平', custom: 'keep' }], sources: ['Unit 8\nfair'], additionalSource: 'apple' }, context);
    assert.equal(result.cards.length, 3);
    assert.equal(result.cards[0].custom, 'keep');
    assert.deepEqual(result.groups.map(group => group.length), [1, 1, 1]);
    assert.equal((await prepareSources({ source: '', sources: ['apple'] }, context)).cards.length, 1);
    await assert.rejects(prepareSources({ source: '', sources: null }, context), /At least one/);
    await assert.rejects(prepareSources({ source: 'apple', additionalSource: 'apple' }, context), /Duplicate/);
});

test('image recognition group boundaries survive review, mixed text input and grouped generation', async () => {
    const { context } = fixture();
    const sources = [{ cards: [{ name: 'fair', unit: 3, symbol: '/feə/', chn: '公平' }] },
        { cards: [{ name: 'fair', unit: 8, symbol: '/feə/', chn: '展销会' }, { name: 'apple', unit: 8, symbol: '/æpl/', chn: '苹果' }] }];
    const recognized = await collectCards({ sources }, context);
    assert.deepEqual(recognized.groupSizes, [1, 2]);
    const reviewed = recognized.cards.map(card => ({ ...card, custom: 'reviewed' }));
    const prepared = await prepareSources({ source: reviewed, sourceGroupSizes: recognized.groupSizes, mode: 'grouped', additionalSource: 'orange' }, context);
    assert.deepEqual(prepared.groupSizes, [1, 2, 1]);
    assert.deepEqual(prepared.groups.slice(0, 2).flat(), reviewed);
    assert.deepEqual(batchCards({ ...prepared, mode: 'grouped', template }).batches.map(group => group.length), [1, 2, 1]);
    assert.deepEqual(batchCards({ ...prepared, mode: 'combined', template }).batches.map(group => group.length), [4]);
    await assert.rejects(prepareSources({ source: reviewed, sourceGroupSizes: [1, 1], mode: 'grouped' }, context), /total 2 does not match reviewed card count 3/);
    await assert.rejects(prepareSources({ source: reviewed, sourceGroupSizes: [0, 3], mode: 'grouped' }, context), /positive integers/);
    await assert.rejects(prepareSources({ source: '', sources: ['apple'], sourceGroupSizes: [1], mode: 'grouped' }, context), /require nonempty reviewed source/);
    assert.deepEqual((await prepareSources({ source: reviewed, sourceGroupSizes: [1, 1], mode: 'combined' }, context)).groupSizes, [3]);
});
