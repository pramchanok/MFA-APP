import { readFile, appendFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
const config = JSON.parse(await read('src-tauri/tauri.conf.json'));
const cargo = await read('src-tauri/Cargo.toml');
const cargoLock = await read('src-tauri/Cargo.lock');
const cargoVersion = cargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
const lockedVersion = cargoLock.match(/\[\[package\]\]\s*name = "mfa-desktop"\s*version = "([^"]+)"/)?.[1];
const versions = [lock.version, lock.packages?.['']?.version, config.version, cargoVersion, lockedVersion];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) || versions.some((version) => version !== pkg.version)) {
  throw new Error('Release versions must match in package.json, package-lock.json, tauri.conf.json, Cargo.toml and Cargo.lock.');
}
console.log(`Release version: ${pkg.version}`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `version=${pkg.version}\ntag=v${pkg.version}\n`);
}
