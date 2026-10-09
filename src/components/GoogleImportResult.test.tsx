import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GoogleImportResult } from './GoogleImportResult';

const props = { count: 2, status: null, working: false, syncError: '', onClose: vi.fn(), onSync: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('allows viewing offline codes while sync status is loading or failed', () => {
  const view = render(<GoogleImportResult {...props} />);
  expect(screen.getByRole('button', { name: 'ตั้งค่าซิงค์อุปกรณ์' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'ดูรหัสที่นำเข้า' }));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  view.rerender(<GoogleImportResult {...props} syncError="connection failed" />);
  expect(screen.getByRole('status')).toHaveTextContent('ตรวจการตั้งค่าซิงค์ไม่สำเร็จ');
  expect(screen.queryByText('ไม่มีรายการรอส่ง · ซิงค์กับเซิร์ฟเวอร์แล้ว')).not.toBeInTheDocument();
});

it('reports pending work and failures without claiming imported accounts were synced', () => {
  const status = { configured: true, server: 'https://sync.example.invalid', vaultId: 'synthetic', pending: 2, lastSync: 1 };
  const view = render(<GoogleImportResult {...props} status={status} />);
  expect(screen.getByRole('status')).toHaveTextContent('มี 2 รายการรอส่ง');
  view.rerender(<GoogleImportResult {...props} status={status} syncError="offline" />);
  expect(screen.getByRole('status')).toHaveTextContent('ยังซิงค์ไม่สำเร็จ');
  expect(screen.queryByText('ไม่มีรายการรอส่ง · ซิงค์กับเซิร์ฟเวอร์แล้ว')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'จัดการซิงค์ / จับคู่เครื่องอื่น' }));
  expect(props.onSync).toHaveBeenCalledTimes(1);
});
