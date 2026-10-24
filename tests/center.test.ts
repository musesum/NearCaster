import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCenter } from '../src/ui/center.ts';
import { sampleProvider, SAMPLE_EGO_FID } from '../src/data/sample.ts';

test('Center on reads a fid, an @username, a full-width ＠username, or a bare name', () => {
  assert.deepEqual(parseCenter(' 3 '), { fid: 3 });
  assert.deepEqual(parseCenter('@DWR'), { name: 'dwr' });
  assert.deepEqual(parseCenter('＠agritoken'), { name: 'agritoken' });
  assert.deepEqual(parseCenter('vitalik.eth'), { name: 'vitalik.eth' });
  assert.deepEqual(parseCenter('@ base-name.base.eth'), { name: 'base-name.base.eth' });
});

test('Center on rejects empty, zero, signed, and non-name input', () => {
  for (const bad of ['', '@', '0', '-3', '1.5', '@a b', '<script>', '99999999999999999999']) assert.equal(parseCenter(bad), undefined, bad);
});

test('the sample provider resolves its own usernames and nothing else', async () => {
  const p = sampleProvider();
  const [ego] = await p.users([SAMPLE_EGO_FID]);
  assert.equal(await p.fidByName(ego.username.toLowerCase()), SAMPLE_EGO_FID);
  assert.equal(await p.fidByName('no-such-sample-user'), undefined);
});
