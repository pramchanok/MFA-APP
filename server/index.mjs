import { resolve } from 'node:path';
import { createRelay } from './relay.mjs';

process.umask(0o077);

function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

const relay = createRelay({
  registrationToken: process.env.SYNC_REGISTRATION_TOKEN,
  databasePath: resolve(process.env.SYNC_DATABASE_PATH ?? './data/sync.sqlite'),
  maxVaults: positiveInteger('SYNC_MAX_VAULTS', 1000),
  maxRecordsPerVault: positiveInteger('SYNC_MAX_RECORDS_PER_VAULT', 100000),
  maxBytesPerVault: positiveInteger('SYNC_MAX_BYTES_PER_VAULT', 64 * 1024 * 1024),
  maxTotalBytes: positiveInteger('SYNC_MAX_TOTAL_BYTES', 1024 * 1024 * 1024),
  rateLimit: positiveInteger('SYNC_RATE_LIMIT_PER_MINUTE', 120),
});
const port = positiveInteger('PORT', 8787);
if (port > 65535) throw new Error('PORT must be at most 65535');
relay.server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.info(`Encrypted sync relay listening on port ${port}`);
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  relay.server.close(() => { relay.close(); });
  relay.server.closeIdleConnections();
  const timeout = setTimeout(() => { relay.server.closeAllConnections(); }, 10000);
  timeout.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
