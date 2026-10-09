import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountRow } from './AccountRow';
const account = { id: 'synthetic', issuer: 'Google', account: 'test@example.invalid', code: '123456', digits: 6, period: 30, remaining: 20 };
const props = { account, copied: false, preview: false, onCopy: vi.fn(), onExport: vi.fn(), onDelete: vi.fn() };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('copies from card space or keyboard and never copies from controls or the drag grip', async () => {
  const user = userEvent.setup(); render(<AccountRow {...props} onDragStart={vi.fn()} onMoveTop={vi.fn()} />);
  await user.click(screen.getByText('Google'));
  expect(props.onCopy).toHaveBeenCalledTimes(1);
  const card = screen.getByRole('article');
  card.focus(); await user.keyboard('{Enter}'); await user.keyboard(' ');
  expect(props.onCopy).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole('button', { name: /ซ่อนรหัส/ }));
  await user.click(screen.getByRole('button', { name: /ลากเรียง/ }));
  await user.click(screen.getByRole('button', { name: /ตัวเลือกบัญชี/ }));
  await user.click(screen.getByRole('button', { name: 'ย้ายขึ้นบนสุด' }));
  expect(props.onCopy).toHaveBeenCalledTimes(3);
});
it('never copies synthetic preview cards', () => {
  render(<AccountRow {...props} preview />);
  fireEvent.click(screen.getByRole('article'));
  fireEvent.keyDown(screen.getByRole('article'), { key: 'Enter' });
  expect(props.onCopy).not.toHaveBeenCalled();
});
it('keeps hidden codes hidden when the timer refreshes and copies through the native callback', async () => {
  const user = userEvent.setup(); const view = render(<AccountRow {...props} />);
  await user.click(screen.getByRole('button', { name: /ซ่อนรหัส/ }));
  expect(screen.queryByLabelText('รหัส 123456')).not.toBeInTheDocument();
  view.rerender(<AccountRow {...props} account={{ ...account, code: '987654', remaining: 4 }} />);
  expect(screen.queryByLabelText('รหัส 987654')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /คัดลอกรหัส/ }));
  expect(props.onCopy).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: /แสดงรหัส/ }));
  expect(screen.getByLabelText('รหัส 987654')).toHaveTextContent('987 654');
});
it('opens account actions deliberately, closes on Escape or outside click, and dispatches only a selected action', async () => {
  const user = userEvent.setup(); render(<AccountRow {...props} />);
  const options = screen.getByRole('button', { name: /ตัวเลือกบัญชี/ });
  expect(screen.queryByRole('button', { name: /ลบบัญชี/ })).not.toBeInTheDocument();
  await user.click(options); await user.keyboard('{Escape}');
  expect(options).toHaveFocus(); expect(options).toHaveAttribute('aria-expanded', 'false');
  await user.click(options); fireEvent.pointerDown(document.body);
  expect(options).toHaveAttribute('aria-expanded', 'false');
  await user.click(options); await user.click(screen.getByRole('button', { name: /แสดง QR/ }));
  expect(props.onExport).toHaveBeenCalledTimes(1); expect(props.onDelete).not.toHaveBeenCalled();
  expect(options).toHaveAttribute('aria-expanded', 'false');
});
