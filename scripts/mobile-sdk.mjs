import { readFileSync } from 'node:fs';
const gradle = readFileSync(new URL('../src-tauri/gen/android/app/build.gradle.kts', import.meta.url), 'utf8');
const sdk = gradle.match(/compileSdk\s*=\s*(\d+)/)?.[1];
if (!sdk) throw new Error('Could not determine Android compileSdk from generated project.');
process.stdout.write(sdk);
