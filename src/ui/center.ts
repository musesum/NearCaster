// "Center on" input: a fid, or a username with or without "@" (phone keyboards may send the full-width "＠").
export type CenterTarget = { fid: number } | { name: string };

// fname: 1-16 of a-z, 0-9, "-"; ENS name: dotted labels ending in .eth (name.eth, name.base.eth).
const FNAME = /^[a-z0-9][a-z0-9-]{0,15}$/;
const ENS = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/;

export function parseCenter(raw: string): CenterTarget | undefined {
  const s = raw.trim().replace(/^[@＠]/, '').trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s) > 0 && Number.isSafeInteger(Number(s)) ? { fid: Number(s) } : undefined;
  return FNAME.test(s) || ENS.test(s) ? { name: s } : undefined;
}
