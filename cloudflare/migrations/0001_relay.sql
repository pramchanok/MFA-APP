-- New database only. Never apply to a Docker database as a migration/export.
-- Counters avoid full-table scans; quotas leave room for SQLite/index overhead.
CREATE TABLE relay_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  max_vaults INTEGER NOT NULL CHECK (max_vaults > 0),
  max_records INTEGER NOT NULL CHECK (max_records > 0),
  max_vault_bytes INTEGER NOT NULL CHECK (max_vault_bytes > 0),
  max_total_bytes INTEGER NOT NULL CHECK (max_total_bytes > 0)
);
INSERT INTO relay_limits VALUES (1, 20, 20000, 8388608, 134217728);
CREATE TABLE relay_stats (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  vault_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO relay_stats(singleton) VALUES (1);
CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  latest INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE records (
  vault_id TEXT NOT NULL REFERENCES vaults(id),
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY(vault_id, id),
  UNIQUE(vault_id, sequence)
);
CREATE TRIGGER vault_quota BEFORE INSERT ON vaults
WHEN NOT EXISTS (SELECT 1 FROM vaults WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'vault_quota_exceeded')
  WHERE (SELECT vault_count FROM relay_stats WHERE singleton = 1)
    >= (SELECT max_vaults FROM relay_limits WHERE singleton = 1);
END;
CREATE TRIGGER vault_count AFTER INSERT ON vaults
BEGIN
  UPDATE relay_stats SET vault_count = vault_count + 1 WHERE singleton = 1;
END;
-- A view trigger allocates a sequence per row inside ONE INSERT statement.
-- json_each allows a 100-record upload without 100 D1 queries/subrequests.
CREATE VIEW record_inbox AS SELECT vault_id, id, nonce, ciphertext FROM records;
CREATE TRIGGER append_record INSTEAD OF INSERT ON record_inbox
BEGIN
  SELECT RAISE(ABORT, 'record_conflict') WHERE EXISTS (
    SELECT 1 FROM records WHERE vault_id = NEW.vault_id AND id = NEW.id
      AND (nonce != NEW.nonce OR ciphertext != NEW.ciphertext)
  );
  SELECT RAISE(ABORT, 'record_quota_exceeded')
  WHERE NOT EXISTS (SELECT 1 FROM records WHERE vault_id = NEW.vault_id AND id = NEW.id)
    AND (
      (SELECT record_count FROM vaults WHERE id = NEW.vault_id)
        >= (SELECT max_records FROM relay_limits WHERE singleton = 1)
      OR (SELECT byte_count FROM vaults WHERE id = NEW.vault_id) + length(NEW.nonce) + length(NEW.ciphertext) + 128
        > (SELECT max_vault_bytes FROM relay_limits WHERE singleton = 1)
      OR (SELECT byte_count FROM relay_stats WHERE singleton = 1) + length(NEW.nonce) + length(NEW.ciphertext) + 128
        > (SELECT max_total_bytes FROM relay_limits WHERE singleton = 1)
    );
  INSERT INTO records(vault_id, id, sequence, nonce, ciphertext)
    SELECT NEW.vault_id, NEW.id, latest + 1, NEW.nonce, NEW.ciphertext
    FROM vaults WHERE id = NEW.vault_id
      AND NOT EXISTS (SELECT 1 FROM records WHERE vault_id = NEW.vault_id AND id = NEW.id);
END;
CREATE TRIGGER record_count AFTER INSERT ON records
BEGIN
  UPDATE vaults SET latest = NEW.sequence, record_count = record_count + 1,
    byte_count = byte_count + length(NEW.nonce) + length(NEW.ciphertext) + 128
    WHERE id = NEW.vault_id;
  UPDATE relay_stats SET byte_count = byte_count + length(NEW.nonce) + length(NEW.ciphertext) + 128
    WHERE singleton = 1;
END;
