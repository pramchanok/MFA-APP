import { useEffect, useState } from 'react';

export type Appearance = 'light' | 'dark' | 'system';
const KEY = 'mfa-appearance';
const valid = (value: unknown): value is Appearance => value === 'light' || value === 'dark' || value === 'system';

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { const saved = localStorage.getItem(KEY); return valid(saved) ? saved : 'system'; }
    catch { return 'system'; }
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const dark = appearance === 'dark' || (appearance === 'system' && systemDark);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const changed = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // Persist only this display preference, never account data or vault credentials.
    try { localStorage.setItem(KEY, appearance); } catch { /* Appearance still works when storage is unavailable. */ }
  }, [appearance, dark]);
  return { appearance, setAppearance, dark, toggle: () => setAppearance(dark ? 'light' : 'dark') };
}
