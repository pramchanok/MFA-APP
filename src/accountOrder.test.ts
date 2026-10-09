import { expect, it } from 'vitest';
import { moveAccount } from './accountOrder';
import type { AccountCode } from './types';

const accounts = ['a', 'hidden', 'b', 'c'].map((id) => ({ id, issuer: id, account: 'test@example.invalid', code: '123456', digits: 6, period: 30, remaining: 20 } satisfies AccountCode));
it('moves only visible slots and retains every hidden account while searching', () => {
  expect(moveAccount(accounts, ['a', 'b', 'c'], 'c', 'a').map((account) => account.id)).toEqual(['c', 'hidden', 'a', 'b']);
  expect(moveAccount(accounts, ['a', 'b', 'c'], 'a', 'c').map((account) => account.id)).toEqual(['b', 'hidden', 'c', 'a']);
  expect(moveAccount(accounts, ['a', 'b'], 'c', 'a')).toBe(accounts);
});
