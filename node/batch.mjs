import { invoke } from './process.mjs';

const MAX_CARDS = 1000;
const fields = ['symbol', 'chn', 'example_en', 'example_cn', 'word_family', 'memory_tips', 'difficulty', 'collocations', 'image_prompt'];
const ref = (node, path = '') => `\${nodes.${node}.outputs.result${path ? `.${path}` : ''}}`;
const control = (from, to) => ({ id: `${from.replace(/[^\w-]/g, '_')}-${to}`, from, to, kind: 'control' });
const identity = card => JSON.stringify([String(card.unit ?? 1), card.name.trim().toLocaleLowerCase('en-US')]);

function graph(sourceNode, resultNode) {
    for (const id of [sourceNode, resultNode]) if (!/^[\w-]+$/.test(id)) throw new Error('Invalid batch node identity');
    return { idempotencyKey: `anki-${sourceNode}-v1`, nodes: [], edges: [], collect: `${sourceNode}-collect` };
}

function addWorker(spawn, node, sourceNode, parent = '$parent') {
    spawn.nodes.push(node);
    spawn.edges.push(control(`$upstream:${sourceNode}`, node.id), control(parent, node.id));
}

function finish(spawn, sources, resultNode, expected, sourceNode) {
    spawn.nodes.push({ id: spawn.collect, name: '汇总并校验所有分组', plugin: 'builtin.tool', pluginVersion: '1.0.0', inputs: {},
        capabilities: ['anki.collect'], config: { toolId: 'anki.collect', toolVersion: '1', approval: 'none', args: { sources, ...(expected ? { expected } : {}) } },
        outputPolicy: { includeInRunOutput: false, publishToHistory: false } });
    spawn.edges.push({ id: `${spawn.collect}-result`, from: spawn.collect, to: `$upstream:${resultNode}`, kind: 'data', output: 'result', input: 'input' });
    if (expected) spawn.edges.push(control(`$upstream:${sourceNode}`, spawn.collect));
    delete spawn.collect;
    return spawn;
}

export function batchCards({ cards, groups, mode = 'combined', batchSize = 20, template, requirements = '', sourceNode = 'batch', resultNode = 'batch-result' }) {
    if (!Array.isArray(cards) || !cards.length || cards.length > MAX_CARDS) throw new Error(`Expected 1..${MAX_CARDS} cards`);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new Error('Card batch size must be 1..20');
    const batches = cardBatches(cards, groups, mode, batchSize);
    const result = { cards, batches, requirements, count: cards.length, parameterSets: batches.map(cards => ({ cards })) };
    if (template === undefined) return result;
    if (template?.plugin !== 'builtin.agent' || !template.config?.instruction?.includes('{{cards}}')) throw new Error('Agent template must contain {{cards}} in its instruction');
    const spawn = graph(sourceNode, resultNode), sources = [];
    batches.forEach((_, index) => {
        const node = structuredClone(template);
        node.id = `${sourceNode}-generate-${index}`;
        node.name = `${template.name ?? '补全卡片'} ${index + 1}`;
        node.config.instruction = node.config.instruction.replaceAll('{{cards}}', ref(sourceNode, `batches.${index}`));
        node.config.instruction = node.config.instruction.replaceAll('{{requirements}}', ref(sourceNode, 'requirements'));
        addWorker(spawn, node, sourceNode);
        spawn.edges.push(control(node.id, spawn.collect));
        sources.push(ref(node.id));
    });
    return { ...result, spawn: finish(spawn, sources, resultNode, ref(sourceNode, 'cards'), sourceNode) };
}

function cardBatches(cards, groups, mode, size) {
    if (!['combined', 'grouped'].includes(mode)) throw new Error('Card mode must be combined or grouped');
    const parts = groups?.length ? groups : [cards];
    if (JSON.stringify(parts.flat()) !== JSON.stringify(cards)) throw new Error('Card groups must preserve every source card and its order');
    return (mode === 'combined' ? [cards] : parts).flatMap(group => {
        if (!Array.isArray(group) || !group.length) throw new Error('Card groups must be nonempty');
        const batches = [];
        for (let start = 0; start < group.length; start += size) batches.push(group.slice(start, start + size));
        return batches;
    });
}

