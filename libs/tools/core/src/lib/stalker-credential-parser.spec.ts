import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStalkerCredentialKey,
  normalizeStalkerPortalUrl,
  parseStalkerCredentials,
} from './stalker-credential-parser';

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
  }, { portalUrl: 'http://xpone.nl/c', macAddress: '00:1A:79:19:4F:83' });
  assert.equal('expiryText' in (result.candidates[0] ?? {}), false);
});

test('reports malformed blocks and duplicates', () => {
  const result = parseStalkerCredentials([
    'Panel: https://portal.test/c', 'Mac: 001A79123456',
    'Panel: https://portal.test/c/', 'Mac: 00-1A-79-12-34-56',
    'Mac: invalid',
  ].join('\n'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalidEntries.length, 1);
});

test('preserves basic-auth credentials and canonicalizes a root portal', () => {
  const result = parseStalkerCredentials([
    'Panel: https://user:Secret@portal.test///?tenant=one#fragment',
    'Mac: 00:1A:79:12:34:56',
  ].join('\n'));

  assert.equal(result.invalidEntries.length, 0);
  assert.equal(result.candidates[0]?.portalUrl, 'https://user:Secret@portal.test');
  assert.equal(
    result.candidates[0]?.normalizedKey,
    createStalkerCredentialKey('https://user:Secret@portal.test/', '00:1A:79:12:34:56')
  );
  assert.equal(normalizeStalkerPortalUrl('https://portal.test/'), 'https://portal.test');
});

test('does not collapse basic-auth passwords that differ only by case', () => {
  const result = parseStalkerCredentials([
    'Panel: https://user:Secret@portal.test/c', 'Mac: 001A79123456',
    'Panel: https://user:secret@portal.test/c', 'Mac: 001A79123456',
  ].join('\n'));

  assert.equal(result.candidates.length, 2);
  assert.equal(result.duplicates.length, 0);
});

test('parses a shared portal followed by MACs with optional listed dates', () => {
  const result = parseStalkerCredentials([
    'http://portal.test/c/',
    '00:1A:79:00:1C:02 - December 12, 2026, 5:01 pm',
    '00:1A:79:00:1C:6C - November 20, 2026, 4:42 pm',
    '',
    '00:1a:79:00:1c:02',
    'Mac: invalid',
    'https://second.test/c/',
    'Mac: 001A79001CAA',
  ].join('\n'));
  assert.equal(result.candidates.length, 3);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalidEntries.length, 1);
  assert.equal(result.candidates[1].portalUrl, 'http://portal.test/c');
  assert.equal(result.candidates[2].portalUrl, 'https://second.test/c');
  assert.match(result.candidates[0].originalText, /December 12, 2026/);
  assert.equal('expiryText' in result.candidates[0], false);
});

test('rejects malformed MAC suffixes and enforces the unique limit', () => {
  const result = parseStalkerCredentials([
    'https://portal.test/c',
    '00:1A:79:00:1C:02junk',
    '00:1A:79:00:1C:02',
    '00:1A:79:00:1C:02 - December 12, 2026',
    '00:1A:79:00:1C:6C',
  ].join('\n'), 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.invalidEntries.length, 2);
});

for (const [name, input] of [
  ['same line', 'Portal https://portal.test/c/ | MAC 00:1a:79:aa:bb:cc | expires tomorrow'],
  ['reversed same line', '00-1A-79-AA-BB-CC, https://portal.test/c/'],
  ['decorated', '╔══ My playlist ══╗\n🌐 Address ➜ <https://portal.test/c/>\n📺 Device ➜ [00:1A:79:AA:BB:CC]\n╚════════╝'],
  ['markdown', '| Server | Device |\n| --- | --- |\n| [Portal](https://portal.test/c/) | `001A79AABBCC` |'],
  ['HTML', '<div>Portal: <a href="https://portal.test/c/">Open</a></div><div>MAC: 00:1A:79:AA:BB:CC</div>'],
  ['JSON', JSON.stringify({ device: '001A.79AA.BBCC', address: 'https://portal.test/c/' }, null, 2)],
  ['spaced MAC', 'https://portal.test/c/\nDevice: 00 1A 79 AA BB CC'],
  ['scheme omitted', 'Portal: portal.test/c/\nMac: 00:1A:79:AA:BB:CC'],
  ['URL after MAC', 'MAC: 00:1A:79:AA:BB:CC\nPortal: https://portal.test/c/'],
]) {
  test(`extracts portal and MAC from ${name}`, () => {
    const result = parseStalkerCredentials(input);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].macAddress, '00:1A:79:AA:BB:CC');
    assert.equal(result.candidates[0].portalUrl, name === 'scheme omitted' ? 'http://portal.test/c' : 'https://portal.test/c');
    assert.equal(result.invalidEntries.length, 0);
  });
}

