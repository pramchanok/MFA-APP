import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type Drag = { id: string; over: string };
export function useCardDrag(disabled: boolean, onMove: (id: string, target: string) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const pending = useRef<{ id: string; pointer: number; x: number; y: number; active: boolean; over: string } | null>(null);
  const move = useRef(onMove);
  move.current = onMove;
  useEffect(() => {
    const cancel = () => { pending.current = null; setDrag(null); };
    if (disabled) { cancel(); return; }
    const motion = (event: PointerEvent) => {
      const current = pending.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 7) return;
      current.active = true;
      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-account-id]');
      if (card?.dataset.accountId) current.over = card.dataset.accountId;
      setDrag({ id: current.id, over: current.over });
      if (event.clientY < 70) window.scrollBy(0, -18);
      else if (event.clientY > window.innerHeight - 70) window.scrollBy(0, 18);
    };
    const finish = (event: PointerEvent) => {
      const current = pending.current;
      if (!current || current.pointer !== event.pointerId) return;
      cancel();
      if (current.active && current.over !== current.id) move.current(current.id, current.over);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', motion);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      pending.current = null;
      window.removeEventListener('pointermove', motion);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape);
    };
  }, [disabled]);
  function start(id: string, event: ReactPointerEvent<HTMLButtonElement>) {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pending.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, over: id };
  }
  return { drag, start };
}
