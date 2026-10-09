import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { Sync } from './Sync';
vi.mock('../api', () => ({ desktop: true, safeError: () => 'connection failed', api: { syncPairing: vi.fn(), syncDisconnect: vi.fn(), syncPair: vi.fn(), syncCreate: vi.fn() } }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,SYNTHETIC') } }));
const status = { configured: true, server: 'https://sync.example.invalid', vaultId: 'synthetic', pending: 0, lastSync: null };
const props = { status, working: false, syncError: '', refresh: vi.fn().mockResolvedValue(undefined), onChanged: vi.fn(), onClose: vi.fn() };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('reveals pairing material only on demand and clears it after sixty seconds', async () => {
  vi.useFakeTimers(); vi.mocked(api.syncPairing).mockResolvedValue({ uri: 'mfa-sync://pair?data=SYNTHETIC' });
  render(<Sync {...props} />);
  expect(api.syncPairing).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'แสดง QR จับคู่อุปกรณ์' })); });
  expect(screen.getByAltText('QR จับคู่อุปกรณ์ MFA')).toBeVisible();
  expect(screen.getByLabelText('รหัสจับคู่สำหรับอีกเครื่อง')).toHaveValue('mfa-sync://pair?data=SYNTHETIC');
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(screen.queryByAltText('QR จับคู่อุปกรณ์ MFA')).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue('mfa-sync://pair?data=SYNTHETIC')).not.toBeInTheDocument();
});
it('requires explicit confirmation before dropping the local sync profile', async () => {
  vi.mocked(api.syncDisconnect).mockResolvedValue(); render(<Sync {...props} />);
  fireEvent.click(screen.getByText('ยกเลิกการซิงค์เครื่องนี้'));
  expect(screen.getByRole('button', { name: 'หยุดซิงค์เครื่องนี้' })).toBeDisabled();
  expect(api.syncDisconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'หยุดซิงค์เครื่องนี้' })); });
  expect(api.syncDisconnect).toHaveBeenCalledTimes(1); expect(props.onChanged).toHaveBeenCalled();
});
it('clears submitted pairing capability after a failed pair, without replacing displayed accounts', async () => {
  vi.mocked(api.syncPair).mockRejectedValue('connection failed'); render(<Sync {...props} status={{ ...status, configured: false }} />);
  fireEvent.change(screen.getByLabelText('หรือวางรหัสจับคู่'), { target: { value: 'mfa-sync://pair?data=SYNTHETIC' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'จับคู่และรวมบัญชี' }).closest('form')!); });
  expect(screen.getByRole('alert')).toHaveTextContent('connection failed');
  expect(screen.getByLabelText('หรือวางรหัสจับคู่')).toHaveValue('');
  expect(props.onChanged).toHaveBeenCalledWith();
});
