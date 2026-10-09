import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import worker from './worker.mjs';
import { schema, statements } from './test-support.mjs';

const token = () => randomBytes(32).toString('base64url');
const record = (bytes = 32) => ({ id: randomUUID(), nonce: randomBytes(12).toString('base64'), ciphertext: randomBytes(bytes).toString('base64') });
async function fixture(t, { rateLimit = 10000, persist = false } = {}) {
  const registrationToken = token();
  const directory = persist ? await mkdtemp(join(tmpdir(), 'mfa-d1-')) : null;
  const options = {
    modules: true, scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'test-db' }, resourcePersistencePath: directory ?? undefined,
    bindings: { SYNC_REGISTRATION_TOKEN: registrationToken },
    ratelimits: Object.fromEntries(['IP_LIMITER', 'VAULT_LIMITER', 'REGISTER_LIMITER'].map((name, index) => [name,
      { namespace_id: String(29401 + index), simple: { limit: rateLimit, period: 60 } }])),
    log: new Log(LogLevel.ERROR), cf: false,
  };
  let mf = new Miniflare(convertV4MiniflareOptions(options));
  let db = await mf.getD1Database('DB');
  for (const sql of statements(schema)) await db.prepare(sql).run();
  t.after(async () => { await mf.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
  const authToken = token(); const vaultId = randomUUID();
  async function call(path, { method = 'GET', bearer = authToken, body, raw, headers } = {}) {
    // Service-binding fetch runs in workerd without Miniflare's HTTP/1 proxy
    // reusing a socket closed by an unread/rejected oversized request body.
    const runtime = await mf.getWorker();
    const response = await runtime.fetch('https://sync.example.invalid' + path, { method,
      headers: { authorization: `Bearer ${bearer}`, ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const path = `/v1/vaults/${vaultId}/records`;
  return { call, vaultId, authToken, registrationToken, path,
    get db() { return db; },
    register: () => call('/v1/vaults', { method: 'POST', bearer: registrationToken, body: { vaultId, authToken } }),
    push: (records) => call(path, { method: 'POST', body: { records } }),
    pull: (after = 0) => call(`${path}?after=${after}`),
    restart: async () => { await mf.dispose(); mf = new Miniflare(convertV4MiniflareOptions(options)); db = await mf.getD1Database('DB'); },
  };
}

test('runtime serves no-store health, authenticates owner/vault separately and preserves exact registration retries', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/health')).body, { status: 'ok' });
  assert.equal((await f.call('/health')).headers.get('cache-control'), 'no-store');
  assert.equal((await f.pull()).status, 401);
  assert.equal((await f.call('/v1/vaults', { method: 'POST', body: { vaultId: f.vaultId, authToken: f.authToken } })).status, 401);
  assert.equal((await f.register()).status, 201);
  assert.equal((await f.register()).status, 200);
  assert.equal((await f.call('/v1/vaults', { method: 'POST', bearer: f.registrationToken, body: { vaultId: f.vaultId, authToken: token() } })).status, 409);
  assert.equal((await f.call(f.path, { bearer: token() })).status, 401);
  assert.equal((await f.call(`/v1/vaults/${randomUUID()}/records`)).status, 401);
  const stored = await f.db.prepare('SELECT token_hash FROM vaults').first();
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.token_hash, f.authToken);
  assert.deepEqual((await f.pull()).body, { records: [], cursor: 0, hasMore: false, latest: 0 });
});

test('100-record upload uses bounded queries; exact retries do not write; conflicts roll back all records and counters', async (t) => {
  const f = await fixture(t); await f.register();
  const batch = Array.from({ length: 100 }, () => record());
  const result = await f.push(batch);
  assert.deepEqual(result.body, { accepted: 100, latest: 100 });
  assert.equal(result.status, 200);
  const before = await f.db.prepare('SELECT * FROM relay_stats').first();
  assert.deepEqual((await f.push([batch[0], batch[0]])).body, { accepted: 2, latest: 100 });
  const fresh = record();
  assert.equal((await f.push([fresh, { ...batch[1], ciphertext: record().ciphertext }])).status, 409);
  assert.deepEqual(await f.db.prepare('SELECT * FROM relay_stats').first(), before);
  assert.deepEqual((await f.pull()).body.records, batch.map((r, index) => ({ sequence: index + 1, ...r })));
  const repeat = await f.db.prepare(`INSERT INTO record_inbox(vault_id,id,nonce,ciphertext)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.nonce'),json_extract(value,'$.ciphertext') FROM json_each(?)`)
    .bind(f.vaultId, JSON.stringify(batch)).run();
  assert.equal(repeat.meta.rows_written, 0);
});

test('concurrent 10 users with 3 devices keep contiguous sequences and isolated ciphertext', async (t) => {
  const f = await fixture(t);
  const users = Array.from({ length: 10 }, () => ({ vaultId: randomUUID(), authToken: token(), records: [record(), record(), record()] }));
  for (const user of users) assert.equal((await f.call('/v1/vaults', { method: 'POST', bearer: f.registrationToken, body: { vaultId: user.vaultId, authToken: user.authToken } })).status, 201);
  const uploads = await Promise.all(users.flatMap((user) => user.records.map((r) => f.call(`/v1/vaults/${user.vaultId}/records`, { method: 'POST', bearer: user.authToken, body: { records: [r] } }))));
  assert.ok(uploads.every((r) => r.status === 200));
  for (const user of users) {
    const page = await f.call(`/v1/vaults/${user.vaultId}/records?after=0`, { bearer: user.authToken });
    assert.deepEqual(page.body.records.map((r) => r.sequence), [1, 2, 3]);
    assert.deepEqual(new Set(page.body.records.map((r) => r.id)), new Set(user.records.map((r) => r.id)));
    const another = users.find((u) => u !== user);
    assert.equal((await f.call(`/v1/vaults/${another.vaultId}/records`, { bearer: user.authToken })).status, 401);
  }
});

test('pagination and large pages stay ordered and below one MiB; invalid cursors fail', async (t) => {
  const f = await fixture(t); await f.register();
  await f.push(Array.from({ length: 100 }, () => record())); await f.push([record(), record()]);
  const first = (await f.pull()).body;
  assert.equal(first.records.length, 100); assert.equal(first.hasMore, true); assert.equal(first.latest, 102);
  assert.equal((await f.pull(first.cursor)).body.records.length, 2);
  assert.equal((await f.pull(103)).status, 409);
  for (const after of ['-1', '01', '1.2', '1e2', '9007199254740992', '0&after=1', '0&unknown=x']) assert.equal((await f.call(`${f.path}?after=${after}`)).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await f.push(Array.from({ length: 10 }, () => record(65536)))).status, 200);
  const large = (await f.pull(102)).body;
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 1024 * 1024);
  assert.ok(large.records.length > 0 && large.records.length < 30);
  assert.equal((await f.pull(large.cursor)).body.records[0].sequence, large.cursor + 1);
});

test('strict schemas, canonical encodings and streaming body limit reject malformed input without writes', async (t) => {
  const f = await fixture(t); await f.register();
  const valid = record();
  for (const value of [null, {}, { ...valid, extra: true }, { ...valid, id: 'bad' },
    { ...valid, nonce: 'A'.repeat(15) + '=' }, { ...valid, nonce: valid.nonce + '=' },
    { ...valid, ciphertext: 'AAAA' }, { ...valid, ciphertext: '!!!!' }, { ...valid, ciphertext: record(65537).ciphertext }]) {
    assert.equal((await f.push([value])).status, 400);
  }
  assert.equal((await f.push(Array.from({ length: 101 }, () => valid))).status, 400);
  assert.equal((await f.push([valid, { ...valid, nonce: record().nonce }])).status, 409);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{}', headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call(f.path, { method: 'POST', raw: ' '.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.call(f.path + '?after=0', { method: 'POST', body: { records: [valid] } })).status, 400);
  assert.equal((await f.pull()).body.latest, 0);
});

test('registration and append quotas are atomic, account duplicates once, and retain retries at quota', async (t) => {
  const f = await fixture(t); await f.register();
  await f.db.prepare('UPDATE relay_limits SET max_vaults=1,max_records=2').run();
  assert.equal((await f.register()).status, 200);
  assert.equal((await f.call('/v1/vaults', { method: 'POST', bearer: f.registrationToken, body: { vaultId: randomUUID(), authToken: token() } })).status, 413);
  const r = record(); await f.push([r, r]);
  assert.equal((await f.push([record(), record()])).status, 413);
  assert.equal((await f.pull()).body.latest, 1);
  assert.equal((await f.push([record()])).status, 200);
  assert.equal((await f.push([r])).status, 200);
  assert.equal((await f.push([record()])).status, 413);
  await f.db.prepare('UPDATE relay_limits SET max_records=20000,max_vault_bytes=1').run();
  assert.equal((await f.push([record()])).status, 413);
  await f.db.prepare('UPDATE relay_limits SET max_vault_bytes=8388608,max_total_bytes=1').run();
  assert.equal((await f.push([record()])).status, 413);
  assert.equal((await f.pull()).body.latest, 2);
});

test('idle polling performs one indexed primary lookup, no writes and no history scan', async (t) => {
  const f = await fixture(t); await f.register(); await f.push(Array.from({ length: 100 }, () => record()));
  const sqlSeen = [];
  const DB = { prepare(sql) { sqlSeen.push(sql); return f.db.prepare(sql); } };
  const limiter = { limit: async () => ({ success: true }) };
  const env = { DB, IP_LIMITER: limiter, VAULT_LIMITER: limiter };
  for (let i = 0; i < 30; i++) {
    const response = await worker.fetch(new Request(`https://sync.invalid${f.path}?after=100`, { headers: { authorization: `Bearer ${f.authToken}` } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { records: [], cursor: 100, hasMore: false, latest: 100 });
  }
  assert.equal(sqlSeen.length, 30);
  assert.ok(sqlSeen.every((sql) => sql === 'SELECT token_hash,latest FROM vaults WHERE id=?'));
  const lookup = await f.db.prepare(sqlSeen[0]).bind(f.vaultId).all();
  assert.equal(lookup.meta.rows_read, 1); assert.equal(lookup.meta.rows_written, 0);
  const plan = await f.db.prepare('EXPLAIN QUERY PLAN SELECT sequence,id,nonce,ciphertext FROM records WHERE vault_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').bind(f.vaultId, 0, 100, 100).all();
  assert.match(JSON.stringify(plan.results), /SEARCH records USING INDEX/);
  assert.doesNotMatch(JSON.stringify(plan.results), /SCAN records|TEMP B-TREE/);
});

test('D1 persists records across runtime restart', async (t) => {
  const f = await fixture(t, { persist: true }); await f.register(); const r = record(); await f.push([r]);
  await f.restart();
  assert.deepEqual((await f.pull()).body.records, [{ sequence: 1, ...r }]);
  assert.deepEqual((await f.push([r])).body, { accepted: 1, latest: 1 });
});

test('binding rate limit is enforced and missing configuration fails closed', async (t) => {
  const f = await fixture(t, { rateLimit: 2 });
  await f.call('/health'); await f.call('/health');
  const denied = await f.call('/health');
  assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '60');
  const noBinding = await worker.fetch(new Request('https://sync.invalid/health'), {});
  assert.equal(noBinding.status, 503);
  const yes = { limit: async () => ({ success: true }) };
  assert.equal((await worker.fetch(new Request('https://sync.invalid/v1/vaults', { method: 'POST' }), { IP_LIMITER: yes, REGISTER_LIMITER: yes })).status, 503);
});

test('concurrent registration cannot overrun the global vault quota', async (t) => {
  const f = await fixture(t);
  await f.db.prepare('UPDATE relay_limits SET max_vaults=2').run();
  const results = await Promise.all(Array.from({ length: 10 }, () => f.call('/v1/vaults', {
    method: 'POST', bearer: f.registrationToken, body: { vaultId: randomUUID(), authToken: token() },
  })));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 413).length, 8);
  assert.equal((await f.db.prepare('SELECT vault_count FROM relay_stats').first()).vault_count, 2);
});
