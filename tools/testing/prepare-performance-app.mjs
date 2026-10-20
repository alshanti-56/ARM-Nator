import { existsSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Creates a signed test-only clone; never changes the supplied application/profile.
const [sourceArgument, profileArgument, outputArgument, baselineWorkers] = process.argv.slice(2);
if (!sourceArgument || !profileArgument || !outputArgument) throw new Error('Usage: prepare-performance-app.mjs APP PROFILE OUTPUT_APP [BASELINE_WORKERS]');
const source = resolve(sourceArgument), profile = resolve(profileArgument), output = resolve(outputArgument);
const marker = JSON.parse(readFileSync(join(profile, 'catalogue-fixture.json'), 'utf8'));
if (marker.items !== 200_000 || marker.sources !== 10) throw new Error('A marked 200,000-item/ten-source profile is required');
if (existsSync(output)) throw new Error('Refusing to overwrite an existing fixture application');
mkdirSync(join(output, '..'), { recursive: true });
execFileSync('/bin/cp', ['-cR', source, output]);
const resources = join(output, 'Contents/Resources');
if (baselineWorkers) cpSync(resolve(baselineWorkers), join(resources, 'dist/apps/electron-backend/workers'), { recursive: true });
const plist = join(output, 'Contents/Info.plist');
for (const [key, value] of Object.entries({ ARM_NATOR_E2E_DATA_DIR: profile, ARM_NATOR_PERF_CAPTURE: '1', ELECTRON_IS_DEV: '0', ARM_NATOR_WEB_API_PORT: '4321' })) {
    execFileSync('/usr/bin/plutil', ['-replace', `LSEnvironment.${key}`, '-string', value, plist]);
}
const id = createHash('sha256').update(output).digest('hex').slice(0, 12);
execFileSync('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', `com.armnator.performance.${id}`, plist]);
// Preserve CFBundleName: Electron derives its helper bundle paths from it.
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', resolve('apps/electron-backend/macos/entitlements.mac.plist'), output], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', output], { stdio: 'inherit' });
console.log(JSON.stringify({ app: output, profile, timings: join(profile, 'user-data/performance/ui-timings.jsonl'), baselineWorkers: Boolean(baselineWorkers) }));
