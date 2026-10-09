import { timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_LIMIT = 1024 * 1024;
const PAGE_SIZE = 100;
const encoder = new TextEncoder();
const object = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new HttpError(status, code); };
function isToken(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const standard = value.replaceAll('-', '+').replaceAll('_', '/') + '=';
  return btoa(atob(standard)) === standard;
}
function strictBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    const decoded = atob(value);
    return decoded.length >= minimum && decoded.length <= maximum && btoa(decoded) === value;
  } catch { return false; }
}
async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function sameHash(a, b) {
  // All inputs are fixed-length SHA-256 hex, including the unknown-vault dummy.
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
async function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!match || !isToken(match[1])) fail(401, 'unauthorized');
  return hash(match[1]);
}
async function readJson(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(415, 'json_required');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail(415, 'encoding_not_supported');
  if (Number(request.headers.get('content-length') ?? 0) > BODY_LIMIT) fail(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > BODY_LIMIT) fail(413, 'body_too_large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'invalid_json'); }
}
function reply(status, body) {
  return Response.json(body, { status, headers: {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    ...(status === 429 || status === 503 ? { 'retry-after': '60' } : {}),
  } });
}
async function limit(binding, key) {
  // Missing bindings fail closed instead of silently disabling protection.
  if (!binding) fail(503, 'service_unavailable');
  if (!(await binding.limit({ key })).success) fail(429, 'rate_limited');
}
async function handle(request, env) {
  const url = new URL(request.url);
  // Cloudflare supplies this header at the edge. Do not use X-Forwarded-For.
  await limit(env.IP_LIMITER, request.headers.get('cf-connecting-ip') ?? 'local');
  if (url.pathname === '/health' && request.method === 'GET' && !url.search) return reply(200, { status: 'ok' });
  if (url.pathname === '/v1/vaults' && request.method === 'POST' && !url.search) {
    await limit(env.REGISTER_LIMITER, 'registration');
    if (!isToken(env.SYNC_REGISTRATION_TOKEN)) fail(503, 'service_unavailable');
    if (!sameHash(await bearer(request), await hash(env.SYNC_REGISTRATION_TOKEN))) fail(401, 'unauthorized');
    const body = await readJson(request);
    if (!object(body, ['vaultId', 'authToken']) || typeof body.vaultId !== 'string'
      || !UUID.test(body.vaultId) || !isToken(body.authToken)) fail(400, 'invalid_registration');
    const tokenHash = await hash(body.authToken);
    const results = await env.DB.batch([
      env.DB.prepare('INSERT INTO vaults(id,token_hash) VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING id').bind(body.vaultId, tokenHash),
      env.DB.prepare('SELECT token_hash FROM vaults WHERE id=?').bind(body.vaultId),
    ]);
    if (!sameHash(tokenHash, results[1].results[0].token_hash)) fail(409, 'vault_conflict');
    return reply(results[0].results.length ? 201 : 200, { vaultId: body.vaultId });
  }
  const route = /^\/v1\/vaults\/([0-9a-f-]+)\/records$/.exec(url.pathname);
  if (!route || !UUID.test(route[1])) fail(404, 'not_found');
  const id = route[1];
  if (request.method !== 'GET' && request.method !== 'POST') fail(405, 'method_not_allowed');
  const supplied = await bearer(request);
  // No replicated reads or auth caches: every request reads the primary.
  const vault = await env.DB.prepare('SELECT token_hash,latest FROM vaults WHERE id=?').bind(id).first();
  if (!sameHash(supplied, vault?.token_hash ?? '0'.repeat(64)) || !vault) fail(401, 'unauthorized');
  await limit(env.VAULT_LIMITER, id);
  if (request.method === 'GET') {
    if ([...url.searchParams.keys()].some((key) => key !== 'after') || url.searchParams.getAll('after').length > 1) fail(400, 'invalid_cursor');
    const raw = url.searchParams.get('after') ?? '0';
    if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(400, 'invalid_cursor');
    const after = Number(raw);
    if (after > vault.latest) fail(409, 'cursor_ahead');
    // Idle poll: ONE indexed row read and ZERO writes. No records query.
    if (after === vault.latest) return reply(200, { records: [], cursor: after, hasMore: false, latest: vault.latest });
    // Bound by the captured high-water mark: concurrent appends wait for next poll.
    const { results } = await env.DB.prepare(`SELECT sequence,id,nonce,ciphertext FROM records
      WHERE vault_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`).bind(id, after, vault.latest, PAGE_SIZE).all();
    const records = [];
    let responseBytes = 256;
    for (const record of results) {
      const bytes = JSON.stringify(record).length + 1; // All fields are ASCII.
      if (responseBytes + bytes > BODY_LIMIT - 1024) break;
      records.push(record); responseBytes += bytes;
    }
    const cursor = records.at(-1)?.sequence ?? after;
    return reply(200, { records, cursor, hasMore: cursor < vault.latest, latest: vault.latest });
  }
  if (url.search) fail(400, 'unexpected_query');
  const body = await readJson(request);
  if (!object(body, ['records']) || !Array.isArray(body.records) || body.records.length > PAGE_SIZE) fail(400, 'invalid_records');
  const unique = new Map();
  for (const record of body.records) {
    if (!object(record, ['id', 'nonce', 'ciphertext']) || typeof record.id !== 'string' || !UUID.test(record.id)
      || !strictBase64(record.nonce, 12, 12) || !strictBase64(record.ciphertext, 16, 65536)) fail(400, 'invalid_record');
    const previous = unique.get(record.id);
    if (previous && (previous.nonce !== record.nonce || previous.ciphertext !== record.ciphertext)) fail(409, 'record_conflict');
    unique.set(record.id, record);
  }
  if (!unique.size) return reply(200, { accepted: 0, latest: vault.latest });
  // Trigger conflict/quota errors abort the complete batch, including counters.
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO record_inbox(vault_id,id,nonce,ciphertext)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.nonce'),json_extract(value,'$.ciphertext')
      FROM json_each(?)`).bind(id, JSON.stringify([...unique.values()])),
    env.DB.prepare('SELECT latest FROM vaults WHERE id=?').bind(id),
  ]);
  return reply(200, { accepted: body.records.length, latest: results[1].results[0].latest });
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await handle(request, env); }
    catch (error) {
      if (error instanceof HttpError) response = reply(error.status, { error: error.code });
      // Map only fixed trigger messages; never return/log database errors or input.
      else {
        const message = String(error?.message ?? '');
        for (const [code, status] of [['record_conflict', 409], ['record_quota_exceeded', 413], ['vault_quota_exceeded', 413]]) {
          if (message.includes(code)) { response = reply(status, { error: code }); break; }
        }
        response ??= reply(503, { error: 'service_unavailable' });
      }
    }
    // Opt-in local diagnostics contain only a fixed category and status code.
    if (env.SYNC_DEBUG_LOGGING === 'true') {
      const path = new URL(request.url).pathname;
      const category = path === '/health' ? 'health' : path === '/v1/vaults' ? 'registration'
        : /^\/v1\/vaults\/[0-9a-f-]+\/records$/.test(path) ? 'records' : 'other';
      console.debug('[MFA Sync]', category, response.status);
    }
    return response;
  },
};
