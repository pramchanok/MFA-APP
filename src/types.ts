export type AccountCode = {
  id: string;
  issuer: string;
  account: string;
  code: string;
  digits: number;
  period: number;
  remaining: number;
};

export type AccountInput = {
  issuer: string;
  account: string;
  secret: string;
  uri: string;
  algorithm: 'SHA1' | 'SHA256' | 'SHA512';
  digits: number;
  period: number;
};

export type VaultStatus = { exists: boolean; unlocked: boolean };
export type DeviceUnlockStatus = { available: boolean; enabled: boolean; label: string };
export type GoogleExportPreview = {
  entries: { index: number; issuer: string; account: string; algorithm: string; digits: number; reason: string | null }[];
  parts: number; expected: number; complete: boolean;
};
export type AppInfo = { version: string; updaterConfigured: boolean; mobile?: boolean };
export type SyncStatus = { configured: boolean; server: string | null; vaultId: string | null; pending: number; lastSync: number | null };
export type PairingInfo = { uri: string };
export type AccountQr = { image: string; customParameters: boolean };
export type SyncResult = { changed: boolean; status: SyncStatus };

export const emptyAccount: AccountInput = {
  issuer: '', account: '', secret: '', uri: '', algorithm: 'SHA1', digits: 6, period: 30,
};
