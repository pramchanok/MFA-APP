import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Public material only. Private updater and platform-signing keys belong in CI secrets.
const publicKey = process.env.MFA_UPDATER_PUBLIC_KEY?.trim();
if (!publicKey || publicKey === 'UNCONFIGURED') {
  throw new Error('Set MFA_UPDATER_PUBLIC_KEY to the Tauri updater public key before building a release.');
}
const decoded = Buffer.from(publicKey, 'base64').toString('utf8');
const keyLine = decoded.split(/\r?\n/).find((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line));
const raw = keyLine ? Buffer.from(keyLine, 'base64') : null;
if (!decoded.startsWith('untrusted comment:') || !raw || raw.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') {
  throw new Error('MFA_UPDATER_PUBLIC_KEY must be the base64-encoded public key produced by tauri signer generate.');
}
const configPath = new URL('../src-tauri/tauri.conf.json', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
if (pkg.version !== config.version) throw new Error('package.json and tauri.conf.json versions must match.');
const releaseConfig = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: publicKey } },
};
const endpoint = process.env.MFA_UPDATER_ENDPOINT?.trim();
if (endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MFA_UPDATER_ENDPOINT must be an HTTPS URL without credentials, query or fragment.');
  }
  releaseConfig.plugins.updater.endpoints = [url.href];
}
if (process.platform === 'darwin') {
  const team = process.env.APPLE_TEAM_ID?.trim();
  if (!/^[A-Z0-9]{10}$/.test(team ?? '')) {
    throw new Error('Set APPLE_TEAM_ID to the 10-character signing team ID for Touch ID Keychain access.');
  }
  const profile = process.env.APPLE_PROVISIONING_PROFILE?.trim();
  if (!profile || !/^[A-Za-z0-9+/=\r\n]+$/.test(profile)) {
    throw new Error('Set APPLE_PROVISIONING_PROFILE to a base64 Developer ID provisioning profile authorizing this app and its Keychain access group.');
  }
  await writeFile(new URL('../src-tauri/embedded.generated.provisionprofile', import.meta.url), Buffer.from(profile, 'base64'), { mode: 0o600 });
  const identity = `${team}.${config.identifier}`;
  const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${identity}</string>
<key>com.apple.developer.team-identifier</key><string>${team}</string>
<key>keychain-access-groups</key><array><string>${identity}</string></array>
<key>com.apple.security.device.camera</key><true/>
</dict></plist>
`;
  await writeFile(new URL('../src-tauri/Entitlements.generated.plist', import.meta.url), entitlements);
  releaseConfig.bundle.macOS = {
    entitlements: 'Entitlements.generated.plist',
    files: { 'embedded.provisionprofile': 'embedded.generated.provisionprofile' },
  };
}
const output = new URL('../src-tauri/tauri.release.conf.json', import.meta.url);
await writeFile(output, `${JSON.stringify(releaseConfig, null, 2)}\n`, { mode: 0o600 });
console.log(`Prepared signed-update configuration for ${config.version}: ${fileURLToPath(output)}`);
