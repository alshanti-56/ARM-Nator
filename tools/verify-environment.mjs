import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import packageJson from '../package.json' with { type: 'json' };

const expectedNode = packageJson.engines?.node;
const expectedPnpm = packageJson.engines?.pnpm;
const nodeVersion = process.versions.node;
const platform = `${process.platform}-${process.arch}`;

function readPnpmVersion() {
  try {
    return execFileSync('pnpm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim();
  } catch {
    return null;
  }
}

function readCommandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return 'unavailable';
  }
}

const pnpmVersion = readPnpmVersion();
const failures = [];

for (const [name, version] of [['engines.node', expectedNode], ['engines.pnpm', expectedPnpm]]) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    failures.push(`${name} must pin an exact version.`);
  }
}

let nvmVersion;
try {
  nvmVersion = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
} catch {
  failures.push('.nvmrc is missing; it must match engines.node.');
}
if (nvmVersion && nvmVersion !== expectedNode) {
  failures.push(`.nvmrc (${nvmVersion}) must match engines.node (${expectedNode}).`);
}
if (!nvmVersion && !failures.some((failure) => failure.startsWith('.nvmrc'))) {
  failures.push('.nvmrc must contain the exact engines.node version.');
}

const pinnedPnpm = packageJson.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)(?:\+sha512\.[a-f0-9]+)?$/)?.[1];
if (!pinnedPnpm || pinnedPnpm !== expectedPnpm) {
  failures.push(`packageManager must pin pnpm@${expectedPnpm} to match engines.pnpm.`);
}

const runtime = packageJson.devEngines?.runtime;
if (runtime?.name !== 'node' || runtime?.version !== expectedNode || runtime?.onFail !== 'error') {
  failures.push(`devEngines.runtime must pin Node ${expectedNode} with onFail: error to match engines.node.`);
}

if (expectedNode && nodeVersion !== expectedNode) {
  failures.push(`Node.js ${expectedNode} is required (found ${nodeVersion}).`);
}

if (expectedPnpm && pnpmVersion !== expectedPnpm) {
  failures.push(`pnpm ${expectedPnpm} is required (found ${pnpmVersion ?? 'not found'}).`);
}

if (platform !== 'darwin-arm64') {
  failures.push(`ARM-Nator requires darwin-arm64 (found ${platform}).`);
}

console.log(`Node.js: ${nodeVersion}`);
console.log(`pnpm: ${pnpmVersion ?? 'unavailable'}`);
console.log(`Electron: ${packageJson.dependencies?.electron ?? packageJson.devDependencies?.electron ?? 'unknown'}`);
console.log(`Platform: ${platform}`);
console.log(`Xcode: ${readCommandVersion('xcodebuild', ['-version'])}`);
console.log(`Swift: ${readCommandVersion('swift', ['--version'])}`);

if (failures.length > 0) {
  console.error('\nEnvironment verification failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error(`\nInstall Node.js ${expectedNode} directly and run npm install --global pnpm@${expectedPnpm}.`);
  console.error('Check command -v node and command -v pnpm; both must resolve to your direct installations.');
  console.error('Then run pnpm install --frozen-lockfile. Automatic runtime and package-manager downloads are disabled.');
  process.exitCode = 1;
} else {
  console.log('Environment verification passed.');
}
