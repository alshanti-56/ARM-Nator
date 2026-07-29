#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = join(workspaceRoot, 'graphify-out');
const runsRoot = join(outputRoot, 'runs');
const activeRunFile = join(outputRoot, '.active-run');
const linkedArtifacts = [
    'graph.json',
    'graph.html',
    'GRAPH_REPORT.md',
    '.graphify_labels.json',
];

function fail(message) {
    console.error(message);
    process.exit(1);
}

function validateRunName(name) {
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
        fail('Run name must contain only letters, numbers, hyphens, or underscores.');
    }
    return name;
}

function runDirectory(name) {
    return join(runsRoot, validateRunName(name));
}

function availableRuns() {
    if (!existsSync(runsRoot)) {
        return [];
    }
    return readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => existsSync(join(runsRoot, name, 'graph.json')))
        .sort();
}

function activeRun() {
    return existsSync(activeRunFile)
        ? readFileSync(activeRunFile, 'utf8').trim()
        : '';
}

function useRun(name) {
    const targetDirectory = runDirectory(name);
    if (!existsSync(join(targetDirectory, 'graph.json'))) {
        fail(`Named graph run "${name}" does not contain graph.json.`);
    }

    mkdirSync(outputRoot, { recursive: true });
    for (const artifact of linkedArtifacts) {
        const activePath = join(outputRoot, artifact);
        const targetPath = join(targetDirectory, artifact);

        if (existsSync(activePath) || lstatExists(activePath)) {
            const stat = lstatSync(activePath);
            if (!stat.isSymbolicLink()) {
                fail(
                    `Refusing to replace regular file ${activePath}. Register or move it into a named run first.`,
                );
            }
            unlinkSync(activePath);
        }

        if (existsSync(targetPath)) {
            symlinkSync(relative(outputRoot, targetPath), activePath);
        }
    }

    writeFileSync(activeRunFile, `${name}\n`, 'utf8');
    console.log(`Active Graphify run: ${name}`);
}

function lstatExists(path) {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function listRuns() {
    const selected = activeRun();
    const runs = availableRuns();
    if (runs.length === 0) {
        console.log('No named Graphify runs found.');
        return;
    }
    for (const name of runs) {
        console.log(`${name === selected ? '*' : ' '} ${name}`);
    }
}

function printPath(name) {
    const selected = name || activeRun();
    if (!selected) {
        fail('No active run. Pass a run name or use `graphify:runs use <name>`.');
    }
    const graphPath = join(runDirectory(selected), 'graph.json');
    if (!existsSync(graphPath)) {
        fail(`Named graph run "${selected}" does not contain graph.json.`);
    }
    console.log(graphPath);
}

function queryRun(name, questionParts) {
    const question = questionParts.join(' ').trim();
    if (!question) {
        fail('Provide a question to query.');
    }
    const graphPath = join(runDirectory(name), 'graph.json');
    if (!existsSync(graphPath)) {
        fail(`Named graph run "${name}" does not contain graph.json.`);
    }
    const result = spawnSync(
        'graphify',
        ['query', question, '--graph', graphPath],
        { cwd: workspaceRoot, stdio: 'inherit' },
    );
    process.exit(result.status ?? 1);
}

const [command = 'list', ...args] = process.argv.slice(2);
mkdirSync(runsRoot, { recursive: true });

switch (command) {
    case 'list':
        listRuns();
        break;
    case 'use':
        useRun(validateRunName(args[0]));
        break;
    case 'path':
        printPath(args[0]);
        break;
    case 'query':
        queryRun(validateRunName(args[0]), args.slice(1));
        break;
    default:
        fail('Usage: graphify-runs.mjs list | use <run> | path [run] | query <run> <question>');
}
