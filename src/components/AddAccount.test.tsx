import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddAccount } from './AddAccount';
import { api } from '../api';
import { readQr } from '../qr';
import type { GoogleExportPreview } from '../types';

vi.mock('../api', () => ({ desktop: true, safeError: (e: unknown) => e instanceof Error ? e.message : String(e), api: { add: vi.fn(), previewAccounts: vi.fn(), importAccounts: vi.fn(), previewGoogle: vi.fn(), importGoogle: vi.fn() } }));
vi.mock('../qr', () => ({ readQr: vi.fn() }));
vi.mock('./CameraScanner', () => ({ CameraScanner: ({ onRead, onClose }: { onRead: (uri: string) => void; onClose: () => void }) => <div><button onClick={() => onRead('otpauth://totp/Example:camera?secret=GEZDGNBV')}>ทดสอบอ่าน QR สังเคราะห์</button><button onClick={() => onRead('otpauth-migration://offline?data=SYNTHETIC-PART-2')}>ทดสอบอ่าน QR ส่วนที่สอง</button><button onClick={onClose}>ปิดกล้อง</button></div> }));
const uri = 'otpauth://totp/Example:alice?secret=GEZDGNBV';
const googleUri = 'otpauth-migration://offline?data=SYNTHETIC-TEST-ONLY';
const entry = { index: 0, issuer: 'Example', account: 'alice@example.invalid', algorithm: 'SHA1', digits: 6, reason: null };
const complete: GoogleExportPreview = { entries: [entry], parts: 1, expected: 1, complete: true };
const saved = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.previewAccounts).mockResolvedValue(complete); vi.mocked(api.previewGoogle).mockResolvedValue(complete); vi.mocked(api.importAccounts).mockResolvedValue([]); vi.mocked(api.importGoogle).mockResolvedValue([]); vi.mocked(api.add).mockResolvedValue([]); });
afterEach(cleanup);
function open() { return render(<AddAccount onClose={vi.fn()} onSaved={saved} />); }
async function inspect(text = uri) { fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: text } }); fireEvent.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' })); await screen.findByText('alice@example.invalid'); }

it('routes standard setup QR to a review and imports only explicitly selected new accounts', async () => {
  vi.mocked(api.previewAccounts).mockResolvedValue({ ...complete, entries: [entry, { ...entry, index: 1, account: 'duplicate@example.invalid', reason: 'duplicate' }] });
  open(); await inspect();
  expect(api.previewAccounts).toHaveBeenCalledWith([uri]); expect(api.importAccounts).not.toHaveBeenCalled();
  expect(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี')).toHaveValue('');
  expect(screen.getAllByRole('checkbox')[1]).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  await waitFor(() => expect(api.importAccounts).toHaveBeenCalledWith([uri], [0]));
  expect(saved).toHaveBeenCalledWith([], 1);
});

it('detects Google export automatically and requires all parts before explicit import', async () => {
  vi.mocked(api.previewGoogle).mockResolvedValueOnce({ ...complete, complete: false, expected: 2 });
  open(); await inspect(googleUri);
  expect(api.previewGoogle).toHaveBeenCalledWith([googleUri]); expect(api.previewAccounts).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  vi.mocked(api.previewGoogle).mockResolvedValue({ entries: [entry, { ...entry, index: 1, account: 'bob@example.invalid' }], parts: 2, expected: 2, complete: true });
  const review = screen.getByRole('region', { name: 'ตรวจบัญชีก่อนบันทึก' });
  fireEvent.click(within(review).getByRole('button', { name: 'สแกน QR รูปถัดไป' }));
  fireEvent.click(screen.getByRole('button', { name: 'ทดสอบอ่าน QR ส่วนที่สอง' }));
  await screen.findByText('bob@example.invalid');
  await waitFor(() => expect(screen.getByText('อ่านครบแล้ว 2 / 2 QR')).toHaveFocus());
  expect(api.importGoogle).not.toHaveBeenCalled();
  expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  await waitFor(() => expect(api.importGoogle).toHaveBeenCalledWith([googleUri, 'otpauth-migration://offline?data=SYNTHETIC-PART-2'], [1]));
});

it('keeps the import draft open on backdrop click and Escape until explicitly closed', async () => {
  const onClose = vi.fn();
  render(<AddAccount onClose={onClose} onSaved={saved} />);
  await inspect();
  const dialog = screen.getByRole('dialog');
  fireEvent.mouseDown(dialog.parentElement!);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText('alice@example.invalid')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'ปิดหน้าต่าง' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('reads multiple standard QR images locally into a single reviewed selection', async () => {
  vi.mocked(readQr).mockResolvedValueOnce(uri).mockResolvedValueOnce(`${uri}&issuer=Example`);
  open(); fireEvent.change(screen.getByLabelText('รูป QR สำหรับเพิ่มบัญชี'), { target: { files: [new File(['x'], 'one.png', { type: 'image/png' }), new File(['y'], 'two.png', { type: 'image/png' })] } });
  await screen.findByText('alice@example.invalid');
  expect(readQr).toHaveBeenCalledTimes(2); expect(api.previewAccounts).toHaveBeenCalledWith([uri, `${uri}&issuer=Example`]); expect(api.importAccounts).not.toHaveBeenCalled();
});

it('camera QR enters the same preview and closes the camera without saving', async () => {
  open(); fireEvent.click(screen.getByRole('button', { name: /สแกนด้วยกล้อง/ })); fireEvent.click(screen.getByRole('button', { name: 'ทดสอบอ่าน QR สังเคราะห์' }));
  await screen.findByText('alice@example.invalid');
  expect(api.previewAccounts).toHaveBeenCalledWith(['otpauth://totp/Example:camera?secret=GEZDGNBV']);
  expect(screen.queryByRole('button', { name: 'ปิดกล้อง' })).not.toBeInTheDocument(); expect(api.importAccounts).not.toHaveBeenCalled();
});

it('keeps a valid preview after an invalid or mixed QR and allows resetting the batch', async () => {
  open(); await inspect(); await inspect(googleUri);
  expect(await screen.findByRole('alert')).toHaveTextContent('เริ่มชุดใหม่'); expect(api.previewGoogle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'เริ่มชุดใหม่' }));
  expect(screen.queryByText('alice@example.invalid')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'นำเข้า 0 บัญชี' })).toBeDisabled();
});