test('pairs separate JSON records and inherits a shared portal for nested MAC lists', () => {
  const result = parseStalkerCredentials(JSON.stringify([
    { mac: '001A79AABBCC', portal: 'https://one.test/c' },
    { portal: 'https://two.test/c', devices: [{ mac: '001A79AABBDD' }, { mac: '001A79AABBEE' }] },
  ], null, 2));
  assert.deepEqual(result.candidates.map(c => [c.portalUrl, c.macAddress]), [
    ['https://one.test/c', '00:1A:79:AA:BB:CC'],
    ['https://two.test/c', '00:1A:79:AA:BB:DD'],
    ['https://two.test/c', '00:1A:79:AA:BB:EE'],
  ]);
  assert.equal(result.invalidEntries.length, 0);
});

test('does not guess which of multiple URLs on a line owns a MAC', () => {
  const result = parseStalkerCredentials('https://one.test/c https://two.test/c 00:1A:79:AA:BB:CC');
  assert.equal(result.candidates.length, 0);
  assert.match(result.invalidEntries[0]?.reason ?? '', /multiple|ambiguous/i);
});

test('never extracts MACs from URLs or from longer identifiers', () => {
  const result = parseStalkerCredentials('https://portal.test/001A79AABBCC\n001A79AABBCCjunk\nserial: f001A79AABBCCa');
  assert.equal(result.candidates.length, 0);
});

test('reports MACs without a portal instead of inventing one', () => {
  const result = parseStalkerCredentials('MAC: 00:1A:79:AA:BB:CC');
  assert.equal(result.candidates.length, 0);
  assert.match(result.invalidEntries[0].reason, /No portal/);
});

test('reads a MAC query parameter without mistaking other URL fields for devices', () => {
  const result = parseStalkerCredentials('https://portal.test/portal.php?mac=00%3A1A%3A79%3AAA%3ABB%3ACC&token=001A79AABBDD');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].portalUrl, 'https://portal.test/portal.php');
  assert.equal(result.candidates[0].macAddress, '00:1A:79:AA:BB:CC');
});

test('understands code-fenced JSON records and punctuation around MACs', () => {
  const result = parseStalkerCredentials('```json\n' + JSON.stringify([
    { mac: '00:1A:79:AA:BB:CC', portal: 'https://one.test/c' },
    { mac: '00:1A:79:AA:BB:DD', portal: 'https://two.test/c' },
  ], null, 2) + '\n```');
  assert.deepEqual(result.candidates.map(c => c.portalUrl), ['https://one.test/c', 'https://two.test/c']);
  const punctuated = parseStalkerCredentials('https://one.test/c\nMAC = (00 : 1A : 79 : AA : BB : CC).');
  assert.equal(punctuated.candidates.length, 1);
});

test('reports ambiguity for a leading MAC when multiple portal blocks follow', () => {
  const result = parseStalkerCredentials('00:1A:79:AA:BB:CC\nhttps://one.test/c\nhttps://two.test/c');
  assert.equal(result.candidates.length, 0);
  assert.match(result.invalidEntries[0].reason, /Ambiguous/);
});

test('keeps reversed plain-text records in their own blank-line blocks', () => {
  const result = parseStalkerCredentials([
    'Device = 00:1A:79:AA:BB:CC', 'Portal = https://one.test/c', '',
    'Device = 00:1A:79:AA:BB:DD', 'Portal = https://two.test/c',
  ].join('\n'));
  assert.deepEqual(result.candidates.map(c => c.portalUrl), ['https://one.test/c', 'https://two.test/c']);
  assert.equal(result.invalidEntries.length, 0);
});

test('does not report decorated expiry, serial, or device IDs as invalid MACs', () => {
  const result = parseStalkerCredentials([
    'http://portal.test/stalker_portal/c/',
    'Mac 00:1a:79:01:07:06',
    '𝐄𝐗𝐏 𝐃𝐚𝐭𝐞 2026-08-07',
    '🔥 🆅🅿️🅽 Toronto',
    '𝐒𝐍 12345678901A3',
    '𝐃𝐞𝐯𝐢𝐜𝐞𝐈𝐃 ¹💥² AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ].join('\n'));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.invalidEntries.length, 0);
});
