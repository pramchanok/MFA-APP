import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const schema = await readFile(new URL('./migrations/0001_relay.sql', import.meta.url), 'utf8');
// Keep trigger bodies intact: D1 exec() splits on newlines.
export function statements(sql) {
  const result = []; let pending = '';
  for (const line of sql.replace(/^--.*$/gm, '').split('\n')) {
    pending += line + '\n';
    if (pending.trim().startsWith('CREATE TRIGGER') ? line.trim() === 'END;' : line.trim().endsWith(';')) {
      result.push(pending.trim()); pending = '';
    }
  }
  assert.equal(pending.trim(), '');
  return result;
}
