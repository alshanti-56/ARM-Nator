import { strict as assert } from 'node:assert';
import test from 'node:test';
import { matchRecoveryTrack } from './playback-restore-state';
test('restores matching language and role when engine track IDs change', () => {
  assert.equal(matchRecoveryTrack({label:'English',language:'en',role:'main'}, [{id:8,label:'English',language:'en',role:'commentary'},{id:31,label:'English',language:'en',role:'main'}]),31);
});
test('does not silently select unrelated default language by recycled numeric ID', () => {
  assert.equal(matchRecoveryTrack({label:'French',language:'fr'},[{id:1,label:'English',language:'en'}]),null);
});
