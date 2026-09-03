import { execFileSync } from 'node:child_process';
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
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return 'unavailable';
  }
}

const pnpmVersion = readPnpmVersion();
const failures = [];

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
  process.exitCode = 1;
} else {
  console.log('Environment verification passed.');
}
