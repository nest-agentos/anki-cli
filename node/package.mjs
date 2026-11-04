import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { invoke } from './process.mjs';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const formats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
function directory(value) {
    if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid output directory');
    return value;
}
const receiptPath = (args, context) => `${directory(args.directory)}/.anki-receipts/${checksum(context.operationId)}.json`;
const inputHash = args => checksum(JSON.stringify(args));

export async function packageCards(args, context) {
    directory(args.directory);
    if (!context.operationId || !context.vfs?.writeBinaryFile) throw new Error('Packaging requires durable identity and writable workspace files');
    const root = await mkdtemp(path.join(tmpdir(), 'anki-cli-'));
    try {
        const manifest = structuredClone(args.manifest);
        manifest.media = [];
        await mkdir(path.join(root, 'media'));
        await materialize(root, manifest, args.media, context);
        await invoke(['manifest', '--output', path.join(root, 'anki.manifest.yaml')], manifest, context);
        const report = await invoke(['pack', path.join(root, 'anki.manifest.yaml')], undefined, context);
        return await publish(root, manifest, report, args, context);
    } finally { await rm(root, { recursive: true, force: true }); }
}
async function materialize(root, manifest, items, context) {
    for (const item of items) {
        if (!Number.isSafeInteger(item.card) || !manifest.cards[item.card] || !['image', 'audio', 'audio_example'].includes(item.field)) throw new Error('Invalid card media mapping');
        const assets = item.result?.assets;
        if (assets?.length !== 1 || !context.readAsset) throw new Error('Expected one authorized generated asset');
        const ref = assets[0], extension = formats[ref.mimeType];
        if (!extension || (item.field === 'image') !== ref.mimeType.startsWith('image/')) throw new Error('Unexpected media format');
        const bytes = await context.readAsset(ref);
        if (checksum(bytes) !== ref.sha256) throw new Error('Media checksum mismatch');
        const name = `${ref.sha256}.${extension}`, relative = `media/${name}`;
        if (!manifest.media.some(media => media.name === name)) {
            await writeFile(path.join(root, relative), bytes);
            manifest.media.push({ name, path: relative, sha256: ref.sha256 });
        }
        manifest.cards[item.card].data[item.field] = name;
    }
}
async function publish(root, manifest, report, args, context) {
    const key = args.export_key ?? checksum(context.operationId).slice(0,16);
    if (!/^[a-f0-9]{16}$/.test(key)) throw new Error('Invalid export key');
    const base = `${directory(args.directory)}/${key}`;
    const packagePath = `${base}/${report.output}`, manifestPath = `${base}/anki.manifest.yaml`;
    if ((await stat(path.join(root, report.output))).size > 128 * 1024 * 1024) throw new Error('Package exceeds workspace export limit (128 MiB)');
    for (const media of manifest.media) {
        context.signal?.throwIfAborted();
        await context.vfs.writeBinaryFile(`${base}/${media.path}`, await readFile(path.join(root, media.path)));
    }
    context.signal?.throwIfAborted();
    const yaml = await readFile(path.join(root, 'anki.manifest.yaml'), 'utf8');
    await context.vfs.writeBinaryFile(packagePath, await readFile(path.join(root, report.output)));
    await context.vfs.writeFile(manifestPath, yaml);
    const result = { ...report, packagePath, manifestPath };
    await context.vfs.writeFile(receiptPath(args, context), JSON.stringify({ input: inputHash(args), manifest: checksum(yaml), media: manifest.media, result }));
    return result;
}
export async function reconcilePackage(args, context) {
    if (!context.operationId || !context.vfs?.readBinaryFile) return { status: 'indeterminate' };
    try {
        const receipt = JSON.parse(await context.vfs.readFile(receiptPath(args, context)));
        if (receipt.input !== inputHash(args)) return { status: 'indeterminate' };
        const bytes = await context.vfs.readBinaryFile(receipt.result.packagePath);
        if (checksum(bytes) !== receipt.result.sha256 || checksum(await context.vfs.readFile(receipt.result.manifestPath)) !== receipt.manifest) return { status: 'indeterminate' };
        const base = receipt.result.manifestPath.slice(0, -'/anki.manifest.yaml'.length);
        for (const media of receipt.media) if (checksum(await context.vfs.readBinaryFile(`${base}/${media.path}`)) !== media.sha256) return { status: 'indeterminate' };
        return { status: 'completed', data: receipt.result };
    } catch { return { status: 'indeterminate' }; }
}
