import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AccountCode, AccountInput, AccountQr, AppInfo, VaultStatus, GoogleExportPreview, SyncStatus, PairingInfo, SyncResult, DeviceUnlockStatus } from './types';

export const desktop = isTauri();
// A browser preview is read-only. Never persist or accept real credentials here.
const samples: Omit<AccountCode, 'remaining'>[] = [
  { id: 'sample-google', issuer: 'Google', account: 'personal@example.com', code: '482093', digits: 6, period: 30 },
  { id: 'sample-microsoft', issuer: 'Microsoft', account: 'work@example.com', code: '716284', digits: 6, period: 30 },
  { id: 'sample-github', issuer: 'GitHub', account: 'developer', code: '309512', digits: 6, period: 30 },
];
const previewCodes = (): AccountCode[] => samples.map((account) => ({
  ...account, remaining: account.period - (Math.floor(Date.now() / 1000) % account.period),
}));
const nativeOnly = <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (!desktop) return Promise.reject(new Error('การทำงานนี้ใช้ได้ในแอปที่ติดตั้งเท่านั้น'));
  // Verbose development diagnostics deliberately contain no arguments/results.
  if (import.meta.env.MODE === 'development') console.debug('[MFA Desktop] native command:', command);
  return invoke<T>(command, args);
};

export const api = {
  status: (): Promise<VaultStatus> => desktop ? nativeOnly('vault_status') : Promise.resolve({ exists: true, unlocked: true }),
  info: (): Promise<AppInfo> => desktop ? nativeOnly('app_info') : Promise.resolve({ version: '0.4.2', updaterConfigured: false }),
  create: (password: string) => nativeOnly<AccountCode[]>('create_vault', { password }),
  unlock: (password: string) => nativeOnly<AccountCode[]>('unlock_vault', { password }),
  deviceStatus: (): Promise<DeviceUnlockStatus> => desktop ? nativeOnly('device_unlock_status') : Promise.resolve({ available: false, enabled: false, label: 'ปลดล็อกด้วยอุปกรณ์' }),
  enableDevice: (password: string) => nativeOnly<DeviceUnlockStatus>('enable_device_unlock', { password }),
  unlockDevice: () => nativeOnly<AccountCode[]>('unlock_with_device'),
  disableDevice: () => nativeOnly<DeviceUnlockStatus>('disable_device_unlock'),
  lock: () => nativeOnly<void>('lock_vault'),
  touch: () => nativeOnly<void>('touch_session'),
  setAutoLockMinutes: (minutes: number) => nativeOnly<void>('set_auto_lock_minutes', { minutes }),
  codes: (): Promise<AccountCode[]> => desktop ? nativeOnly('list_codes') : Promise.resolve(previewCodes()),
  add: (input: AccountInput) => nativeOnly<AccountCode[]>('add_account', { input }),
  reorder: (ids: string[]) => nativeOnly<AccountCode[]>('reorder_accounts', { ids }),
  previewAccounts: (uris: string[]) => nativeOnly<GoogleExportPreview>('preview_accounts', { uris }),
  importAccounts: (uris: string[], selected: number[]) => nativeOnly<AccountCode[]>('import_accounts', { uris, selected }),
  previewGoogle: (uris: string[]) => nativeOnly<GoogleExportPreview>('preview_google_export', { uris }),
  importGoogle: (uris: string[], selected: number[]) => nativeOnly<AccountCode[]>('import_google_export', { uris, selected }),
  remove: (id: string) => nativeOnly<AccountCode[]>('delete_account', { id }),
  copy: (id: string) => nativeOnly<void>('copy_code', { id }),
  accountQr: (id: string, password: string) => nativeOnly<AccountQr>('account_qr', { id, password }),
  exportBackup: (path: string) => nativeOnly<void>('export_backup', { path }),
  importBackup: (path: string, password: string) => nativeOnly<AccountCode[]>('import_backup', { path, password }),
  syncStatus: () => nativeOnly<SyncStatus>('sync_status'),
  syncCreate: (server: string, registration: string) => nativeOnly<PairingInfo>('sync_create', { server, registration }),
  syncPair: (uri: string) => nativeOnly<AccountCode[]>('sync_pair', { uri }),
  syncOnce: () => nativeOnly<SyncResult>('sync_once'),
  syncPairing: () => nativeOnly<PairingInfo>('sync_pairing'),
  syncDisconnect: () => nativeOnly<void>('sync_disconnect'),
};

