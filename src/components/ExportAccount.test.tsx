import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportAccount } from './ExportAccount';
import { api } from '../api';
import type { AccountCode, AccountQr } from '../types';

vi.mock('../api', () => ({ api: { accountQr: vi.fn() }, safeError: () => 'รหัสผ่านไม่ถูกต้อง' }));
const account: AccountCode = { id: 'test-id', issuer: 'Example', account: 'alice@example.invalid', code: '123456', digits: 6, period: 30, remaining: 20 };
const qr: AccountQr = { image: 'data:image/svg+xml;base64,PHN2Zy8+', customParameters: false };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.accountQr).mockResolvedValue(qr); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function reveal() {
  fireEvent.change(screen.getByLabelText('ยืนยันรหัสผ่านหลัก'), { target: { value: 'test-password' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'ยืนยันและแสดง QR' })); });
}

describe('account QR export', () => {
  it('requires a deliberate password confirmation and displays only the returned image', async () => {
    render(<ExportAccount account={account} onClose={vi.fn()} />);
    expect(api.accountQr).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'ยืนยันและแสดง QR' })).toBeDisabled();
    await reveal();
    expect(api.accountQr).toHaveBeenCalledWith('test-id', 'test-password');
    expect(screen.queryByLabelText('ยืนยันรหัสผ่านหลัก')).not.toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('src', qr.image);
    expect(screen.getByText(/บัญชีอื่น → สแกน QR/)).toBeVisible();
    expect(document.body.textContent).not.toContain('otpauth://');
  });

  it('clears the password immediately while waiting and discards a response after closing', async () => {
    let finish!: (value: AccountQr) => void;
    vi.mocked(api.accountQr).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<ExportAccount account={account} onClose={vi.fn()} />);
    await reveal();
    expect(screen.getByLabelText('ยืนยันรหัสผ่านหลัก')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })).toBeEnabled();
    view.unmount();
    await act(async () => { finish(qr); });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('hides the image after 60 seconds and requires a new password', async () => {
    vi.useFakeTimers();
    render(<ExportAccount account={account} onClose={vi.fn()} />);
    await reveal();
    act(() => { vi.advanceTimersByTime(59_999); });
    expect(screen.getByRole('img')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ยืนยันรหัสผ่านหลัก')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'ยืนยันและแสดง QR' })).toBeDisabled();
  });

  it('does not display a QR after a rejected password', async () => {
    vi.mocked(api.accountQr).mockRejectedValue('wrong');
    render(<ExportAccount account={account} onClose={vi.fn()} />);
    await reveal();
    expect(screen.getByRole('alert')).toHaveTextContent('รหัสผ่านไม่ถูกต้อง');
    expect(screen.getByLabelText('ยืนยันรหัสผ่านหลัก')).toHaveValue('');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('warns about unusual TOTP parameters without changing them', async () => {
    vi.mocked(api.accountQr).mockResolvedValue({ ...qr, customParameters: true });
    render(<ExportAccount account={account} onClose={vi.fn()} />);
    await reveal();
    expect(screen.getByRole('alert')).toHaveTextContent('บางรุ่นอาจไม่รองรับ');
  });

  it('purges a visible image and discards pending results when the page becomes hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    render(<ExportAccount account={account} onClose={vi.fn()} />);
    await reveal();
    expect(screen.getByRole('img')).toBeInTheDocument();
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    visibility.mockReturnValue('visible');
    let finish!: (value: AccountQr) => void;
    vi.mocked(api.accountQr).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await reveal();
    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { finish(qr); });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ยืนยันรหัสผ่านหลัก')).toHaveValue('');
    visibility.mockRestore();
  });
});
