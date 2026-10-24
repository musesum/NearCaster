import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapchainProvider } from '../src/data/snapchain.ts';

// The node's link pages: `count` follows of fid 1, and a nextPageToken on every page.
function stubFetch(count: number, token: string) {
  const g = globalThis as unknown as { fetch: unknown };
  const real = g.fetch;
  g.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: Array.from({ length: count }, (_, i) => ({ data: { fid: 100 + i, linkBody: { type: 'follow', targetFid: 1 } } })), nextPageToken: token }),
  });
  return () => (g.fetch = real);
}

test('a short last page ends the list even though the node still sends a token', async () => {
  const restore = stubFetch(113, 'W251bGwsbnVsbF0=');
  try {
    const page = await snapchainProvider({ base: 'http://hub', pageSize: 500 }).followers(1);
    assert.equal(page.fids.length, 113);
    assert.equal(page.next, undefined);
  } finally {
    restore();
  }
});

test('a full page with a fresh token continues; the same token sent back ends the list', async () => {
  const restore = stubFetch(3, 'abc');
  try {
    const p = snapchainProvider({ base: 'http://hub', pageSize: 3 });
    assert.equal((await p.following(1)).next, 'abc');
    assert.equal((await p.following(1, 'abc')).next, undefined);
  } finally {
    restore();
  }
});