it('keeps selection after a save failure and ignores late native previews after unmount', async () => {
  vi.mocked(api.importAccounts).mockRejectedValue('คลังบัญชีถูกล็อก');
  const view = open(); await inspect(); fireEvent.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ถูกล็อก'); expect(screen.getByRole('checkbox')).toBeChecked(); expect(saved).not.toHaveBeenCalled();
  let resolve!: (result: GoogleExportPreview) => void;
  vi.mocked(api.previewAccounts).mockImplementation(() => new Promise((done) => { resolve = done; }));
  fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: uri } }); fireEvent.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
  view.unmount(); await act(async () => { resolve(complete); }); expect(saved).not.toHaveBeenCalled();
});

it('accepts a manually entered synthetic Base32 secret only on explicit save', async () => {
  open(); fireEvent.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
  fireEvent.change(screen.getByLabelText('ชื่อบัญชี'), { target: { value: 'synthetic@example.invalid' } }); fireEvent.change(screen.getByLabelText('คีย์ลับ'), { target: { value: 'GEZDGNBV' } });
  expect(api.add).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'เพิ่มบัญชี' }));
  await waitFor(() => expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ account: 'synthetic@example.invalid', secret: 'GEZDGNBV', uri: '' })));
});

it('keeps reviewed QR selection while switching to and from the manual secret form', async () => {
  open(); await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
  expect(screen.getByText(/รายการ QR ที่ตรวจไว้ยังอยู่/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('คีย์ลับ'), { target: { value: 'GEZDGNBV' } });
  fireEvent.click(screen.getByRole('button', { name: 'วาง URI แทน' }));
  expect(screen.getByText('alice@example.invalid')).toBeVisible(); expect(screen.getByRole('checkbox')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'กรอกคีย์ลับแทน' }));
  expect(screen.getByLabelText('คีย์ลับ')).toHaveValue(''); expect(api.add).not.toHaveBeenCalled();
});

it('rejects unsupported setup QR without a native call and allows opening the scanner again', async () => {
  open(); fireEvent.change(screen.getByLabelText('URI ตั้งค่า 2FA หรือส่งออกบัญชี'), { target: { value: 'https://example.invalid/push-enrollment' } });
  fireEvent.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ไม่ใช่รหัส TOTP'); expect(api.previewAccounts).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /สแกนด้วยกล้อง/ }));
  expect(screen.getByRole('button', { name: 'ทดสอบอ่าน QR สังเคราะห์' })).toBeVisible();
});
