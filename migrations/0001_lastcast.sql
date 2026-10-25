-- One row per account: its newest cast (unix ms, NULL = never cast) and when the hub was last asked (unix ms).
CREATE TABLE IF NOT EXISTS lastcast (
  fid INTEGER PRIMARY KEY,
  at INTEGER,
  checked INTEGER NOT NULL
);
