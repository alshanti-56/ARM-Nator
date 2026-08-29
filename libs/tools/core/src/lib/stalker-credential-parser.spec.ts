import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStalkerCredentials } from './stalker-credential-parser';

test('parses Panel/Mac/Expires blocks and normalizes values', () => {
  const result = parseStalkerCredentials([
    '📡 Panel ➤ http://xpone.nl/c/',
    '📱 Mac ➤ 00:1a:79:19:4f:83',
    '⏰ Expires ➤ Unlimited (9999 Days)',
  ].join('\n'));
  assert.equal(result.invalidEntries.length, 0);
  assert.deepEqual(result.candidates[0] && {
    portalUrl: result.candidates[0].portalUrl,
    macAddress: result.candidates[0].macAddress,
    expiryText: result.candidates[0].expiryText,
  }, { portalUrl: 'http://xpone.nl/c', macAddress: '00:1A:79:19:4F:83', expiryText: 'Unlimited (9999 Days)' });
});

test('reports malformed blocks and duplicates', () => {
  const result = parseStalkerCredentials([
    'Panel: https://portal.test/c', 'Mac: 001A79123456',
    'Panel: https://portal.test/c/', 'Mac: 00-1A-79-12-34-56',
    'not a stalker entry',
  ].join('\n'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalidEntries.length, 1);
});
