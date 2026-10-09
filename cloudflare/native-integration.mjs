import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { schema, statements } from './test-support.mjs';

// Isolated synthetic credentials; never use an installed app's data directory.
const registrationToken = randomBytes(32).toString('base64url');
const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
  compatibilityDate: '2026-10-09', compatibilityFlags: ['nodejs_compat'],
  host: '127.0.0.1', port: 0, d1Databases: { DB: 'native-test-db' },
  bindings: { SYNC_REGISTRATION_TOKEN: registrationToken }, cf: false,
  log: new Log(LogLevel.ERROR), logRequests: false,
  ratelimits: Object.fromEntries(['IP_LIMITER', 'VAULT_LIMITER', 'REGISTER_LIMITER'].map((name, index) => [name,
    { namespace_id: String(29401 + index), simple: { limit: 10000, period: 60 } }])),
}));
try {
  const db = await mf.getD1Database('DB');
  for (const sql of statements(schema)) await db.prepare(sql).run();
  const url = (await mf.ready).origin;
  const child = spawn('cargo', ['test', '--locked', '--offline', '--manifest-path',
    fileURLToPath(new URL('../src-tauri/Cargo.toml', import.meta.url)),
    'vault::tests::two_independent_vaults_sync_via_relay_and_preserve_offline_deletions',
    '--', '--ignored', '--exact', '--test-threads=1'], {
    stdio: 'inherit', env: { ...process.env, MFA_TEST_SYNC_URL: url, MFA_TEST_SYNC_REGISTRATION: registrationToken },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code) => resolve(code ?? 1));
  });
} finally { await mf.dispose(); }
