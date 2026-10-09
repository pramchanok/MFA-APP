import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { CameraScanner } from './CameraScanner';

vi.mock('jsqr', () => ({ default: vi.fn() }));
const stop = vi.fn();
const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
const getUserMedia = vi.fn();
const read = vi.fn();
const pixels = new Uint8ClampedArray(16);
beforeEach(() => {
  vi.clearAllMocks(); pixels.fill(255);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: pixels, width: 2, height: 2 }), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.mocked(jsQR).mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('requests video without audio and stops every track when closed/unmounted', async () => {
  const view = render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  await screen.findByText('ส่อง QR ให้เต็มกรอบ กล้องจะปิดเมื่ออ่านสำเร็จ');
  expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.any(Object) }));
  view.unmount(); expect(stop).toHaveBeenCalled();
});

it('stops a camera request that resolves after the scanner has unmounted', async () => {
  let resolve!: (value: MediaStream) => void;
  getUserMedia.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = render(<CameraScanner onRead={read} onClose={vi.fn()} />); view.unmount();
  await act(async () => { resolve(stream); }); expect(stop).toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

it.each([['NotAllowedError', 'ยังไม่ได้รับสิทธิ์กล้อง'], ['NotFoundError', 'ไม่พบกล้อง'], ['NotReadableError', 'กล้องอาจถูกใช้งานอยู่']])('explains %s and offers another source', async (name, expected) => {
  getUserMedia.mockRejectedValue(new DOMException('synthetic failure', name));
  render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(expected); expect(screen.getByRole('button', { name: 'ลองเปิดกล้องอีกครั้ง' })).toBeEnabled(); expect(read).not.toHaveBeenCalled();
});

it('decodes a synthetic frame once, clears its pixels, and stops the stream before passing the URI', async () => {
  vi.mocked(jsQR).mockReturnValue({ data: 'otpauth://totp/Synthetic?secret=GEZDGNBV' } as ReturnType<typeof jsQR>);
  vi.spyOn(HTMLVideoElement.prototype, 'readyState', 'get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(2);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(2);
  render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  await waitFor(() => expect(read).toHaveBeenCalledExactlyOnceWith('otpauth://totp/Synthetic?secret=GEZDGNBV'));
  expect(stop).toHaveBeenCalled(); expect([...pixels]).toEqual(Array(16).fill(0));
});

it('retries after permission is granted and supports explicit close', async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException('synthetic failure', 'NotAllowedError')).mockResolvedValueOnce(stream);
  const close = vi.fn(); render(<CameraScanner onRead={read} onClose={close} />);
  await screen.findByRole('alert'); fireEvent.click(screen.getByRole('button', { name: 'ลองเปิดกล้องอีกครั้ง' }));
  await screen.findByText('ส่อง QR ให้เต็มกรอบ กล้องจะปิดเมื่ออ่านสำเร็จ');
  fireEvent.click(screen.getByRole('button', { name: 'ปิดกล้อง' })); expect(close).toHaveBeenCalled(); expect(stop).toHaveBeenCalled();
});
