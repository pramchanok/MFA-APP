import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';

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

  useEffect(() => {
    let active = true;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas');
    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video.current) video.current.srcObject = null;
      canvas.width = 0; canvas.height = 0;
    };
    shutdown.current = () => { active = false; stop(); };
    setError(''); setReady(false);
    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unavailable');
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (!active) { acquired.getTracks().forEach((track) => track.stop()); return; }
        stream = acquired;
        const element = video.current;
        if (!element) { stop(); return; }
        element.srcObject = stream;
        await element.play();
        if (!active) { stop(); return; }
        setReady(true);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('unavailable');
        function scan() {
          if (!active || !video.current) return;
          const current = video.current;
          if (current.readyState >= 2 && current.videoWidth && current.videoHeight) {
            const scale = Math.min(1, 1280 / Math.max(current.videoWidth, current.videoHeight));
            canvas.width = Math.round(current.videoWidth * scale);
            canvas.height = Math.round(current.videoHeight * scale);
            try {
              context!.drawImage(current, 0, 0, canvas.width, canvas.height);
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
  }, [attempt]);

  return <section className="camera-scanner" aria-label="สแกน QR ด้วยกล้อง">
    {error ? <div className="camera-error"><CameraOff size={28} /><p role="alert">{error}</p><button type="button" className="secondary" onClick={() => setAttempt((value) => value + 1)}>ลองเปิดกล้องอีกครั้ง</button></div> : <>
      <div className="camera-frame"><video ref={video} autoPlay muted playsInline aria-label="ภาพจากกล้อง" /><div className="camera-guide" aria-hidden="true" /></div>
      <p className="field-help" role="status">{ready ? 'ส่อง QR ให้เต็มกรอบ กล้องจะปิดเมื่ออ่านสำเร็จ' : 'กำลังเปิดกล้อง…'}</p>
    </>}
    <button type="button" className="secondary" onClick={() => { shutdown.current(); onClose(); }}>ปิดกล้อง</button>
  </section>;
}
