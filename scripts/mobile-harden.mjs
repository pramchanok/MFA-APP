import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

export function hardenMobile(platform, root) {
  if (platform === 'android') {
    const manifest = join(root, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
    let xml = readFileSync(manifest, 'utf8');
    // A vault copy should only leave a device through explicit encrypted export.
    for (const [attribute, value] of [['allowBackup', 'false'], ['fullBackupContent', 'false'], ['usesCleartextTraffic', 'false']]) {
      const pattern = new RegExp(`android:${attribute}="[^"]*"`);
      xml = pattern.test(xml)
        ? xml.replace(pattern, `android:${attribute}="${value}"`)
        : xml.replace('<application', `<application android:${attribute}="${value}"`);
    }
    if (!xml.includes('android.permission.CAMERA')) {
      xml = xml.replace('<application', '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    <application');
    }
    writeFileSync(manifest, xml);
  } else if (platform === 'ios') {
    const apple = join(root, 'src-tauri/gen/apple');
    if (!existsSync(apple)) throw new Error('Initialize the iOS project before hardening.');
    const plists = filesBelow(apple).filter(path => path.endsWith('/Info.plist') || path.endsWith('\\Info.plist'));
    if (!plists.length) throw new Error('Generated iOS Info.plist was not found.');
    for (const path of plists) {
      let xml = readFileSync(path, 'utf8');
      if (!xml.includes('<key>NSCameraUsageDescription</key>')) {
        xml = xml.replace(/<\/dict>\s*<\/plist>/, '<key>NSCameraUsageDescription</key>\n<string>Scan an authenticator or device pairing QR code when you choose the camera.</string>\n</dict>\n</plist>');
      }
      if (!xml.includes('<key>NSCameraUsageDescription</key>')) throw new Error('Unsupported iOS plist format.');
      writeFileSync(path, xml);
    }
  } else {
    throw new Error('Expected android or ios.');
  }
  console.log(`Applied ${platform} camera and platform privacy configuration.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hardenMobile(process.argv[2], resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