function imageGroups(images, groups, mode) {
    if (!Array.isArray(images) || !images.length || images.length > 12) throw new Error('Expected 1..12 images');
    if (!['combined', 'grouped'].includes(mode)) throw new Error('Image mode must be combined or grouped');
    const indices = groups?.length ? groups : images.map((_, index) => [index]);
    const seen = new Set();
    for (const group of indices) {
        if (!Array.isArray(group) || !group.length) throw new Error('Image groups must be nonempty');
        for (const index of group) {
            if (!Number.isInteger(index) || index < 0 || index >= images.length || seen.has(index)) throw new Error('Image groups must reference every image exactly once');
            seen.add(index);
        }
    }
    if (seen.size !== images.length) throw new Error('Image groups must reference every image exactly once');
    return mode === 'combined' ? [images.map((_, index) => index)] : indices;
}

function recognitionNodes(args, index) {
    const { sourceNode, preprocess, recognize } = args;
    const process = structuredClone(preprocess), agent = structuredClone(recognize);
    process.id = `${sourceNode}-preprocess-${index}`;
    agent.id = `${sourceNode}-recognize-${index}`;
    if (process.plugin !== 'builtin.tool' || process.config?.args?.images !== '{{images}}') throw new Error('Preprocess template must use {{images}}');
    if (agent.plugin !== 'builtin.agent') throw new Error('Recognition template must be an agent');
    process.config.args.images = ref(sourceNode, `groups.${index}.images`);
    agent.config.messageTemplates = agent.config.messageTemplates.map(message => ({ ...message,
        content: message.content === '{{processedImages}}' ? ref(process.id, 'images') : Array.isArray(message.content)
            ? message.content.map(block => block.type === 'text' ? { ...block, text: block.text.replaceAll('{{unit}}', ref(sourceNode, `groups.${index}.unit`)) } : block) : message.content }));
    return [process, agent];
}

export function recognizeGroups({ images, groups, groupUnits = [], mode = 'combined', preprocess, recognize, sourceNode = 'recognition', resultNode = 'recognized' }) {
    const indices = imageGroups(images, groups, mode);
    if (groupUnits.length && groupUnits.length !== indices.length) throw new Error('Provide one starting unit per recognition group');
    const parameterSets = indices.map((group, index) => ({ images: group.map(item => images[item]), unit: groupUnits[index] ?? 1 }));
    const result = { groups: parameterSets, parameterSets, count: indices.length };
    if (preprocess === undefined && recognize === undefined) return result;
    if (!preprocess || !recognize) throw new Error('Legacy recognition planning requires both templates');
    const spawn = graph(sourceNode, resultNode), sources = [];
    indices.forEach((_, index) => {
        const [process, agent] = recognitionNodes({ sourceNode, preprocess, recognize }, index);
        addWorker(spawn, process, sourceNode);
        addWorker(spawn, agent, sourceNode, process.id);
        spawn.edges.push(control(agent.id, spawn.collect));
        sources.push(`\${nodes.${agent.id}.outputs.result}`);
    });
    return { ...result, spawn: finish(spawn, sources, resultNode) };
}

function parseCards(source) {
    const value = typeof source === 'string' ? JSON.parse(source) : source;
    if (value && !Array.isArray(value) && Object.keys(value).some(key => key !== 'cards')) throw new Error('Model response contains an unsupported property');
    const cards = Array.isArray(value) ? value : value?.cards;
    if (!Array.isArray(cards) || !cards.length) throw new Error('Every group must return a nonempty cards array');
    return cards;
}

