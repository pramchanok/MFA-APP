import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GoogleImport } from './GoogleImport';
import { api } from '../api';
import { readQr } from '../qr';
import type { GoogleExportPreview } from '../types';

vi.mock('../api', () => ({ desktop: true, safeError: (e: unknown) => e instanceof Error ? e.message : String(e), api: { previewGoogle: vi.fn(), importGoogle: vi.fn() } }));
vi.mock('../qr', () => ({ readQr: vi.fn() }));
const uri = 'otpauth-migration://offline?data=SYNTHETIC-TEST-ONLY';
const entry = { index: 0, issuer: 'Example', account: 'alice@example.invalid', algorithm: 'SHA1', digits: 6, reason: null };
const complete: GoogleExportPreview = { entries: [entry], parts: 1, expected: 1, complete: true };
const saved = vi.fn();
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.previewGoogle).mockResolvedValue(complete); vi.mocked(api.importGoogle).mockResolvedValue([]); });
afterEach(cleanup);
async function inspect(text = uri) {
  fireEvent.change(screen.getByLabelText('หรือวาง URI ส่งออก'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
  await screen.findByText('alice@example.invalid');
}
function open() { return render(<GoogleImport onClose={vi.fn()} onSaved={saved} onBusy={vi.fn()} />); }

it('previews without saving and imports only explicitly selected new accounts', async () => {
  vi.mocked(api.previewGoogle).mockResolvedValue({ ...complete, entries: [entry, { ...entry, index: 1, account: 'bob@example.invalid' }, { ...entry, index: 2, account: 'duplicate@example.invalid', reason: 'duplicate' }, { ...entry, index: 3, account: 'counter', reason: 'hotp' }] });
  const user = userEvent.setup(); open(); await inspect();
  expect(api.importGoogle).not.toHaveBeenCalled();
  expect(screen.getByLabelText('หรือวาง URI ส่งออก')).toHaveValue('');
  const checks = screen.getAllByRole('checkbox');
  expect(checks[2]).toBeDisabled(); expect(checks[3]).toBeDisabled();
  await user.click(checks[1]);
  await user.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  await waitFor(() => expect(api.importGoogle).toHaveBeenCalledWith([uri], [0]));
  expect(saved).toHaveBeenCalledWith([], 1);
});

it('requires all QR parts and preserves selection while adding the next part', async () => {
  vi.mocked(api.previewGoogle).mockResolvedValueOnce({ ...complete, complete: false, expected: 2 });
  open(); await inspect();
  expect(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' })).toBeDisabled();
  const user = userEvent.setup(); await user.click(screen.getByRole('checkbox'));
  vi.mocked(api.previewGoogle).mockResolvedValue({ entries: [entry, { ...entry, index: 1, account: 'bob@example.invalid' }], parts: 2, expected: 2, complete: true });
  await inspect(`${uri}-PART-2`);
  await screen.findByText('bob@example.invalid');
  expect(screen.getAllByRole('checkbox')[0]).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  await waitFor(() => expect(api.importGoogle).toHaveBeenCalledWith([uri, `${uri}-PART-2`], [1]));
});

it('keeps a valid preview when another QR is rejected and resets sensitive inputs', async () => {
  open(); await inspect();
  vi.mocked(api.previewGoogle).mockRejectedValue(new Error('QR มาจากคนละชุดส่งออก'));
  await inspect(`${uri}-WRONG`);
  expect(await screen.findByRole('alert')).toHaveTextContent('คนละชุด');
  expect(screen.getByText('alice@example.invalid')).toBeVisible();
  expect(screen.getByLabelText('หรือวาง URI ส่งออก')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'เริ่มชุดใหม่' }));
  expect(screen.queryByText('alice@example.invalid')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'นำเข้า 0 บัญชี' })).toBeDisabled();
});

it('does not repopulate a closed import from a late native response', async () => {
  let resolve!: (value: GoogleExportPreview) => void;
  vi.mocked(api.previewGoogle).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = open();
  fireEvent.change(screen.getByLabelText('หรือวาง URI ส่งออก'), { target: { value: uri } });
  fireEvent.click(screen.getByRole('button', { name: 'อ่านรายการบัญชี' }));
  view.unmount();
  await act(async () => { resolve(complete); });
  expect(saved).not.toHaveBeenCalled(); expect(api.importGoogle).not.toHaveBeenCalled();
});

it('reads multiple images locally before presenting one selection', async () => {
  vi.mocked(readQr).mockResolvedValueOnce(uri).mockResolvedValueOnce(`${uri}-PART-2`);
  vi.mocked(api.previewGoogle).mockResolvedValue({ ...complete, parts: 2, expected: 2 });
  open();
  fireEvent.change(screen.getByLabelText('รูป QR ส่งออกจาก Google'), { target: { files: [new File(['x'], 'part-1.png', { type: 'image/png' }), new File(['y'], 'part-2.png', { type: 'image/png' })] } });
  await screen.findByText('alice@example.invalid');
  expect(readQr).toHaveBeenCalledTimes(2);
  expect(api.previewGoogle).toHaveBeenCalledWith([uri, `${uri}-PART-2`]);
  expect(api.importGoogle).not.toHaveBeenCalled();
});

it('reports a save failure without clearing the selection or closing the form', async () => {
  vi.mocked(api.importGoogle).mockRejectedValue('คลังบัญชีถูกล็อก');
  open(); await inspect();
  fireEvent.click(screen.getByRole('button', { name: 'นำเข้า 1 บัญชี' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('ถูกล็อก');
  expect(screen.getByRole('checkbox')).toBeChecked(); expect(saved).not.toHaveBeenCalled();
});
