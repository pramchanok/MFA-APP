import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BODY_LIMIT = 1024 * 1024;
const PAGE_SIZE = 100;
const hash = (value) => createHash('sha256').update(value).digest();
const isToken = (value) => typeof value === 'string' && TOKEN.test(value)
  && Buffer.from(value, 'base64url').length === 32
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const object = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new HttpError(status, code); };

function strictBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length >= minimum && decoded.length <= maximum
    && decoded.toString('base64') === value;
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'json_required');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    fail(415, 'encoding_not_supported');
  }
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) fail(413, 'body_too_large');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > BODY_LIMIT) fail(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text);
  } catch { fail(400, 'invalid_json'); }
}

/** Opaque immutable-record relay. Caller owns server.listen/close and must then call close(). */
export function createRelay({ registrationToken, databasePath = ':memory:',
  maxVaults = 1000, maxRecordsPerVault = 100000, maxBytesPerVault = 64 * 1024 * 1024,
  maxTotalBytes = 1024 * 1024 * 1024, rateLimit = 120, maxRateBuckets = 10000,
  now = Date.now } = {}) {
  if (!isToken(registrationToken)) throw new Error('SYNC_REGISTRATION_TOKEN must be a canonical 32-byte base64url token');
  for (const value of [maxVaults, maxRecordsPerVault, maxBytesPerVault, maxTotalBytes, rateLimit, maxRateBuckets]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Limits must be positive safe integers');
  }
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  if (db.prepare('PRAGMA user_version').get().user_version > 1) {
    db.close();
    throw new Error('Unsupported database schema version');
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS vaults (
      id TEXT PRIMARY KEY, token_hash BLOB NOT NULL, latest INTEGER NOT NULL DEFAULT 0,
      record_count INTEGER NOT NULL DEFAULT 0, byte_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS records (
      vault_id TEXT NOT NULL REFERENCES vaults(id), id TEXT NOT NULL,
      sequence INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL,
      PRIMARY KEY(vault_id,id), UNIQUE(vault_id,sequence)
    ); PRAGMA user_version=1;`);
  const ownerHash = hash(registrationToken);
  const dummyHash = hash('unknown vault');
  const buckets = new Map();
  function limit(key) {
    const time = now();
    let bucket = buckets.get(key);
    if (!bucket || time - bucket.start >= 60000) {
      if (!bucket && buckets.size >= maxRateBuckets) {
        for (const [id, old] of buckets) if (time - old.start >= 60000) buckets.delete(id);
        if (buckets.size >= maxRateBuckets) fail(429, 'rate_limited');
      }
      bucket = { start: time, count: 0 };
      buckets.set(key, bucket);
    }
    if (++bucket.count > rateLimit) fail(429, 'rate_limited');
  }
  function bearer(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    if (!match || !isToken(match[1])) fail(401, 'unauthorized');
    return hash(match[1]);
  }
  function authenticatedVault(req, id) {
    const supplied = bearer(req);
    const vault = db.prepare('SELECT * FROM vaults WHERE id=?').get(id);
    if (!same(supplied, vault?.token_hash ?? dummyHash) || !vault) fail(401, 'unauthorized');
    limit(`vault:${id}`);
    return vault;
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY', ...(status === 429 ? { 'retry-after': '60' } : {}) });
    res.end(JSON.stringify(body));
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000,
    headersTimeout: 5000, keepAliveTimeout: 5000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    try {
      limit(`ip:${req.socket.remoteAddress ?? 'unknown'}`);
      const url = new URL(req.url, 'http://relay.invalid');
      if (url.pathname === '/health' && req.method === 'GET' && !url.search) {
        return reply(res, 200, { status: 'ok' });
      }
      if (url.pathname === '/v1/vaults' && req.method === 'POST' && !url.search) {
        if (!same(bearer(req), ownerHash)) fail(401, 'unauthorized');
        const body = await readJson(req);
        if (!object(body, ['vaultId', 'authToken']) || typeof body.vaultId !== 'string'
          || !UUID.test(body.vaultId) || !isToken(body.authToken)) fail(400, 'invalid_registration');
        const existing = db.prepare('SELECT token_hash FROM vaults WHERE id=?').get(body.vaultId);
        const tokenHash = hash(body.authToken);
        if (existing) {
          if (!same(existing.token_hash, tokenHash)) fail(409, 'vault_conflict');
          return reply(res, 200, { vaultId: body.vaultId });
        }
        if (db.prepare('SELECT COUNT(*) AS count FROM vaults').get().count >= maxVaults) fail(413, 'vault_quota_exceeded');
        db.prepare('INSERT INTO vaults(id,token_hash) VALUES(?,?)').run(body.vaultId, tokenHash);
        return reply(res, 201, { vaultId: body.vaultId });
      }
      const route = /^\/v1\/vaults\/([0-9a-f-]+)\/records$/.exec(url.pathname);
      if (!route || !UUID.test(route[1])) fail(404, 'not_found');
      const id = route[1];
      authenticatedVault(req, id);
      if (req.method === 'GET') {
        if ([...url.searchParams.keys()].some((key) => key !== 'after')
          || url.searchParams.getAll('after').length > 1) fail(400, 'invalid_cursor');
        const raw = url.searchParams.get('after') ?? '0';
        if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(400, 'invalid_cursor');
        const after = Number(raw);
        const latest = db.prepare('SELECT latest FROM vaults WHERE id=?').get(id).latest;
        if (after > latest) fail(409, 'cursor_ahead');
        const candidates = db.prepare('SELECT sequence,id,nonce,ciphertext FROM records WHERE vault_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, after, PAGE_SIZE);
        const records = [];
        let responseBytes = 256;
        for (const record of candidates) {
          const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
          if (responseBytes + bytes > BODY_LIMIT - 1024) break;
          records.push(record);
          responseBytes += bytes;
        }
        const cursor = records.at(-1)?.sequence ?? after;
        return reply(res, 200, { records, cursor, hasMore: cursor < latest, latest });
      }
      if (req.method !== 'POST') fail(405, 'method_not_allowed');
      if (url.search) fail(400, 'unexpected_query');
      const body = await readJson(req);
      if (!object(body, ['records']) || !Array.isArray(body.records) || body.records.length > PAGE_SIZE) fail(400, 'invalid_records');
      const unique = new Map();
      for (const record of body.records) {
        if (!object(record, ['id', 'nonce', 'ciphertext']) || typeof record.id !== 'string'
          || !UUID.test(record.id) || !strictBase64(record.nonce, 12, 12)
          || !strictBase64(record.ciphertext, 16, 65536)) fail(400, 'invalid_record');
        const previous = unique.get(record.id);
        if (previous && (previous.nonce !== record.nonce || previous.ciphertext !== record.ciphertext)) fail(409, 'record_conflict');
        unique.set(record.id, record);
      }
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      let result;
      try {
        const vault = db.prepare('SELECT * FROM vaults WHERE id=?').get(id);
        const fresh = [];
        for (const record of unique.values()) {
          const existing = db.prepare('SELECT nonce,ciphertext FROM records WHERE vault_id=? AND id=?').get(id, record.id);
          if (existing) {
            if (existing.nonce !== record.nonce || existing.ciphertext !== record.ciphertext) fail(409, 'record_conflict');
          } else fresh.push(record);
        }
        // Include a fixed allowance for UUIDs/index metadata in the storage quota.
        const bytes = fresh.reduce((total, record) => total + Buffer.byteLength(record.nonce)
          + Buffer.byteLength(record.ciphertext) + 128, 0);
        if (vault.record_count + fresh.length > maxRecordsPerVault
          || vault.byte_count + bytes > maxBytesPerVault
          || db.prepare('SELECT COALESCE(SUM(byte_count),0) AS total FROM vaults').get().total + bytes > maxTotalBytes) {
          fail(413, 'record_quota_exceeded');
        }
        let latest = vault.latest;
        const insert = db.prepare('INSERT INTO records(vault_id,id,sequence,nonce,ciphertext) VALUES(?,?,?,?,?)');
        for (const record of fresh) insert.run(id, record.id, ++latest, record.nonce, record.ciphertext);
        db.prepare('UPDATE vaults SET latest=?,record_count=record_count+?,byte_count=byte_count+? WHERE id=?')
          .run(latest, fresh.length, bytes, id);
        db.exec('COMMIT'); committed = true;
        result = { accepted: body.records.length, latest };
      } finally { if (!committed) db.exec('ROLLBACK'); }
      reply(res, 200, result);
    } catch (error) {
      // No request bodies, authorization, vault IDs or internal database details are logged/returned.
      if (!res.headersSent && !res.destroyed) {
        reply(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof HttpError ? error.code : 'internal_error' });
      }
      if (!req.complete) req.resume();
    }
  });
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 256;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return { server, close() { db.close(); } };
}
