import { invoke } from './process.mjs';
import { createHash } from 'node:crypto';
import { packageCards, reconcilePackage } from './package.mjs';
import { batchCards, collectCards, prepareSources, recognizeGroups } from './batch.mjs';

export function createTools({ buildTool, z }) {
    const common = {
        version: '1', maxResultSizeChars: 8 * 1024 * 1024,
        async prompt() { return this.description(); },
        mapToolResultToToolResultBlockParam(data, id) { return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(data) }; },
    };
    return [
        buildTool({ ...common, name: 'anki.prepare', searchHint: 'Validate and normalize Anki words', isReadOnly: () => true,
            inputSchema: z.object({ source: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(), sources: z.array(z.string()).nullable().optional(), additionalSource: z.string().optional(),
                sourceGroupSizes: z.array(z.number().int().min(1)).optional(), mode: z.enum(['combined', 'grouped']).optional() }),
            async description() { return 'Parse word lines, Unit markers or WordData JSON before model requests. Validate identities and batch size.'; },
            async call(args, context) { return { data: await observed('anki.prepare', context, () => prepareSources(args, context)) }; },
        }),
        buildTool({ ...common, name: 'anki.batch', searchHint: 'Split card generation into durable Flow tasks', isReadOnly: () => true,
            inputSchema: z.object({ cards: z.array(z.record(z.string(), z.unknown())).min(1), groups: z.array(z.array(z.record(z.string(), z.unknown()))).optional(),
                mode: z.enum(['combined', 'grouped']).optional(), batchSize: z.number().int().min(1).max(20).optional(), template: z.record(z.string(), z.unknown()).optional(),
                requirements: z.string().optional(), sourceNode: z.string().optional(), resultNode: z.string().optional() }),
            async description() { return 'Validate card groups and return bounded parameter sets for repeated Flow function calls. Legacy templates remain compatible with saved runs.'; },
            async call(args, context) { return { data: await observed('anki.batch', context, () => batchCards(args)) }; },
        }),
        buildTool({ ...common, name: 'anki.recognize', searchHint: 'Plan whole-input or grouped image recognition tasks', isReadOnly: () => true,
            inputSchema: z.object({ images: z.array(z.unknown()).min(1).max(12), groups: z.array(z.array(z.number().int().min(0))).optional(),
                groupUnits: z.array(z.union([z.string(), z.number()])).optional(), mode: z.enum(['combined', 'grouped']).optional(),
                preprocess: z.record(z.string(), z.unknown()).optional(), recognize: z.record(z.string(), z.unknown()).optional(), sourceNode: z.string().optional(), resultNode: z.string().optional() }),
            async description() { return 'Validate image groups and return image/unit parameter sets for repeated Flow function calls. Legacy templates remain compatible with saved runs.'; },
            async call(args, context) { return { data: await observed('anki.recognize', context, () => recognizeGroups(args)) }; },
        }),
        buildTool({ ...common, name: 'anki.collect', searchHint: 'Join all Anki batch outputs without dropping cards', isReadOnly: () => true,
            inputSchema: z.object({ sources: z.array(z.unknown()).min(1), expected: z.array(z.record(z.string(), z.unknown())).optional() }),
            async description() { return 'Join all batch results, validate card identities and required generated fields, and restore source order.'; },
            async call(args, context) { return { data: await observed('anki.collect', context, () => collectCards(args, context)) }; },
        }),
        buildTool({ ...common, name: 'anki.plan', searchHint: 'Plan Anki card media tasks', isReadOnly: () => true,
            inputSchema: z.object({ cards: z.unknown(), source: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]).optional(), deck_name: z.string().min(1), directory: z.string().min(1), images: z.boolean(), audio: z.boolean(), voice: z.string().optional() }),
            async description() { return 'Validate word cards and construct deterministic media and packaging nodes. Does not call models or write project files.'; },
            async call(args, context) {
                const generated = typeof args.cards === 'string' ? JSON.parse(args.cards) : args.cards;
                const cards = Array.isArray(generated) ? generated : generated.cards;
                if (!context.operationId) throw new Error('Planning requires a durable operation identity');
                const export_key = createHash('sha256').update(context.operationId).digest('hex').slice(0,16);
                return { data: await invoke(['plan'], { ...args, source: sourceText(args.source), cards, export_key }, context) };
            },
        }),
        buildTool({ ...common, name: 'anki.package', searchHint: 'Package Anki cards with media',
            inputSchema: z.object({ manifest: z.record(z.string(), z.unknown()), directory: z.string().min(1), export_key: z.string().regex(/^[a-f0-9]{16}$/).optional(), media: z.array(z.object({ card: z.number().int().min(0), field: z.enum(['image','audio','audio_example']), result: z.unknown() })) }),
            async description() { return 'Export authorized generated media, write anki.manifest.yaml and atomically build deck.apkg using the Rust anki-cli.'; },
            async call(args, context) { return { data: await packageCards(args, context) }; },
            reconcile: reconcilePackage,
        }),
    ];
}

function sourceText(value) { return value === undefined || typeof value === 'string' ? value : JSON.stringify(value); }

async function observed(operation, context, action) {
    const stages = { 'anki.prepare': 'normalize', 'anki.batch': 'plan-generation', 'anki.recognize': 'plan-recognition', 'anki.collect': 'join-results' };
    const start = Date.now(), identity = { operation, operationId: context.operationId, stage: stages[operation] };
    try {
        const result = await action();
        await context.onProgress?.({ message: JSON.stringify({ ...identity, result: 'success', durationMs: Date.now() - start,
            count: result.count ?? result.cards?.length, groupCount: result.groups?.length, batchCount: result.batches?.length }) });
        return result;
    } catch (error) {
        await context.onProgress?.({ message: JSON.stringify({ ...identity, result: 'failure', category: 'invalid-batch-data', durationMs: Date.now() - start, errorType: error.name }) });
        throw error;
    }
}
