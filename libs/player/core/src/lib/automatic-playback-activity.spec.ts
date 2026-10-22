import { strict as assert } from 'node:assert';
import test from 'node:test';
import { AutomaticPlaybackActivityLog, type AutomaticPlaybackActivity } from './automatic-playback-activity';

test('activity retains thirty-second verification when viewing is stopped', () => {
    let current: AutomaticPlaybackActivity | undefined;
    const log = new AutomaticPlaybackActivityLog(value => { current = value; });
    log.reset();
    log.start('https://user:secret@provider.test/private?token=secret', 'hls');
    log.update({ outcome: 'verified', verified: true }, 'verified');
    log.cancel();
    assert.equal(current?.status, 'cancelled');
    assert.equal(current?.attempts[0].outcome, 'verified');
    assert.equal(current?.attempts[0].verified, true);
    assert.doesNotMatch(JSON.stringify(current), /secret|private|token=/);
});

test('activity bounds history, preserves snapshots, skips duplicate updates and tolerates observer failures', () => {
    const values: AutomaticPlaybackActivity[] = [];
    const log = new AutomaticPlaybackActivityLog(value => { values.push(value); });
    log.reset();
    for (let attempt = 1; attempt <= 22; attempt++) log.start('https://provider.test/1', 'hls');
    assert.equal(values.at(-1)?.attempts.length, 20);
    assert.equal(values.at(-1)?.attempts[0].number, 3);
    assert.equal(values[1].attempts[0].number, 1);
    log.update({ outcome: 'playing' }, 'playing');
    const count = values.length;
    log.update({ outcome: 'playing' }, 'playing');
    assert.equal(values.length, count);
    log.stop('Recovery limit reached.');
    log.cancel();
    assert.equal(values.at(-1)?.stopReason, 'Recovery limit reached.');
    assert.doesNotThrow(() => new AutomaticPlaybackActivityLog(() => { throw new Error('Observer failed'); }).reset());
});
