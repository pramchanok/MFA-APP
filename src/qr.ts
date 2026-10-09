import jsQR from 'jsqr';

// Decode entirely on this device; never upload the QR or log its contents.
export async function readQr(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new Error('เลือกรูปขนาดไม่เกิน 8 MB');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('รองรับรูป PNG, JPG และ WebP');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error('รูปใหญ่เกินไป กรุณาครอปเฉพาะ QR Code ก่อน');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('ไม่สามารถอ่านรูปนี้ได้');
    try {
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      try {
        const result = jsQR(pixels.data, pixels.width, pixels.height);
        if (!result) throw new Error('ไม่พบ QR Code กรุณาครอปรูปให้เห็น QR ชัดเจน');
        return result.data;
      } finally { pixels.data.fill(0); }
    } finally { context.clearRect(0, 0, canvas.width, canvas.height); }
  } finally { bitmap.close(); }
}
