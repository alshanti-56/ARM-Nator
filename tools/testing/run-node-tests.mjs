import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoots = ['apps', 'libs', 'tools/embedded-mpv', 'tools/packaging', 'tools/testing'];
const testConcurrency = Number(process.env.ARM_NATOR_NODE_TEST_CONCURRENCY ?? Math.min(4, availableParallelism()));
if (!Number.isSafeInteger(testConcurrency) || testConcurrency < 1) throw new Error('ARM_NATOR_NODE_TEST_CONCURRENCY must be a positive integer');

async function collectSpecFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (entry.name === 'node_modules') {
            continue;
        }

        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await collectSpecFiles(absolutePath)));
        } else if (
            entry.isFile() &&
            ((extname(entry.name) === '.ts' &&
                entry.name.endsWith('.spec.ts')) ||
                entry.name.endsWith('.test.mjs'))
        ) {
            files.push(absolutePath);
        }
    }

    return files;
}

const candidates = (
    await Promise.all(
        sourceRoots.map((sourceRoot) =>
            collectSpecFiles(join(workspaceRoot, sourceRoot))
        )
    )
)
    .flat()
    .filter((file) => file.includes('/src/') || file.endsWith('.test.mjs'));

const nodeTestFiles = [];
const angularJestTestFiles = [];

for (const file of candidates.sort()) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"]node:test['"]/.test(source)) {
        nodeTestFiles.push(file);
    } else {
        angularJestTestFiles.push(file);
    }
}

console.log(
    `Running ${nodeTestFiles.length} Node test files; ${angularJestTestFiles.length} Angular/Jest files are run separately by pnpm test:angular.`
);

// Electron downloads a missing runtime on first require. Finish extraction in
// this process before parallel workers can observe a partially written binary.
createRequire(import.meta.url)('electron');

const child = spawn(
    process.execPath,
    [
        '--import',
        'tsx',
        '--test',
        `--test-concurrency=${testConcurrency}`,
        ...nodeTestFiles.map((file) => relative(workspaceRoot, file))
    ],
    {
        cwd: workspaceRoot,
        env: {
            ...process.env,
            TSX_TSCONFIG_PATH: 'tsconfig.base.json'
        },
        stdio: 'inherit'
    }
);

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
    }
    process.exit(code ?? 1);
});
