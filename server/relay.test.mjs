import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRelay } from './relay.mjs';

const token = () => randomBytes(32).toString('base64url');
const record = (bytes = 32) => ({ id: randomUUID(), nonce: randomBytes(12).toString('base64'), ciphertext: randomBytes(bytes).toString('base64') });
async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mfa-relay-'));
  const registrationToken = token();
  const authToken = token();
  const vaultId = randomUUID();
  const databasePath = join(directory, 'relay.sqlite');
  let relay;
  let base;
  async function start() {
    relay = createRelay({ registrationToken, databasePath, ...options });
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    base = `http://127.0.0.1:${relay.server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => { relay.server.close(resolve); relay.server.closeAllConnections(); });
    relay.close();
  }
  await start();
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  async function call(path, { method = 'GET', bearer = authToken, body, raw, headers } = {}) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${bearer}`,
      ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const path = `/v1/vaults/${vaultId}/records`;
  const register = () => call('/v1/vaults', { method: 'POST', bearer: registrationToken, body: { vaultId, authToken } });
  const push = (records) => call(path, { method: 'POST', body: { records } });
  const pull = (after = 0) => call(`${path}?after=${after}`);
  return { call, register, push, pull, path, vaultId, authToken, registrationToken, databasePath,
    restart: async () => { await stop(); await start(); } };
}

test('requires canonical strong registration token and valid limits at startup', () => {
  for (const registrationToken of [undefined, '', 'a'.repeat(43), token() + '=', 'short']) {
    assert.throws(() => createRelay({ registrationToken }));
  }
  assert.throws(() => createRelay({ registrationToken: token(), rateLimit: 0 }));
});

test('health is minimal/no-store; owner and per-vault authorization are enforced', async (t) => {
  const f = await fixture(t);
  const health = await f.call('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal((await f.call('/v1/vaults', { method: 'POST', body: { vaultId: f.vaultId, authToken: f.authToken } })).status, 401);
  assert.equal((await f.pull()).status, 401);
  assert.equal((await f.register()).status, 201);
  assert.equal((await f.register()).status, 200);
  assert.equal((await f.call('/v1/vaults', { method: 'POST', bearer: f.registrationToken,
    body: { vaultId: f.vaultId, authToken: token() } })).status, 409);
  assert.equal((await f.call(f.path, { bearer: token() })).status, 401);
  assert.equal((await f.call(`/v1/vaults/${randomUUID()}/records`)).status, 401);
  assert.deepEqual((await f.pull()).body, { records: [], cursor: 0, hasMore: false, latest: 0 });
});

test('immutable append is idempotent, transactional, ordered and durable after restart', async (t) => {
  const f = await fixture(t);
  await f.register();
  const first = record();
  const second = record();
  assert.equal((await f.push([first, second])).status, 200);
  assert.equal((await f.push([first, first])).status, 200);
  const fresh = record();
  const conflict = { ...second, ciphertext: record().ciphertext };
  assert.equal((await f.push([fresh, conflict])).status, 409);
  assert.equal((await f.push([fresh, { ...fresh, nonce: record().nonce }])).status, 409);
  const before = await f.pull();
  assert.deepEqual(before.body.records, [{ sequence: 1, ...first }, { sequence: 2, ...second }]);
  assert.equal(before.body.latest, 2);
  await f.restart();
  assert.deepEqual((await f.pull()).body, before.body);
  assert.equal((await f.push([first])).status, 200);
  const database = readFileSync(f.databasePath);
  assert.equal(database.includes(f.authToken), false);
  assert.equal(database.includes(f.registrationToken), false);
});

test('pagination and cursor checks retain ascending contiguous records', async (t) => {
  const f = await fixture(t);
  await f.register();
  assert.equal((await f.push(Array.from({ length: 100 }, () => record()))).status, 200);
  await f.push([record(), record()]);
  const page = (await f.pull()).body;
  assert.equal(page.records.length, 100);
  assert.equal(page.cursor, 100);
  assert.equal(page.latest, 102);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.records.map((r) => r.sequence), Array.from({ length: 100 }, (_, i) => i + 1));
  const final = (await f.pull(page.cursor)).body;
  assert.equal(final.records.length, 2);
  assert.equal(final.cursor, 102);
  assert.equal(final.hasMore, false);
  assert.equal((await f.pull(103)).status, 409);
  for (const after of ['-1', '01', '1.2', '1e2', '9007199254740992', '0&after=1', '0&unknown=x']) {
    assert.equal((await f.call(`${f.path}?after=${after}`)).status, 400);
  }
});

