// Time control, left to right: accounts that never cast, then an exponential window over the last cast
// (1 minute to 10 years), then everyone.
const MAX_MIN = 10 * 525960;
const SAMPLES = 160;
const UNITS: Array<[string, number]> = [['y', 525960], ['M', 43830], ['w', 10080], ['d', 1440], ['h', 60], ['m', 1]];

export type AgeWindow = { ms: number; label: string };

// Whole units, so the label states the window exactly ("05m", "12h", "03M"); a count that fills the next unit moves up.
function rounded(minutes: number): AgeWindow {
  const i = Math.max(0, UNITS.findIndex(([, u]) => minutes >= u));
  let [letter, unit] = UNITS[i];
  let n = Math.min(99, Math.max(1, Math.round(minutes / unit)));
  if (i > 0 && n * unit >= UNITS[i - 1][1]) {
    [letter, unit] = UNITS[i - 1];
    n = Math.max(1, Math.round((n * UNITS[i][1]) / unit));
  }
  return { ms: n * unit * 60000, label: `${String(n).padStart(2, '0')}${letter}` };
}

// Distinct windows only, so every slider step changes what draws.
const WINDOWS: AgeWindow[] = [];
for (let k = 0; k < SAMPLES; k++) {
  const w = rounded(Math.exp((k / (SAMPLES - 1)) * Math.log(MAX_MIN)));
  if (!WINDOWS.length || w.ms > WINDOWS[WINDOWS.length - 1].ms) WINDOWS.push(w);
}

// Step 0 = unposted, 1..WINDOWS.length = windows, AGE_STEPS = all.
export const AGE_STEPS = WINDOWS.length + 1;

export type TimeStop = 'unposted' | AgeWindow | undefined;

export function ageStop(step: number): TimeStop {
  const s = Math.floor(step);
  if (s <= 0) return 'unposted';
  return s >= AGE_STEPS ? undefined : WINDOWS[s - 1];
}

// The first step whose window reaches back `ms`; past 10 years, all.
export function stepFor(ms: number): number {
  const i = WINDOWS.findIndex((w) => w.ms >= ms);
  return i < 0 ? AGE_STEPS : i + 1;
}
