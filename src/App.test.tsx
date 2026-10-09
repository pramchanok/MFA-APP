import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { api } from './api';
import type { AccountCode } from './types';

vi.mock('./api', () => ({
  desktop: true,
  safeError: (e: unknown) => typeof e === 'string' ? e : 'ทำรายการไม่สำเร็จ',
  api: { status: vi.fn(), info: vi.fn(), create: vi.fn(), unlock: vi.fn(), deviceStatus: vi.fn(), enableDevice: vi.fn(), unlockDevice: vi.fn(), disableDevice: vi.fn(), lock: vi.fn(), touch: vi.fn(), codes: vi.fn(), reorder: vi.fn(), previewAccounts: vi.fn(), importAccounts: vi.fn(), add: vi.fn(), remove: vi.fn(), copy: vi.fn(), accountQr: vi.fn(), exportBackup: vi.fn(), importBackup: vi.fn(), previewGoogle: vi.fn(), importGoogle: vi.fn(), syncStatus: vi.fn(), syncOnce: vi.fn(), syncCreate: vi.fn(), syncPair: vi.fn(), syncPairing: vi.fn(), syncDisconnect: vi.fn() },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
const account: AccountCode = { id: '1', issuer: 'Google', account: 'alice@example.com', code: '123456', digits: 6, period: 30, remaining: 20 };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.status).mockResolvedValue({ exists: true, unlocked: true });
  vi.mocked(api.info).mockResolvedValue({ version: '0.1.0', updaterConfigured: false });
  vi.mocked(api.deviceStatus).mockResolvedValue({ available: false, enabled: false, label: 'Windows Hello' });
  vi.mocked(api.codes).mockResolvedValue([account]);
  vi.mocked(api.lock).mockResolvedValue();
  vi.mocked(api.touch).mockResolvedValue();
  vi.mocked(api.copy).mockResolvedValue();
  vi.mocked(api.syncStatus).mockResolvedValue({ configured: false, server: null, vaultId: null, pending: 0, lastSync: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('vault interface', () => {
  it('persists keyboard reordering without copying and restores authoritative order after a failed save', async () => {
    const second = { ...account, id: '2', issuer: 'Microsoft' };
    vi.mocked(api.codes).mockResolvedValue([account, second]);
    vi.mocked(api.reorder).mockResolvedValueOnce([second, account]).mockRejectedValueOnce('Save failed');
    const user = userEvent.setup(); render(<App />);
    const handle = await screen.findByRole('button', { name: /ลากเรียงบัญชี Microsoft/ });
    handle.focus(); await user.keyboard('{Home}');
    await waitFor(() => expect(api.reorder).toHaveBeenCalledWith(['2', '1']));
    await waitFor(() => expect(screen.getAllByRole('article')[0]).toHaveAttribute('data-account-id', '2'));
    expect(api.copy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /ลากเรียงบัญชี Google/ })).toBeEnabled());
    screen.getByRole('button', { name: /ลากเรียงบัญชี Google/ }).focus(); await user.keyboard('{Home}');
    await waitFor(() => expect(api.reorder).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    expect(screen.getAllByRole('article')[0]).toHaveAttribute('data-account-id', '1');
  });

  it('purges a pending reorder result on lock', async () => {
    const second = { ...account, id: '2', issuer: 'Microsoft' };
    vi.mocked(api.codes).mockResolvedValue([account, second]);
    let finish!: (value: AccountCode[]) => void;
    vi.mocked(api.reorder).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup(); render(<App />);
    const handle = await screen.findByRole('button', { name: /ลากเรียงบัญชี Microsoft/ });
    handle.focus(); await user.keyboard('{Home}');
    await waitFor(() => expect(api.reorder).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    await act(async () => { finish([second, account]); });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByLabelText('รหัสผ่านหลัก')).toBeVisible();
  });

  it('offers sync setup after Google import and keeps accounts when setup is postponed', async () => {
    const imported = { ...account, id: 'imported', account: 'imported@example.invalid' };
    vi.mocked(api.previewGoogle).mockResolvedValue({ parts: 1, expected: 1, complete: true, entries: [{ index: 0, issuer: 'Google', account: imported.account, algorithm: 'SHA1', digits: 6, reason: null }] });
    vi.mocked(api.importGoogle).mockResolvedValue([account, imported]);
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: 'otpauth-migration://offline?data=SYNTHETIC' } });
    await user.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
    await user.click(await screen.findByRole('button', { name: 'นำเข้า 1 บัญชี' }));
    expect(await screen.findByRole('dialog', { name: 'นำเข้าแล้ว 1 บัญชี' })).toBeVisible();
    expect(api.syncCreate).not.toHaveBeenCalled(); expect(api.syncPair).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ตั้งค่าซิงค์อุปกรณ์' }));
    expect(screen.getByRole('button', { name: 'ตั้งค่าคลังซิงค์ใหม่' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('ที่อยู่เซิร์ฟเวอร์')).toHaveValue('https://mfa-sync.pramchanok.workers.dev');
    expect(screen.getByLabelText('โทเคนสร้างคลัง')).toHaveValue('');
    expect(api.syncCreate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ปิดหน้าต่าง' }));
    expect(screen.getByText(imported.account)).toBeVisible();
    expect(screen.getByText(account.account)).toBeVisible();
  });

  it('syncs imported Google accounts through the existing connection without creating another vault', async () => {
    const connected = { configured: true, server: 'https://sync.example.invalid', vaultId: 'synthetic', pending: 0, lastSync: 1 };
    vi.mocked(api.syncStatus).mockResolvedValue(connected);
    vi.mocked(api.syncOnce).mockResolvedValue({ changed: false, status: connected });
    vi.mocked(api.previewGoogle).mockResolvedValue({ parts: 1, expected: 1, complete: true, entries: [{ index: 0, issuer: 'Example', account: 'imported@example.invalid', algorithm: 'SHA1', digits: 6, reason: null }] });
    vi.mocked(api.importGoogle).mockResolvedValue([account]);
    const user = userEvent.setup(); render(<App />);
    await screen.findByText(account.account);
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: 'otpauth-migration://offline?data=SYNTHETIC' } });
    await user.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
    await user.click(await screen.findByRole('button', { name: 'นำเข้า 1 บัญชี' }));
    await screen.findByRole('dialog', { name: 'นำเข้าแล้ว 1 บัญชี' });
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'จัดการซิงค์ / จับคู่เครื่องอื่น' }));
    expect(screen.getByText('เชื่อมต่อคลังซิงค์แล้ว')).toBeVisible();
    expect(api.syncCreate).not.toHaveBeenCalled(); expect(api.syncPairing).not.toHaveBeenCalled();
  });

  it('purges an exported QR and ignores a pending export after locking', async () => {
    let finish!: (value: { image: string; customParameters: boolean }) => void;
    vi.mocked(api.accountQr).mockResolvedValueOnce({ image: 'data:image/svg+xml;base64,PHN2Zy8+', customParameters: false });
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'ตัวเลือกบัญชี Google alice@example.com' }));
    await user.click(screen.getByRole('button', { name: 'แสดง QR สำหรับแอปอื่น Google alice@example.com' }));
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและแสดง QR' }));
    expect(await screen.findByRole('img')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    vi.mocked(api.unlock).mockResolvedValue([account]);
    await user.type(screen.getByLabelText('รหัสผ่านหลัก'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'ปลดล็อก' }));
    vi.mocked(api.accountQr).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await user.click(await screen.findByRole('button', { name: 'ตัวเลือกบัญชี Google alice@example.com' }));
    await user.click(screen.getByRole('button', { name: 'แสดง QR สำหรับแอปอื่น Google alice@example.com' }));
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), 'test-password');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและแสดง QR' }));
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    await act(async () => { finish({ image: 'data:image/svg+xml;base64,PHN2Zy8+', customParameters: false }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('รหัสผ่านหลัก')).toBeVisible();
  });

  it('keeps password unlock available when Hello is unavailable or detection fails', async () => {
    vi.mocked(api.status).mockResolvedValue({ exists: true, unlocked: false });
    vi.mocked(api.deviceStatus).mockRejectedValue('unavailable');
    vi.mocked(api.unlock).mockResolvedValue([account]);
    const user = userEvent.setup(); render(<App />);
    await screen.findByLabelText('รหัสผ่านหลัก');
    expect(screen.queryByRole('button', { name: 'ปลดล็อกด้วย Windows Hello' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('รหัสผ่านหลัก'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'ปลดล็อก' }));
    expect(await screen.findByText('alice@example.com')).toBeVisible();
  });

  it.each(['Windows Hello', 'Touch ID'])('unlocks with %s only after a deliberate click', async (label) => {
    vi.mocked(api.status).mockResolvedValue({ exists: true, unlocked: false });
    vi.mocked(api.deviceStatus).mockResolvedValue({ available: true, enabled: true, label });
    vi.mocked(api.unlockDevice).mockResolvedValue([account]);
    const user = userEvent.setup(); render(<App />);
    const button = await screen.findByRole('button', { name: `ปลดล็อกด้วย ${label}` });
    expect(api.unlockDevice).not.toHaveBeenCalled();
    expect(screen.getByLabelText('รหัสผ่านหลัก')).toBeVisible();
    await user.click(button);
    expect(await screen.findByText('alice@example.com')).toBeVisible();
    expect(api.unlock).not.toHaveBeenCalled();
  });

  it('keeps the vault locked after device cancellation and lets the user enter a password', async () => {
    vi.mocked(api.status).mockResolvedValue({ exists: true, unlocked: false });
    vi.mocked(api.deviceStatus).mockResolvedValue({ available: true, enabled: true, label: 'Windows Hello' });
    vi.mocked(api.unlockDevice).mockRejectedValue('ยกเลิกการยืนยัน ใช้รหัสผ่านหลักได้');
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'ปลดล็อกด้วย Windows Hello' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ใช้รหัสผ่านหลักได้');
    expect(screen.getByLabelText('รหัสผ่านหลัก')).toBeEnabled();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('requires a fresh password to enable Hello and purges it before waiting for the OS', async () => {
    vi.mocked(api.deviceStatus).mockResolvedValue({ available: true, enabled: false, label: 'Windows Hello' });
    let finish!: (value: { available: boolean; enabled: boolean; label: string }) => void;
    vi.mocked(api.enableDevice).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'ตั้งค่า' }));
    await user.click(await screen.findByRole('button', { name: 'ตั้งค่า Windows Hello' }));
    expect(api.enableDevice).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'เปิดใช้ Windows Hello' }));
    expect(api.enableDevice).toHaveBeenCalledWith('correct horse battery');
    expect(screen.getByLabelText('ยืนยันรหัสผ่านหลัก')).toHaveValue('');
    await act(async () => { finish({ available: true, enabled: true, label: 'Windows Hello' }); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores late enrollment results after the vault is locked', async () => {
    vi.mocked(api.deviceStatus).mockResolvedValue({ available: true, enabled: false, label: 'Touch ID' });
    let finish!: (value: { available: boolean; enabled: boolean; label: string }) => void;
    vi.mocked(api.enableDevice).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'ตั้งค่า' }));
    await user.click(await screen.findByRole('button', { name: 'ตั้งค่า Touch ID' }));
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'เปิดใช้ Touch ID' }));
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    await act(async () => { finish({ available: true, enabled: true, label: 'Touch ID' }); });
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('รหัสผ่านหลัก')).toBeVisible();
  });
  it('purges pairing input on lock and hides desktop updating on mobile', async () => {
    vi.mocked(api.info).mockResolvedValue({ version: '0.3.0', updaterConfigured: false, mobile: true });
    const user = userEvent.setup(); render(<App />); await screen.findByText('alice@example.com');
    expect(screen.queryByRole('button', { name: 'อัปเดตแอป' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ซิงค์อุปกรณ์' }));
    fireEvent.change(screen.getByLabelText('หรือวางรหัสจับคู่'), { target: { value: 'mfa-sync://pair?data=SYNTHETIC' } });
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    expect(await screen.findByRole('heading', { name: 'ปลดล็อกบัญชีของคุณ' })).toBeVisible();
    expect(screen.queryByDisplayValue('mfa-sync://pair?data=SYNTHETIC')).not.toBeInTheDocument();
    expect(api.syncPair).not.toHaveBeenCalled();
  });
  it('opens Google import from the dashboard and purges its QR and preview when locked', async () => {
    vi.mocked(api.previewGoogle).mockResolvedValue({ parts: 1, expected: 1, complete: true, entries: [{ index: 0, issuer: 'Example', account: 'imported@example.invalid', algorithm: 'SHA1', digits: 6, reason: null }] });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: 'otpauth-migration://offline?data=SYNTHETIC' } });
    await user.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
    expect(await screen.findByText('imported@example.invalid')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    expect(await screen.findByRole('heading', { name: 'ปลดล็อกบัญชีของคุณ' })).toBeVisible();
    expect(screen.queryByText('imported@example.invalid')).not.toBeInTheDocument();
    expect(api.importGoogle).not.toHaveBeenCalled();
  });
  it('searches issuer and account and copies through the native command', async () => {
    const user = userEvent.setup(); render(<App />);
    expect(await screen.findByText('alice@example.com')).toBeVisible();
    await user.type(screen.getByRole('searchbox'), 'missing');
    expect(screen.getByText('ไม่พบบัญชีที่ค้นหา')).toBeVisible();
    await user.clear(screen.getByRole('searchbox'));
    await user.click(screen.getByRole('button', { name: 'คัดลอกรหัส Google alice@example.com' }));
    expect(api.copy).toHaveBeenCalledWith('1');
    expect(screen.getByText('คัดลอกแล้ว')).toBeVisible();
  });

  it('does not delete an account until the confirmation action', async () => {
    const syncProfile = { configured: true, server: 'https://sync.example.invalid', vaultId: 'test', pending: 0, lastSync: null };
    vi.mocked(api.syncStatus).mockResolvedValue(syncProfile);
    vi.mocked(api.syncOnce).mockResolvedValue({ changed: false, status: syncProfile });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('alice@example.com');
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: 'ตัวเลือกบัญชี Google alice@example.com' }));
    await user.click(screen.getByRole('button', { name: 'ลบบัญชี Google alice@example.com' }));
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    expect(api.remove).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'ตัวเลือกบัญชี Google alice@example.com' }));
    await user.click(screen.getByRole('button', { name: 'ลบบัญชี Google alice@example.com' }));
    vi.mocked(api.remove).mockResolvedValue([]);
    await user.click(screen.getByRole('button', { name: 'ยืนยันลบบัญชี' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('1'));
    expect(await screen.findByText('เพิ่มบัญชีแรกของคุณ')).toBeVisible();
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(2));
  });

  it('purges codes and an open secret form when locking', async () => {
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    await user.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
    await user.type(screen.getByLabelText('คีย์ลับ'), 'JBSWY3DPEHPK3PXP');
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    expect(await screen.findByRole('heading', { name: 'ปลดล็อกบัญชีของคุณ' })).toBeVisible();
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();
    expect(api.lock).toHaveBeenCalled();
  });

  it('does not show late polling results after locking', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<App />); });
    expect(screen.getByText('alice@example.com')).toBeVisible();
    let resolve!: (data: AccountCode[]) => void;
    vi.mocked(api.codes).mockImplementation(() => new Promise((done) => { resolve = done; }));
    await act(async () => { vi.advanceTimersByTime(1000); });
    fireEvent.click(screen.getByRole('button', { name: 'ล็อกแอป' }));
    await act(async () => { resolve([account]); });
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it.each(['483927', 'aB7x9p2Q'])('creates a vault with a short PIN or password %s', async (password) => {
    vi.mocked(api.status).mockResolvedValue({ exists: false, unlocked: false });
    vi.mocked(api.create).mockResolvedValue([account]);
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: 'เริ่มเก็บรหัสไว้ในเครื่อง' });
    await user.type(screen.getByLabelText('รหัสผ่านหลัก'), password);
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), password);
    await user.click(screen.getByRole('button', { name: 'สร้างคลังบัญชี' }));
    expect(await screen.findByText('alice@example.com')).toBeVisible();
    expect(api.create).toHaveBeenCalledWith(password);
  });

  it('rejects fewer than six characters before creating a vault', async () => {
    vi.mocked(api.status).mockResolvedValue({ exists: false, unlocked: false });
    render(<App />);
    const password = await screen.findByLabelText('รหัสผ่านหลัก');
    fireEvent.change(password, { target: { value: '48392' } });
    fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), { target: { value: '48392' } });
    fireEvent.submit(password.closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('ตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('requires matching passwords for setup', async () => {
    vi.mocked(api.status).mockResolvedValue({ exists: false, unlocked: false });
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: 'เริ่มเก็บรหัสไว้ในเครื่อง' });
    await user.type(screen.getByLabelText('รหัสผ่านหลัก'), 'correct horse battery');
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), 'different password');
    await user.click(screen.getByRole('button', { name: 'สร้างคลังบัญชี' }));
    expect(screen.getByRole('alert')).toHaveTextContent('รหัสผ่านทั้งสองช่องไม่ตรงกัน');
    expect(api.create).not.toHaveBeenCalled();
  });

  it('reports a failed unlock without exposing accounts', async () => {
    vi.mocked(api.status).mockResolvedValue({ exists: true, unlocked: false });
    vi.mocked(api.unlock).mockRejectedValue('รหัสผ่านไม่ถูกต้อง หรือไฟล์ข้อมูลเสียหาย');
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('heading', { name: 'ปลดล็อกบัญชีของคุณ' });
    await user.type(screen.getByLabelText('รหัสผ่านหลัก'), 'wrong password here');
    await user.click(screen.getByRole('button', { name: 'ปลดล็อก' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('รหัสผ่านไม่ถูกต้อง');
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
  });

  it('labels an unconfigured updater honestly and never checks the network', async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByText('alice@example.com');
    await user.click(await screen.findByRole('button', { name: 'ตั้งค่า' }));
    await user.click(screen.getByRole('button', { name: 'อัปเดตแอป' }));
    expect(screen.getByText('ยังไม่ได้เปิดระบบอัปเดต')).toBeVisible();
    const { check } = await import('@tauri-apps/plugin-updater');
    expect(check).not.toHaveBeenCalled();
  });

  it('rejects an invalid Base32 key before sending a native command', async () => {
    const user = userEvent.setup(); render(<App />); await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    await user.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
    await user.type(screen.getByLabelText('ชื่อบัญชี'), 'test@example.invalid');
    await user.type(screen.getByLabelText('คีย์ลับ'), 'invalid018!');
    await user.click(screen.getByRole('dialog').querySelector('button.primary')!);
    expect(screen.getByRole('alert')).toHaveTextContent('Base32');
    expect(api.add).not.toHaveBeenCalled();
  });

  it('adds a synthetic account through Rust without persisting its key in the page', async () => {
    const syncProfile = { configured: true, server: 'https://sync.example.invalid', vaultId: 'test', pending: 0, lastSync: null };
    vi.mocked(api.syncStatus).mockResolvedValue(syncProfile);
    vi.mocked(api.syncOnce).mockResolvedValue({ changed: false, status: syncProfile });
    vi.mocked(api.add).mockResolvedValue([account, { ...account, id: '2', issuer: 'Example', account: 'test@example.invalid' }]);
    const user = userEvent.setup(); render(<App />); await screen.findByText('alice@example.com');
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'เพิ่ม / นำเข้าบัญชี' }));
    await user.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
    await user.type(screen.getByLabelText('บริการ'), 'Example');
    await user.type(screen.getByLabelText('ชื่อบัญชี'), 'test@example.invalid');
    await user.type(screen.getByLabelText('คีย์ลับ'), 'JBSWY3DPEHPK3PXP');
    await user.click(screen.getByRole('dialog').querySelector('button.primary')!);
    expect(await screen.findByText('test@example.invalid')).toBeVisible();
    expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ secret: 'JBSWY3DPEHPK3PXP', uri: '' }));
    expect(screen.queryByDisplayValue('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();
    await waitFor(() => expect(api.syncOnce).toHaveBeenCalledTimes(2));
  });

  it('requires explicit backup replacement confirmation and preserves accounts on failure', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    vi.mocked(open).mockResolvedValue('C:\\test-only\\backup.mfa-backup');
    vi.mocked(api.importBackup).mockRejectedValue('Invalid backup');
    const user = userEvent.setup(); render(<App />); await screen.findByText('alice@example.com');
    await user.click(screen.getByRole('button', { name: 'สำรองข้อมูล' }));
    await user.click(screen.getByRole('button', { name: 'นำเข้าข้อมูล' }));
    await user.type(await screen.findByLabelText('รหัสผ่านของไฟล์สำรอง'), 'test backup password');
    const restore = screen.getByRole('button', { name: 'นำเข้าและปลดล็อก' });
    expect(restore).toBeDisabled();
    expect(api.importBackup).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(restore);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid backup');
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('รหัสผ่านของไฟล์สำรอง')).toHaveValue('');
  });
});
