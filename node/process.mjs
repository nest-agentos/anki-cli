import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function invoke(args, input, context) {
    const binary = process.env.ANKI_CLI_BIN ?? fileURLToPath(new URL('../target/release/anki-cli', import.meta.url));
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stdout = '', stderr = '', settled = false, stopReason;
        const stop = () => child.kill('SIGKILL');
        const timer = setTimeout(() => { stopReason = 'anki-cli process timed out'; stop(); }, context.timeoutMs ?? 180000);
        context.signal?.addEventListener('abort', stop, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', data => { stdout += data; if (stdout.length > 16 * 1024 * 1024) { stopReason = 'anki-cli output exceeds 16 MiB character limit'; stop(); } });
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
        child.stdin.on('error', () => {});
        child.once('error', error => { settled = true; cleanup(); reject(error); });
        child.once('close', code => {
            cleanup(); if (settled) return;
            if (code !== 0 || context.signal?.aborted) return reject(new Error(context.signal?.aborted ? 'anki-cli process cancelled' : stopReason || stderr || `anki-cli exited with ${code}`));
            try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
        });
        function cleanup() { clearTimeout(timer); context.signal?.removeEventListener('abort', stop); }
        child.stdin.end(input === undefined ? '' : JSON.stringify(input));
        if (context.signal?.aborted) stop();
    });
}
