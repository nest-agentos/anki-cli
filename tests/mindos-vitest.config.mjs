import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const host = createRequire(new URL('../../../apps/cli/package.json', import.meta.url));
const packages = ['durable-kernel', 'vfs-core', 'kernel-adapters', 'llm-flow', 'driver-llm'];
const alias = packages.map(name => ({ find: new RegExp(`^@itookit/${name}$`), replacement: host.resolve(`@itookit/${name}`) }));
alias.push({ find: /^vitest$/, replacement: join(dirname(host.resolve('vitest/package.json')), 'dist/index.js') });

export default {
    root: repo,
    resolve: { alias },
    test: {
        environment: 'node',
        include: ['tools/anki-cli/tests/flow-integration.test.ts'],
        server: { deps: { inline: [/itookit/] } },
    },
};
