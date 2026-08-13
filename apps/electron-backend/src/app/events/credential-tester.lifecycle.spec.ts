import assert from 'node:assert/strict';
import test from 'node:test';
import { CredentialTesterBatchLifecycle } from './credential-tester.lifecycle';

const inputs = [
    {
        id: 'xtream',
        provider: 'xtream' as const,
        serverUrl: 'https://provider.test',
        username: 'user',
        password: 'secret',
    },
    {
        id: 'xtream-two',
        provider: 'xtream' as const,
        serverUrl: 'https://provider-two.test',
        username: 'user-two',
        password: 'secret-two',
    },
];

test('lifecycle uses the submitted source and maps detailed outcomes', () => {
    const lifecycle = new CredentialTesterBatchLifecycle('batch', inputs);
    lifecycle.markTesting('xtream', 10);
    const progress = lifecycle.recordResult({
        id: 'xtream',
        provider: 'xtream',
        status: 'valid',
        outcome: 'working',
        sourceUrl: 'https://attacker.test/?password=leak',
        message: 'secret',
        account: { status: 'Active', activeConnections: '1' },
    });

    assert.equal(progress?.current[0].status, 'valid');
    assert.equal(progress?.current[0].outcome, 'working');
    assert.equal(progress?.current[0].message, 'Source is valid.');
    assert.equal(progress?.current[0].sourceUrl, 'https://provider.test');
    assert.doesNotMatch(JSON.stringify(progress), /attacker/);
    assert.doesNotMatch(JSON.stringify(progress), /secret/);
});

test('exactly one terminal snapshot wins completion, cancellation, error, and teardown races', () => {
    const lifecycle = new CredentialTesterBatchLifecycle('batch', inputs);
    lifecycle.markTesting('xtream', 1);
    lifecycle.recordResult({
        id: 'xtream',
        provider: 'xtream',
        status: 'valid',
        outcome: 'working',
    });

    const terminals = [
        lifecycle.finish('cancelled'),
        lifecycle.finish('error'),
        lifecycle.finish('completed'),
        lifecycle.finish('error'),
    ].filter((value) => value !== null);

    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].lifecycleStatus, 'cancelled');
    assert.equal(terminals[0].completed, 2);
    assert.equal(terminals[0].current[1].outcome, 'cancelled');
});

test('normal completion retains worker outcomes and fills no missing terminal state', () => {
    const lifecycle = new CredentialTesterBatchLifecycle('batch', inputs);
    for (const input of inputs) {
        lifecycle.markTesting(input.id, 1);
        lifecycle.recordResult({
            id: input.id,
            provider: input.provider,
            status: 'invalid',
            outcome: input.provider === 'xtream' ? 'expired' : 'invalid-url',
        });
    }

    const terminal = lifecycle.finish('completed');

    assert.equal(terminal?.lifecycleStatus, 'completed');
    assert.equal(terminal?.completed, 2);
    assert.deepEqual(
        terminal?.current.map((result) => result.outcome),
        ['expired', 'expired']
    );
});
