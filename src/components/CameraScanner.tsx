import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';

type FocusMode = 'continuous' | 'single-shot';
type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type FocusConstraint = MediaTrackConstraintSet & { focusMode: FocusMode };

async function setCameraFocus(track: MediaStreamTrack, mode: FocusMode) {
  try {
    // Keep the current camera selection and capture size when changing focus.
    const constraints = track.getConstraints();
    const focus: FocusConstraint = { focusMode: mode };
    await track.applyConstraints({ ...constraints, advanced: [...(constraints.advanced ?? []).filter((entry) => !('focusMode' in entry)), focus] });
    return (track.getSettings() as MediaTrackSettings & { focusMode?: string }).focusMode === mode;
  } catch { return false; }
}

function cameraError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'ยังไม่ได้รับสิทธิ์กล้อง กรุณาอนุญาตกล้องในการตั้งค่าของระบบ แล้วลองอีกครั้ง หรือเลือกรูป QR';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'ไม่พบกล้องบนเครื่องนี้ คุณยังเลือกรูป QR หรือวาง URI ได้';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'เปิดกล้องไม่ได้ กล้องอาจถูกใช้งานอยู่ กรุณาปิดแอปที่ใช้กล้องแล้วลองอีกครั้ง';
  return 'เปิดกล้องไม่ได้ คุณยังเลือกรูป QR หรือวาง URI ได้';
}

// Video frames and decoded QR values stay on this device. No audio is requested.
export function CameraScanner({ onRead, onClose }: { onRead: (uri: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const callback = useRef(onRead);
  const shutdown = useRef<() => void>(() => {});
  callback.current = onRead;
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState('');
  const [focusTrack, setFocusTrack] = useState<MediaStreamTrack>();
  const [focusing, setFocusing] = useState(false);
  const [canControlFocus, setCanControlFocus] = useState(false);

  useEffect(() => {
    let active = true;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current && video.current.srcObject === stream) video.current.srcObject = null;
      canvas.width = 0; canvas.height = 0;
    };
    shutdown.current = () => { active = false; stop(); };
    setError(''); setReady(false); setFocusTrack(undefined); setFocusing(false); setCanControlFocus(false);
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable');
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(selectedCamera ? { deviceId: { exact: selectedCamera } } : { facingMode: { ideal: 'environment' } }),
            width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24 },
          },
        });
        if (!active) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        const element = video.current;
        if (!element) { stop(); return; }
        element.srcObject = stream;
        await element.play();
        if (!active) { stop(); return; }
        setReady(true);
        const track = stream.getVideoTracks()[0];
        void navigator.mediaDevices.enumerateDevices?.().then((devices) => {
          if (active) setCameras(devices.filter((device) => device.kind === 'videoinput' && device.deviceId));
        }).catch(() => { /* Camera selection is optional. */ });
        const modes = (track?.getCapabilities?.() as FocusCapabilities | undefined)?.focusMode;
        if (track && modes?.includes('continuous')) {
          void setCameraFocus(track, 'continuous').then((applied) => {
            if (!active) return;
            setCanControlFocus(applied || modes.includes('single-shot'));
            if (!applied && modes.includes('single-shot')) setFocusTrack(track);
          });
        } else if (track && modes?.includes('single-shot')) {
          setCanControlFocus(true);
          void setCameraFocus(track, 'single-shot').then(() => { if (active) setFocusTrack(track); });
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('unavailable');
        let scanCenter = true;
        function scan() {
          if (!active || !video.current) return;
          const current = video.current;
          if (current.readyState >= 2 && current.videoWidth && current.videoHeight) {
            const side = Math.round(Math.min(current.videoWidth, current.videoHeight) * 0.9);
            const width = scanCenter ? side : current.videoWidth;
            const height = scanCenter ? side : current.videoHeight;
            scanCenter = !scanCenter;
            // Keep every pixel at Full HD so the smaller modules of dense codes survive.
            const scale = Math.min(1, 1920 / Math.max(width, height), Math.sqrt(1920 * 1080 / (width * height)));
            canvas.width = Math.round(width * scale);
            canvas.height = Math.round(height * scale);
            try {
              context!.drawImage(current, Math.floor((current.videoWidth - width) / 2), Math.floor((current.videoHeight - height) / 2), width, height, 0, 0, canvas.width, canvas.height);
              const pixels = context!.getImageData(0, 0, canvas.width, canvas.height);
              let value = '';
              try { value = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data ?? ''; }
              finally { pixels.data.fill(0); context!.clearRect(0, 0, canvas.width, canvas.height); }
              if (value) { active = false; stop(); callback.current(value); return; }
            } catch { active = false; stop(); setError('อ่านภาพจากกล้องไม่ได้ กรุณาลองอีกครั้ง หรือเลือกรูป QR'); return; }
          }
          timer = setTimeout(scan, 180);
        }
        scan();
      } catch (cause) { stop(); if (active) setError(cameraError(cause)); }
    }
    void start();
    return () => { active = false; stop(); };
  }, [attempt, selectedCamera]);

  return <section className="camera-scanner" aria-label="สแกน QR ด้วยกล้อง">
    {cameras.length > 1 && <label className="camera-picker">กล้อง<select value={selectedCamera} onChange={(event) => setSelectedCamera(event.target.value)}>
      <option value="">กล้องอัตโนมัติ</option>
      {cameras.map((camera, index) => <option key={camera.deviceId} value={camera.deviceId}>{camera.label || `กล้อง ${index + 1}`}</option>)}
    </select></label>}
    {error ? <div className="camera-error"><CameraOff size={28} /><p role="alert">{error}</p><button type="button" className="secondary" onClick={() => setAttempt((value) => value + 1)}>ลองเปิดกล้องอีกครั้ง</button></div> : <>
      <div className="camera-frame"><video ref={video} autoPlay muted playsInline aria-label="ภาพจากกล้อง" /><div className="camera-guide" aria-hidden="true" /></div>
      <p className="field-help" role="status">{ready ? 'จัด QR ให้อยู่กลางกรอบ ถ้าภาพเบลอให้ถอยออกช้า ๆ จนภาพคม แล้วถือให้นิ่ง' : 'กำลังเปิดกล้อง…'}</p>
      {ready && !canControlFocus && <p className="field-help">แอปปรับโฟกัสกล้องนี้ไม่ได้ หากภาพยังเบลอ ให้เปิด QR ให้ใหญ่ขึ้นบนมือถือ หรือใช้ปุ่ม “เลือกรูป QR” นำเข้าจากภาพหน้าจอ</p>}
    </>}
    <div className="camera-actions">
      {!error && focusTrack && <button type="button" className="secondary" disabled={focusing} onClick={() => {
        setFocusing(true);
        void setCameraFocus(focusTrack, 'single-shot').finally(() => {
          if (focusTrack.readyState === 'live') setFocusing(false);
        });
      }}>โฟกัสใหม่</button>}
      <button type="button" className="secondary" onClick={() => { shutdown.current(); onClose(); }}>ปิดกล้อง</button>
    </div>
  </section>;
}
