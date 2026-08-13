import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceRoots = ['apps', 'libs'];

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
            extname(entry.name) === '.ts' &&
            entry.name.endsWith('.spec.ts')
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
).flat().filter((file) => file.includes('/src/'));

const nodeTestFiles = [];
const legacyTestFiles = [];

for (const file of candidates.sort()) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"]node:test['"]/.test(source)) {
        nodeTestFiles.push(file);
    } else {
        legacyTestFiles.push(file);
    }
}

console.log(
    `Running ${nodeTestFiles.length} Node test files; ${legacyTestFiles.length} legacy Angular/Jest files are not part of this runner.`
);

const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--test', ...nodeTestFiles.map((file) => relative(workspaceRoot, file))],
    {
        cwd: workspaceRoot,
        env: {
            ...process.env,
            TSX_TSCONFIG_PATH: 'tsconfig.base.json',
        },
        stdio: 'inherit',
    }
);

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
    }
    process.exit(code ?? 1);
});
