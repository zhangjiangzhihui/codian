import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { listWeChatOpenClawAccounts,loadWeChatOpenClawAccount } from '@/integrations/wechat/openClawAccount';

describe('openClawAccount', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codian-wechat-'));
    fs.mkdirSync(path.join(tempDir, 'openclaw-weixin', 'accounts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists OpenClaw WeChat accounts and ignores sync files', () => {
    const accountsDir = path.join(tempDir, 'openclaw-weixin', 'accounts');
    fs.writeFileSync(path.join(tempDir, 'openclaw.json'), JSON.stringify({
      channels: {
        'openclaw-weixin': {
          cdnBaseUrl: 'https://cdn.default.example.com/c2c',
          accounts: {
            'acc-one': {
              routeTag: 99,
            },
          },
        },
      },
    }));
    fs.writeFileSync(path.join(accountsDir, 'acc-one.json'), JSON.stringify({
      token: 'token-1',
      baseUrl: 'https://custom.example.com',
      userId: 'wxid_one@im.wechat',
      savedAt: '2026-04-20T10:00:00.000Z',
    }));
    fs.writeFileSync(path.join(accountsDir, 'acc-one.sync.json'), JSON.stringify({ get_updates_buf: 'cursor' }));
    fs.writeFileSync(path.join(accountsDir, 'acc-two.context-tokens.json'), JSON.stringify({ user: 'ctx' }));
    fs.writeFileSync(path.join(accountsDir, 'acc-three.json'), JSON.stringify({ baseUrl: 'https://missing-token.example.com' }));

    const accounts = listWeChatOpenClawAccounts(tempDir);

    expect(accounts).toEqual([{
      accountId: 'acc-one',
      token: 'token-1',
      baseUrl: 'https://custom.example.com',
      cdnBaseUrl: 'https://cdn.default.example.com/c2c',
      routeTag: '99',
      userId: 'wxid_one@im.wechat',
      savedAt: '2026-04-20T10:00:00.000Z',
      stateDir: tempDir,
      accountPath: path.join(accountsDir, 'acc-one.json'),
    }]);
  });

  it('requires an explicit account id when multiple OpenClaw WeChat accounts exist', () => {
    const accountsDir = path.join(tempDir, 'openclaw-weixin', 'accounts');
    fs.writeFileSync(path.join(accountsDir, 'acc-a.json'), JSON.stringify({ token: 'token-a' }));
    fs.writeFileSync(path.join(accountsDir, 'acc-b.json'), JSON.stringify({ token: 'token-b' }));

    expect(() => loadWeChatOpenClawAccount({ stateDir: tempDir })).toThrow(
      `Multiple OpenClaw WeChat accounts were found in ${tempDir}: acc-a, acc-b. Enter an account ID to choose one.`,
    );
    expect(loadWeChatOpenClawAccount({ stateDir: tempDir, accountId: 'acc-b' })).toMatchObject({
      accountId: 'acc-b',
      token: 'token-b',
    });
  });
});
