import type { AccountCode } from './types';

// Replace only visible slots so a filtered reorder does not shuffle hidden accounts.
export function moveAccount(accounts: AccountCode[], visibleIds: string[], id: string, targetId: string): AccountCode[] {
  const from = visibleIds.indexOf(id), to = visibleIds.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return accounts;
  const ids = [...visibleIds];
  ids.splice(to, 0, ...ids.splice(from, 1));
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const visible = new Set(visibleIds);
  let index = 0;
  return accounts.map((account) => visible.has(account.id) ? byId.get(ids[index++])! : account);
}
