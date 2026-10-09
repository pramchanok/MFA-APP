import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from '../api';
import { Updates } from './Updates';

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('../api', () => ({ api: { lock: vi.fn() }, safeError: (e: unknown) => String(e) }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.lock).mockResolvedValue(); vi.mocked(relaunch).mockResolvedValue(); });
afterEach(cleanup);

describe('signed update flow', () => {
  it('installs only after a deliberate click and clears native session before relaunch', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue({ version: '0.2.0', body: 'ปรับปรุงแอป', downloadAndInstall, close } as unknown as Update);
    const user = userEvent.setup();
    render(<Updates configured automatic onClose={() => {}} />);
    const install = await screen.findByRole('button', { name: 'ติดตั้งและเปิดแอปใหม่' });
    expect(downloadAndInstall).not.toHaveBeenCalled();
    await user.click(install);
    await waitFor(() => expect(relaunch).toHaveBeenCalledOnce());
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(api.lock).toHaveBeenCalledOnce();
    expect(vi.mocked(api.lock).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(relaunch).mock.invocationCallOrder[0]);
  });

  it('does not report up-to-date when a network check fails', async () => {
    vi.mocked(check).mockRejectedValue('offline');
    render(<Updates configured automatic onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('ไม่สำเร็จ');
    expect(screen.queryByText('คุณใช้เวอร์ชันล่าสุดแล้ว')).not.toBeInTheDocument();
    expect(relaunch).not.toHaveBeenCalled();
  });
});
