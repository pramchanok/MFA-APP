import { useCallback, useEffect, useRef, useState } from 'react';
import { api, desktop, safeError } from './api';
import type { SyncStatus } from './types';

const ACTIVE_MS = 60_000;
const IDLE_MS = 120_000;
const MAX_RETRY_MS = 300_000;
// Sync runs only inside the unlocked native app. A failed request leaves the
// native encrypted outbox intact; there is no browser credential storage.
export function useSync(unlocked: boolean, onChanged: () => Promise<void>) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const enabled = useRef(unlocked);
  const nextPoll = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelay = useRef(ACTIVE_MS);
  const queued = useRef(false);
  const runner = useRef<() => Promise<void>>(async () => {});
  enabled.current = unlocked;
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const refresh = useCallback(async () => {
    if (!desktop || !enabled.current || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    // A local edit during an in-flight request must get its own following sync.
    if (inFlight.current) { queued.current = true; return; }
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
    const token = epoch.current;
    const current = () => enabled.current && token === epoch.current;
    inFlight.current = true;
    setWorking(true);
    try {
      const profile = await api.syncStatus();
      if (!current()) return;
      setStatus(profile);
      if (profile.configured) {
        const result = await api.syncOnce();
        if (!current()) return;
        setStatus(result.status);
        nextPoll.current = Date.now() + (result.changed || result.status.pending > 0 ? ACTIVE_MS : IDLE_MS);
        if (result.changed) await changed.current();
      } else nextPoll.current = Date.now() + IDLE_MS;
      retryDelay.current = ACTIVE_MS;
      if (current()) setError('');
    } catch (e) {
      if (current()) {
        setError(safeError(e));
        nextPoll.current = Date.now() + retryDelay.current;
        retryDelay.current = Math.min(MAX_RETRY_MS, retryDelay.current * 2);
      }
    } finally {
      inFlight.current = false;
      if (current()) setWorking(false);
      if (queued.current) { queued.current = false; void runner.current(); }
      else if (current()) {
        // Schedule after completion so request latency cannot skip an interval.
        pollTimer.current = setTimeout(() => { pollTimer.current = null; void runner.current(); },
          Math.max(0, nextPoll.current - Date.now()));
      }
    }
  }, []);
  runner.current = refresh;
  useEffect(() => {
    epoch.current += 1;
    queued.current = false;
    nextPoll.current = 0;
    retryDelay.current = ACTIVE_MS;
    if (!unlocked) { setStatus(null); setError(''); setWorking(false); return; }
    void refresh();
    const resume = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      epoch.current += 1;
      queued.current = false;
      if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
      window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume);
    };
  }, [unlocked, refresh]);
  return { status, error, working, refresh };
}