export function safeError(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง';
  const translated: Record<string, string> = {
    'Use a password with at least 6 characters (maximum 1024 bytes).': 'ตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร และไม่เกิน 1024 ไบต์',
    'Device unlock is unavailable. Use your master password.': 'เครื่องนี้ยังไม่พร้อมใช้การปลดล็อกด้วยอุปกรณ์ กรุณาใช้รหัสผ่านหลัก',
    'Device unlock was cancelled or failed. Use your master password.': 'ยกเลิกหรือยืนยันด้วยอุปกรณ์ไม่สำเร็จ คุณยังใช้รหัสผ่านหลักได้',
    'Device unlock was cancelled. Use your master password.': 'ยกเลิกการยืนยัน Windows Hello แล้ว คุณยังใช้รหัสผ่านหลักได้',
    'Windows Hello could not validate the biometric ticket (0x80098044). Try again or choose the Windows PIN.': 'Windows ไม่รับผลยืนยันใบหน้า/ลายนิ้วมือ (0x80098044) กรุณาลองอีกครั้ง หรือเลือก PIN ในหน้าต่าง Windows Security',
    'Device unlock needs to be set up again. Use your master password.': 'กรุณาใช้รหัสผ่านหลัก แล้วตั้งค่าการปลดล็อกด้วยอุปกรณ์ใหม่',
    'Invalid backup, damaged vault or incorrect password.': 'รหัสผ่านไม่ถูกต้อง หรือไฟล์ข้อมูลเสียหาย กรุณาตรวจรหัสผ่านและไฟล์สำรอง',
    'Vault locked. Unlock it to continue.': 'คลังบัญชีถูกล็อก กรุณาปลดล็อกอีกครั้ง',
    'Auto-lock must be off or between 1 and 1440 minutes.': 'ระบุเวลาล็อกอัตโนมัติระหว่าง 1 ถึง 1440 นาที',
    'Unable to save the auto-lock setting.': 'บันทึกการตั้งค่าล็อกอัตโนมัติไม่ได้ กรุณาลองอีกครั้ง',
    'Account not found.': 'ไม่พบบัญชีนี้ กรุณาปิดหน้าต่างแล้วเลือกบัญชีอีกครั้ง',
    'The account list changed. Refresh it before reordering.': 'รายการบัญชีเปลี่ยนไป กรุณาลองเรียงลำดับใหม่อีกครั้ง',
    'Select new supported accounts from the setup QR codes.': 'กรุณาเลือกบัญชีที่รองรับและยังไม่ซ้ำ แล้วลองอ่านรายการใหม่',
    'Add between 1 and 100 setup QR codes before importing.': 'เพิ่ม QR ตั้งค่าระหว่าง 1 ถึง 100 รายการก่อนนำเข้า',
    "Unable to generate this account's QR code.": 'สร้าง QR ของบัญชีนี้ไม่ได้ กรุณาลองอีกครั้ง',
    "Account labels containing ':' cannot be exported as a standard QR.": 'ชื่อบริการหรือชื่อบัญชีมีเครื่องหมาย : ซึ่งไม่รองรับใน QR ตั้งค่ามาตรฐาน',
    'Unable to read or save the encrypted vault. Check file permissions and disk space.': 'อ่านหรือบันทึกข้อมูลไม่ได้ กรุณาตรวจสิทธิ์เข้าถึงไฟล์และพื้นที่ดิสก์',
    'The secret must be a valid Base32 key.': 'คีย์ลับไม่ใช่ Base32 ที่ถูกต้อง กรุณาตรวจคีย์จากหน้าตั้งค่า 2FA',
    'Use an otpauth://totp setup QR. HOTP and Microsoft push enrollment are unsupported.': 'ใช้ QR ตั้งค่ารหัส TOTP มาตรฐาน แอปยังไม่รองรับ HOTP หรือการอนุมัติเข้าสู่ระบบของ Microsoft',
    'Google migration QR is unsupported. Export a standard TOTP setup QR instead.': 'QR นี้เป็นชุดส่งออกจาก Google กรุณาเลือกแท็บนำเข้าจาก Google',
    'Invalid Google export QR. Export the accounts again from Google Authenticator.': 'QR ส่งออกจาก Google ไม่ถูกต้องหรือมีข้อมูลเสียหาย กรุณาส่งออกใหม่จาก Google Authenticator',
    'This Google export version is not supported. Update MFA Desktop before importing.': 'QR ส่งออกนี้ใช้รูปแบบที่แอปยังไม่รองรับ กรุณาอัปเดต MFA Desktop แล้วลองใหม่',
    'Google export QR codes belong to different batches. Start a new import.': 'QR มาจากคนละชุดส่งออก กรุณากดเริ่มชุดใหม่ แล้วเพิ่ม QR จากชุดเดียวกัน',
    'This Google export QR has already been added.': 'เพิ่ม QR นี้แล้ว กรุณาเลือกรูปถัดไปในชุดเดียวกัน',
    'Add all QR codes from this Google export before importing.': 'กรุณาเพิ่ม QR ให้ครบชุดก่อนนำเข้า',
    'Select new supported accounts from the Google export.': 'กรุณาเลือกบัญชีที่รองรับและยังไม่มีชื่อซ้ำในคลัง แล้วลองอ่านรายการใหม่',
    'The setup issuer does not match the account label.': 'ชื่อบริการใน QR Code ไม่ตรงกัน กรุณาใช้ QR จากหน้าตั้งค่า 2FA ของบริการ',
    'Correct your computer\'s date and time.': 'กรุณาตั้งวันที่และเวลาในเครื่องให้ถูกต้อง',
    'Sync is unavailable. Your accounts remain available offline.': 'ยังเชื่อมต่อเซิร์ฟเวอร์ซิงค์ไม่ได้ บัญชีในเครื่องยังใช้แบบออฟไลน์ได้',
    'Sync authorization was rejected. Check the server or pair this device again.': 'เซิร์ฟเวอร์ไม่ยอมรับสิทธิ์ซิงค์ กรุณาตรวจโทเคนหรือจับคู่อีกครั้ง',
    'Invalid or damaged encrypted sync data. The local vault was not changed.': 'ข้อมูลซิงค์ไม่ถูกต้องหรือเสียหาย ข้อมูลในเครื่องยังไม่ถูกเปลี่ยน',
    'Sync history or credentials conflict. The local vault was not changed.': 'ประวัติหรือสิทธิ์ซิงค์ไม่ตรงกัน ข้อมูลในเครื่องยังไม่ถูกเปลี่ยน',
  };
  const helloFailure = /^Windows Hello failed during ([A-Za-z ]+) \(0x([0-9A-F]{8})\)\. Use your master password\.$/.exec(message);
  if (helloFailure) {
    const stages: Record<string, string> = { 'create Hello key': 'สร้างกุญแจ', 'finalize Hello key': 'ยืนยันการสร้างกุญแจ', 'set key policy': 'ตั้งค่านโยบายกุญแจ', 'encrypt device key': 'เข้ารหัสกุญแจ', 'export public key': 'อ่านกุญแจสาธารณะ', 'encrypt public key': 'เข้ารหัสกุญแจ', 'Hello decrypt': 'ปลดล็อกกุญแจ', 'open key for deletion': 'เปิดกุญแจเพื่อปิดใช้งาน' };
    return `Windows Hello ทำขั้นตอน${stages[helloFailure[1]] ?? 'ป้องกันกุญแจ'}ไม่สำเร็จ (0x${helloFailure[2]}) คุณยังใช้รหัสผ่านหลักได้`;
  }
  return translated[message] ?? message;
}
