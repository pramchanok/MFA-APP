import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { CameraScanner } from './CameraScanner';

vi.mock('jsqr', () => ({ default: vi.fn() }));
const stop = vi.fn();
const getCapabilities = vi.fn();
const applyConstraints = vi.fn();
const track = { stop, getCapabilities, applyConstraints, getConstraints: () => ({ width: { ideal: 1920 } }), getSettings: () => ({ focusMode: 'continuous' }), readyState: 'live' };
const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
const getUserMedia = vi.fn();
const enumerateDevices = vi.fn();
const read = vi.fn();
const pixels = new Uint8ClampedArray(16);
beforeEach(() => {
  vi.clearAllMocks(); pixels.fill(255);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia, enumerateDevices } });
  getUserMedia.mockResolvedValue(stream);
  enumerateDevices.mockResolvedValue([]);
  getCapabilities.mockReturnValue({});
  applyConstraints.mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: pixels, width: 2, height: 2 }), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.mocked(jsQR).mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('requests video without audio and stops every track when closed/unmounted', async () => {
  const view = render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  await screen.findByText(/จัด QR ให้อยู่กลางกรอบ/);
  expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false, video: expect.any(Object) }));
  expect(applyConstraints).not.toHaveBeenCalled();
  view.unmount(); expect(stop).toHaveBeenCalled();
});

it('requests continuous autofocus without dropping the existing capture constraints', async () => {
  getCapabilities.mockReturnValue({ focusMode: ['continuous', 'single-shot'] });
  render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  await waitFor(() => expect(applyConstraints).toHaveBeenCalledExactlyOnceWith({ width: { ideal: 1920 }, advanced: [{ focusMode: 'continuous' }] }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('offers single-shot refocus when continuous focus is unavailable or rejected', async () => {
  getCapabilities.mockReturnValue({ focusMode: ['continuous', 'single-shot'] });
  applyConstraints.mockRejectedValueOnce(new DOMException('synthetic failure', 'OverconstrainedError'));
  render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'โฟกัสใหม่' }));
  await waitFor(() => expect(applyConstraints).toHaveBeenLastCalledWith({ width: { ideal: 1920 }, advanced: [{ focusMode: 'single-shot' }] }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('stops the previous camera before opening the selected camera', async () => {
  enumerateDevices.mockResolvedValue([
    { kind: 'videoinput', deviceId: 'integrated', label: 'Integrated' },
    { kind: 'videoinput', deviceId: 'external', label: 'External' },
    { kind: 'audioinput', deviceId: 'microphone', label: 'Microphone' },
  ]);
  render(<CameraScanner onRead={read} onClose={vi.fn()} />);
  const picker = await screen.findByRole('combobox', { name: 'กล้อง' });
  expect(screen.queryByRole('option', { name: 'Microphone' })).not.toBeInTheDocument();
  getUserMedia.mockImplementationOnce(async () => { expect(stop).toHaveBeenCalled(); return stream; });
  fireEvent.change(picker, { target: { value: 'external' } });
  await waitFor(() => expect(getUserMedia).toHaveBeenLastCalledWith({ audio: false, video: { deviceId: { exact: 'external' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24 } } }));
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
  await screen.findByText(/จัด QR ให้อยู่กลางกรอบ/);
  fireEvent.click(screen.getByRole('button', { name: 'ปิดกล้อง' })); expect(close).toHaveBeenCalled(); expect(stop).toHaveBeenCalled();
});