test('large ciphertext pages are bounded below one MiB', async (t) => {
  const f = await fixture(t);
  await f.register();
  for (let i = 0; i < 3; i++) assert.equal((await f.push(Array.from({ length: 10 }, () => record(65536)))).status, 200);
  const first = (await f.pull()).body;
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1024 * 1024);
  assert.ok(first.records.length < 30 && first.records.length > 0);
  assert.equal(first.hasMore, true);
  const second = (await f.pull(first.cursor)).body;
  assert.equal(second.records[0].sequence, first.cursor + 1);
});

test('strict schema/base64/body boundaries reject invalid requests without mutation', async (t) => {
  const f = await fixture(t);
  await f.register();
  const valid = record();
  const invalid = [null, {}, { ...valid, extra: true }, { ...valid, id: 'bad' },
    { ...valid, nonce: 'A'.repeat(15) + '=' }, { ...valid, nonce: valid.nonce + '=' },
    { ...valid, ciphertext: 'AAAA' }, { ...valid, ciphertext: '!!!!' },
    { ...valid, ciphertext: record(65537).ciphertext }];
  for (const value of invalid) assert.equal((await f.push([value])).status, 400);
  assert.equal((await f.push(Array.from({ length: 101 }, () => valid))).status, 400);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{' })).status, 400);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.call(f.path, { method: 'POST', raw: '{}', headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal((await f.call(f.path, { method: 'POST', raw: ' '.repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await f.call(f.path + '?after=0', { method: 'POST', body: { records: [] } })).status, 400);
  assert.equal((await f.call(f.path, { method: 'PUT' })).status, 405);
  assert.equal((await f.call('/unknown')).status, 404);
  assert.equal((await f.pull()).body.latest, 0);
});

test('vault, record and byte quotas preserve existing data and allow retry', async (t) => {
  const f = await fixture(t, { maxVaults: 1, maxRecordsPerVault: 2 });
  await f.register();
  assert.equal((await f.call('/v1/vaults', { method: 'POST', bearer: f.registrationToken,
    body: { vaultId: randomUUID(), authToken: token() } })).status, 413);
  const first = record();
  await f.push([first]);
  assert.equal((await f.push([record(), record()])).status, 413);
  assert.equal((await f.pull()).body.latest, 1);
  assert.equal((await f.push([first])).status, 200);
  assert.equal((await f.push([record()])).status, 200);
  const byte = await fixture(t, { maxBytesPerVault: 160 });
  await byte.register();
  assert.equal((await byte.push([record()])).status, 413);
  assert.equal((await byte.pull()).body.latest, 0);
  const total = await fixture(t, { maxTotalBytes: 160 });
  await total.register();
  assert.equal((await total.push([record()])).status, 413);
});

test('rate limits bound unauthenticated traffic and reset after the window', async (t) => {
  let time = 100000;
  const f = await fixture(t, { rateLimit: 2, now: () => time });
  assert.equal((await f.call('/health')).status, 200);
  assert.equal((await f.call('/health')).status, 200);
  const limited = await f.call('/health');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  time += 60000;
  assert.equal((await f.call('/health')).status, 200);
});

test('concurrent exact retries append once and conflicts cannot partially apply', async (t) => {
  const f = await fixture(t);
  await f.register();
  const first = record();
  const retries = await Promise.all(Array.from({ length: 8 }, () => f.push([first])));
  assert.ok(retries.every((result) => result.status === 200));
  assert.equal((await f.pull()).body.latest, 1);
  const second = record();
  const results = await Promise.all([f.push([second]), f.push([{ ...second, nonce: record().nonce }])]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await f.pull()).body.latest, 2);
});
