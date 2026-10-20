import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));

for (const harness of [
    'embedded-mpv-native.service.lifecycle.test-harness.cjs',
    'ksplayer-metal-native.service.lifecycle.test-harness.cjs'
]) {
    test(`${harness} reports native disposal failures and retries honestly`, () => {
        const result = spawnSync(process.execPath, [join(directory, harness)], {
            cwd: process.cwd(),
            encoding: 'utf8'
        });
        assert.equal(
            result.status,
            0,
            `${result.stdout}\n${result.stderr}`
        );
        assert.match(result.stdout, /retains ownership for retry/);
    });
}
