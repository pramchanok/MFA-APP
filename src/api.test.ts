import { expect, it } from 'vitest';
import { safeError } from './api';

it('explains a rejected biometric ticket separately from a cancelled prompt', () => {
  expect(safeError('Windows Hello could not validate the biometric ticket (0x80098044). Try again or choose the Windows PIN.')).toContain('0x80098044');
  expect(safeError('Windows Hello could not validate the biometric ticket (0x80098044). Try again or choose the Windows PIN.')).toContain('เลือก PIN');
  expect(safeError('Device unlock was cancelled. Use your master password.')).toContain('ยกเลิกการยืนยัน');
});
it('keeps native error stage and code without including sensitive values', () => {
  expect(safeError('Windows Hello failed during finalize Hello key (0x80090029). Use your master password.')).toContain('ยืนยันการสร้างกุญแจ');
  expect(safeError('Windows Hello failed during finalize Hello key (0x80090029). Use your master password.')).toContain('0x80090029');
  expect(safeError('Windows Hello failed during Hello decrypt (0x80090029). Use your master password.')).toContain('0x80090029');
});
