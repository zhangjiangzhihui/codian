import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

interface StoredWeChatOpenClawAccount {
  token?: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
}

interface StoredWeChatOpenClawAccountConfig {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  cdnBaseUrl?: string;
  routeTag?: number | string;
}

interface StoredWeChatOpenClawSectionConfig extends StoredWeChatOpenClawAccountConfig {
  accounts?: Record<string, StoredWeChatOpenClawAccountConfig>;
}

export interface ImportedWeChatOpenClawAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  cdnBaseUrl: string;
  routeTag?: string;
  userId?: string;
  savedAt?: string;
  stateDir: string;
  accountPath: string;
}

export function resolveDefaultOpenClawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(os.homedir(), '.openclaw');
}

function resolveAccountsDir(stateDir: string): string {
  return path.join(stateDir, 'openclaw-weixin', 'accounts');
}

function isAccountDataFile(fileName: string): boolean {
  return fileName.endsWith('.json')
    && !fileName.endsWith('.sync.json')
    && !fileName.endsWith('.context-tokens.json');
}

function readAccountFile(accountPath: string): StoredWeChatOpenClawAccount | null {
  try {
    const raw = fs.readFileSync(accountPath, 'utf8');
    return JSON.parse(raw) as StoredWeChatOpenClawAccount;
  } catch {
    return null;
  }
}

function resolveOpenClawConfigPath(stateDir: string): string {
  return path.join(stateDir, 'openclaw.json');
}

function readSectionConfig(stateDir: string): StoredWeChatOpenClawSectionConfig | null {
  const configPath = resolveOpenClawConfigPath(stateDir);
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as {
      channels?: Record<string, StoredWeChatOpenClawSectionConfig>;
    };
    return parsed.channels?.['openclaw-weixin'] ?? null;
  } catch {
    return null;
  }
}

function normalizeRouteTag(routeTag: number | string | undefined): string | undefined {
  if (typeof routeTag === 'number' && Number.isFinite(routeTag)) {
    return String(routeTag);
  }
  if (typeof routeTag === 'string' && routeTag.trim()) {
    return routeTag.trim();
  }
  return undefined;
}

function resolveChannelConfig(
  stateDir: string,
  accountId: string,
): { cdnBaseUrl: string; routeTag?: string } {
  const section = readSectionConfig(stateDir) ?? {};
  const accountConfig = section.accounts?.[accountId] ?? {};
  return {
    cdnBaseUrl: accountConfig.cdnBaseUrl?.trim() || section.cdnBaseUrl?.trim() || DEFAULT_WECHAT_CDN_BASE_URL,
    routeTag: normalizeRouteTag(accountConfig.routeTag ?? section.routeTag),
  };
}

export function listWeChatOpenClawAccounts(stateDir = resolveDefaultOpenClawStateDir()): ImportedWeChatOpenClawAccount[] {
  const accountsDir = resolveAccountsDir(stateDir);
  if (!fs.existsSync(accountsDir)) {
    return [];
  }

  const accounts: ImportedWeChatOpenClawAccount[] = [];
  for (const fileName of fs.readdirSync(accountsDir).filter(isAccountDataFile)) {
      const accountPath = path.join(accountsDir, fileName);
      const account = readAccountFile(accountPath);
      const token = account?.token?.trim();
      if (!token) {
        continue;
      }

      const channelConfig = resolveChannelConfig(stateDir, fileName.slice(0, -'.json'.length));

      accounts.push({
        accountId: fileName.slice(0, -'.json'.length),
        token,
        baseUrl: account?.baseUrl?.trim() || DEFAULT_WECHAT_BASE_URL,
        cdnBaseUrl: channelConfig.cdnBaseUrl,
        routeTag: channelConfig.routeTag,
        userId: account?.userId?.trim() || undefined,
        savedAt: account?.savedAt,
        stateDir,
        accountPath,
      });
  }

  return accounts.sort((left: ImportedWeChatOpenClawAccount, right: ImportedWeChatOpenClawAccount) => {
    if (left.savedAt && right.savedAt) {
      return right.savedAt.localeCompare(left.savedAt);
    }
    if (left.savedAt) return -1;
    if (right.savedAt) return 1;
    return left.accountId.localeCompare(right.accountId);
  });
}

export function loadWeChatOpenClawAccount(params?: {
  stateDir?: string;
  accountId?: string;
}): ImportedWeChatOpenClawAccount {
  const stateDir = params?.stateDir?.trim() || resolveDefaultOpenClawStateDir();
  const requestedAccountId = params?.accountId?.trim();
  const accounts = listWeChatOpenClawAccounts(stateDir);

  if (requestedAccountId) {
    const match = accounts.find((account) => account.accountId === requestedAccountId);
    if (match) {
      return match;
    }

    if (accounts.length === 0) {
      throw new Error(`No imported OpenClaw WeChat accounts were found in ${stateDir}.`);
    }

    throw new Error(`OpenClaw WeChat account "${requestedAccountId}" was not found. Available accounts: ${accounts.map((account) => account.accountId).join(', ')}.`);
  }

  if (accounts.length === 1) {
    return accounts[0];
  }

  if (accounts.length === 0) {
    throw new Error(`No imported OpenClaw WeChat accounts were found in ${stateDir}.`);
  }

  throw new Error(`Multiple OpenClaw WeChat accounts were found in ${stateDir}: ${accounts.map((account) => account.accountId).join(', ')}. Enter an account ID to choose one.`);
}
