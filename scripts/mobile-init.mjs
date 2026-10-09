import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hardenMobile } from './mobile-harden.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) {
  throw new Error('Usage: node scripts/mobile-init.mjs android|ios');
}
if (platform === 'ios' && process.platform !== 'darwin') {
  throw new Error('iOS initialization requires macOS and Xcode.');
}
// Install Rust targets explicitly during prerequisite setup, not implicitly here.
const result = spawnSync(process.execPath, [
  resolve(root, 'node_modules/@tauri-apps/cli/tauri.js'), platform,
  'init', '--ci', '--skip-targets-install',
], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
hardenMobile(platform, root);