function orderGenerated(cards, expected) {
    if (cards.length !== expected.length) throw new Error('Generated cards must match all input words; do not omit cards');
    const byIdentity = new Map();
    for (const card of cards) {
        if (typeof card?.name !== 'string' || !card.name.trim()) throw new Error('Generated card name is required');
        const key = identity(card);
        if (byIdentity.has(key)) throw new Error('Duplicate generated word identity within the same unit');
        byIdentity.set(key, card);
    }
    return expected.map(card => {
        const found = byIdentity.get(identity(card));
        if (!found) throw new Error('Generated word identity or unit does not match input');
        byIdentity.delete(identity(card));
        return found;
    });
}

function validateModelCards(cards, complete, group) {
    const allowed = new Set(complete ? ['name', 'unit', ...fields] : ['name', 'unit', 'symbol', 'chn']);
    for (const [index, card] of cards.entries()) {
        const fail = reason => { throw new Error(`Model group ${group + 1} card ${index + 1}: ${reason}`); };
        if (!card || Array.isArray(card) || typeof card !== 'object') fail('card must be an object');
        const missing = [...allowed].filter(key => !Object.hasOwn(card, key));
        if (missing.length) fail(`missing required fields: ${missing.join(', ')}`);
        if (Object.keys(card).some(key => !allowed.has(key))) fail('card contains an unsupported field');
        if (typeof card.name !== 'string' || !card.name.trim()) fail('card name is required');
        if (!['string', 'number'].includes(typeof card.unit) || !String(card.unit).trim() || (typeof card.unit === 'number' && !Number.isFinite(card.unit))) fail('unit must be a nonempty string or finite number');
        for (const key of allowed) {
            if (key === 'unit') continue;
            if (typeof card[key] !== 'string') fail(`field must be a string: ${key}`);
            if (complete && !card[key].trim()) fail(`generated field must be nonempty: ${key}`);
        }
        if (complete && !/^[1-5]$/.test(card.difficulty)) fail('difficulty must be 1..5');
    }
}

export async function collectCards({ sources, expected }, context) {
    if (!Array.isArray(sources) || !sources.length) throw new Error('No batch results to collect');
    const sourceGroups = sources.map(parseCards);
    sourceGroups.forEach((cards, group) => validateModelCards(cards, Boolean(expected), group));
    const cards = sourceGroups.flat();
    const ordered = expected ? orderGenerated(cards, expected) : cards;
    const result = await invoke(['prepare'], { source: JSON.stringify(ordered) }, context);
    const groups = expected ? [result.cards] : sourceGroups;
    return { ...result, groups, groupSizes: groups.map(group => group.length) };
}

function splitSource(cards, sizes, mode) {
    if (mode !== 'grouped' || !sizes?.length) return [cards];
    if (!Array.isArray(sizes) || sizes.some(size => !Number.isSafeInteger(size) || size < 1)) throw new Error('Source group sizes must be positive integers');
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (total !== cards.length) throw new Error(`Source group sizes total ${total} does not match reviewed card count ${cards.length}; update group sizes after adding or removing cards`);
    let offset = 0;
    return sizes.map(size => { const group = cards.slice(offset, offset + size); offset += size; return group; });
}

export async function prepareSources({ source, sources = [], additionalSource, sourceGroupSizes, mode = 'combined' }, context) {
    if (!['combined', 'grouped'].includes(mode)) throw new Error('Source mode must be combined or grouped');
    const present = value => Array.isArray(value) ? value.length > 0 : typeof value === 'string' && Boolean(value.trim());
    if (mode === 'grouped' && sourceGroupSizes?.length && !present(source)) throw new Error('Source group sizes require nonempty reviewed source cards');
    const inputs = [{ value: source, sizes: sourceGroupSizes }, ...[...(sources ?? []), additionalSource].map(value => ({ value }))].filter(input => present(input.value));
    if (!inputs.length) throw new Error('At least one word source is required');
    const groups = [];
    for (const { value, sizes } of inputs) {
        const result = await invoke(['prepare'], { source: typeof value === 'string' ? value : JSON.stringify(value) }, context);
        groups.push(...splitSource(result.cards, sizes, mode));
    }
    const result = await invoke(['prepare'], { source: JSON.stringify(groups.flat()) }, context);
    return { ...result, groups, groupSizes: groups.map(group => group.length) };
}
