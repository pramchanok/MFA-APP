import { useEffect, useState } from 'react';

export type Appearance = 'light' | 'dark' | 'system';
export type CardSize = 'compact' | 'standard' | 'large';
const KEY = 'mfa-appearance';
const CARD_SIZE_KEY = 'mfa-card-size';
const valid = (value: unknown): value is Appearance => value === 'light' || value === 'dark' || value === 'system';

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { const saved = localStorage.getItem(KEY); return valid(saved) ? saved : 'system'; }
    catch { return 'system'; }
  });
  const [cardSize, setCardSize] = useState<CardSize>(() => {
    try {
      const saved = localStorage.getItem(CARD_SIZE_KEY);
      if (saved === 'standard' || saved === 'large') return saved;
    } catch { /* Use the default when storage is unavailable. */ }
    return 'compact';
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
  function changeCardSize(value: CardSize) {
    setCardSize(value);
    try { localStorage.setItem(CARD_SIZE_KEY, value); } catch { /* Apply the size for this session. */ }
  }
  return { appearance, setAppearance, cardSize, setCardSize: changeCardSize, dark, toggle: () => setAppearance(dark ? 'light' : 'dark') };
}
