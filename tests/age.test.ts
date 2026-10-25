import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageStop, stepFor, AGE_STEPS, type AgeWindow } from '../src/ui/age.ts';

test('Time runs unposted, then 1 minute to 10 years on a log scale, then all', () => {
  assert.equal(ageStop(0), 'unposted');
  assert.deepEqual(ageStop(1), { ms: 60000, label: '01m' });
  assert.equal((ageStop(AGE_STEPS - 1) as AgeWindow).label, '10y');
  assert.equal(ageStop(AGE_STEPS), undefined);
});

test('Time windows are distinct, grow, and read two digits and one unit letter', () => {
  let last = 0;
  const letters = new Set<string>();
  const labels: string[] = [];
  for (let s = 1; s < AGE_STEPS; s++) {
    const w = ageStop(s) as AgeWindow;
    assert.match(w.label, /^\d\d[mhdwMy]$/);
    assert.ok(w.ms > last, `step ${s}`);
    last = w.ms;
    letters.add(w.label[2]);
    labels.push(w.label);
  }
  assert.deepEqual([...letters], ['m', 'h', 'd', 'w', 'M', 'y']);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(!labels.includes('12M') && !labels.includes('60m') && !labels.includes('24h'));
});

test('stepFor picks the first window that reaches back far enough', () => {
  assert.equal(stepFor(0), 1);
  assert.equal(stepFor(90 * 60000), stepFor(2 * 3600000));
  assert.equal((ageStop(stepFor(3 * 86400000)) as AgeWindow).label, '03d');
  assert.equal(stepFor(20 * 365 * 86400000), AGE_STEPS);
});
