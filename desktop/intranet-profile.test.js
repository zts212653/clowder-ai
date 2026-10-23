const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { intranetApiEnvironment } = require('./intranet-profile');
const UpdateManager = require('./update-manager');

test('intranet defaults survive a fresh launch and use a dedicated, persistent audit directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-profile-'));
  const first = intranetApiEnvironment(root, {});
  assert.equal(first.CAT_CAFE_INTRANET_EDITION, '1');
  assert.equal(first.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY, '1');
  assert.equal(first.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE, 'trusted-host');
  assert.equal(first.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE, 'warn-bootstrap-root');
  assert.equal(first.AUDIT_LOG_DIR, path.join(root, 'data', 'audit-logs'));
  assert.deepEqual(intranetApiEnvironment(root, {}), first);
  assert.equal(fs.readdirSync(root).length, 0, 'runtime defaults must not rewrite deployment configuration');
});

test('intranet update channel never fetches or installs public releases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-updater-'));
  let networkCalls = 0;
  const dialogs = [];
  const manager = new UpdateManager({
    distributionChannel: 'intranet',
    userDataRoot: root,
    app: { getVersion: () => '1.14.0' },
    net: {
      request: () => {
        networkCalls++;
        throw new Error('public update must not run');
      },
    },
    dbg: () => {},
    showDialog: async (dialog) => {
      dialogs.push(dialog);
      return 0;
    },
    setInterval: () => {
      throw new Error('no public update interval');
    },
  });
  manager.startSchedule();
  await manager.checkForUpdates({ manual: true });
  assert.equal(networkCalls, 0);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /内网/);
});

test('saved explicit settings and existing audit paths win across restarts and upgrades', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intranet-override-'));
  const settings = {
    CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: 'strict',
    CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE: 'required',
    AUDIT_LOG_DIR: path.join(root, 'custom-audit'),
  };
  const file = path.join(root, 'intranet-host.json');
  const text = JSON.stringify(settings);
  fs.writeFileSync(file, text);
  assert.equal(intranetApiEnvironment(root, {}).CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE, 'strict');
  assert.equal(intranetApiEnvironment(root, {}).AUDIT_LOG_DIR, settings.AUDIT_LOG_DIR);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.equal(
    intranetApiEnvironment(root, { CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: 'trusted-host' })
      .CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE,
    'strict',
  );
});
