import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { useSync } from './useSync';
import type { SyncResult } from './types';
vi.mock('./api', () => ({ desktop: true, safeError: () => 'offline', api: { syncStatus: vi.fn(), syncOnce: vi.fn() } }));
const profile = { configured: true, server: 'https://sync.example.invalid', vaultId: 'test', pending: 1, lastSync: null };
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); vi.mocked(api.syncStatus).mockResolvedValue(profile); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('syncs when unlocked, retries offline while preserving status, stops while locked', async () => {
  vi.mocked(api.syncOnce).mockRejectedValueOnce('offline').mockResolvedValue({ changed: true, status: { ...profile, pending: 0, lastSync: 100 } });
  const changed = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ unlocked }) => useSync(unlocked, changed), { initialProps: { unlocked: true } });
  await act(async () => {});
  expect(result.current.error).toBe('offline'); expect(result.current.status?.pending).toBe(1);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(changed).toHaveBeenCalledTimes(1); expect(result.current.status?.pending).toBe(0); expect(result.current.error).toBe('');
  rerender({ unlocked: false });
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2); expect(result.current.status).toBeNull();
});
it('ignores a response arriving after lock and never refreshes accounts', async () => {
  let finish!: (value: SyncResult) => void;
  vi.mocked(api.syncOnce).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const changed = vi.fn().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ unlocked }) => useSync(unlocked, changed), { initialProps: { unlocked: true } });
  await act(async () => {}); rerender({ unlocked: false });
  await act(async () => { finish({ changed: true, status: profile }); });
  expect(changed).not.toHaveBeenCalled(); expect(result.current.status).toBeNull();
});
it('allows one sync at a time even if the interval fires during a request', async () => {
  let finish!: (value: SyncResult) => void;
  vi.mocked(api.syncOnce).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ changed: false, status: profile }); });
});
it('polls idle vaults every two minutes and manual/local-change refresh runs immediately', async () => {
  vi.mocked(api.syncOnce).mockResolvedValue({ changed: false, status: { ...profile, pending: 0 } });
  const { result } = renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2);
  await act(async () => { await result.current.refresh(); });
  expect(api.syncOnce).toHaveBeenCalledTimes(3);
});
it('waits two minutes from request completion without skipping a poll due to network latency', async () => {
  vi.mocked(api.syncOnce).mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { changed: false, status: { ...profile, pending: 0 } };
  });
  renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(119_999); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2);
});
it('backs off failed requests to five minutes and resumes immediately when online', async () => {
  vi.mocked(api.syncOnce).mockRejectedValue('offline');
  renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(3);
  await act(async () => { vi.advanceTimersByTime(240_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(4);
  await act(async () => { vi.advanceTimersByTime(240_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(4);
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(api.syncOnce).toHaveBeenCalledTimes(5);
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(api.syncOnce).toHaveBeenCalledTimes(6);
});
it('queues a local edit during a request and sends it after the in-flight operation', async () => {
  let finish!: (value: SyncResult) => void;
  vi.mocked(api.syncOnce).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ changed: false, status: { ...profile, pending: 0 } });
  const { result } = renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { await result.current.refresh(); await result.current.refresh(); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ changed: false, status: { ...profile, pending: 0 } }); });
  expect(api.syncOnce).toHaveBeenCalledTimes(2);
});
it('cancels a queued follow-up when the component unmounts', async () => {
  let finish!: (value: SyncResult) => void;
  vi.mocked(api.syncOnce).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ changed: false, status: { ...profile, pending: 0 } });
  const { result, unmount } = renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  await act(async () => { await result.current.refresh(); });
  unmount();
  await act(async () => { finish({ changed: false, status: profile }); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
});
it('skips network while offline/hidden and resumes on visibility without waiting for the next poll', async () => {
  vi.mocked(api.syncOnce).mockResolvedValue({ changed: false, status: { ...profile, pending: 0 } });
  const offline = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  renderHook(() => useSync(true, vi.fn().mockResolvedValue(undefined)));
  await act(async () => {});
  expect(api.syncOnce).not.toHaveBeenCalled();
  offline.mockReturnValue(true);
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(api.syncOnce).not.toHaveBeenCalled();
  hidden.mockReturnValue('visible');
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(api.syncOnce).toHaveBeenCalledTimes(1);
});
