import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { MemoryConnectorPermissionStore } from '../dist/infrastructure/connectors/ConnectorPermissionStore.js';

describe('ConnectorPermissionStore — multi-connector isolation (Bug-9)', () => {
  let store;

  beforeEach(() => {
    store = new MemoryConnectorPermissionStore();
  });

  it('getConfig returns empty defaults for any connectorId', async () => {
    const feishu = await store.getConfig('feishu');
    const wecom = await store.getConfig('wecom-bot');
    const ding = await store.getConfig('dingtalk');

    for (const cfg of [feishu, wecom, ding]) {
      assert.equal(cfg.whitelistEnabled, false);
      assert.equal(cfg.commandAdminOnly, false);
      assert.deepEqual(cfg.adminOpenIds, []);
      assert.deepEqual(cfg.allowedGroups, []);
    }
  });

  it('feishu config does NOT leak to wecom-bot (Bug-9)', async () => {
    // Set up feishu permissions
    await store.setWhitelistEnabled('feishu', true);
    await store.setCommandAdminOnly('feishu', true);
    await store.setAdminOpenIds('feishu', ['ou_feishu_admin']);
    await store.allowGroup('feishu', 'oc_feishu_group1', '飞书测试群');

    // wecom-bot should be completely untouched
    const wecom = await store.getConfig('wecom-bot');
    assert.equal(wecom.whitelistEnabled, false);
    assert.equal(wecom.commandAdminOnly, false);
    assert.deepEqual(wecom.adminOpenIds, []);
    assert.deepEqual(wecom.allowedGroups, []);
  });

  it('wecom-bot and dingtalk maintain independent configs (Bug-9)', async () => {
    // Set up wecom-bot
    await store.setWhitelistEnabled('wecom-bot', true);
    await store.setAdminOpenIds('wecom-bot', ['wecom_user_001']);
    await store.allowGroup('wecom-bot', 'ww_group_abc', '企微测试群');

    // Set up dingtalk differently
    await store.setCommandAdminOnly('dingtalk', true);
    await store.setAdminOpenIds('dingtalk', ['ding_admin_xyz']);

    // Verify isolation
    const wecom = await store.getConfig('wecom-bot');
    assert.equal(wecom.whitelistEnabled, true);
    assert.equal(wecom.commandAdminOnly, false);
    assert.deepEqual([...wecom.adminOpenIds], ['wecom_user_001']);
    assert.equal(wecom.allowedGroups.length, 1);
    assert.equal(wecom.allowedGroups[0].externalChatId, 'ww_group_abc');

    const ding = await store.getConfig('dingtalk');
    assert.equal(ding.whitelistEnabled, false);
    assert.equal(ding.commandAdminOnly, true);
    assert.deepEqual([...ding.adminOpenIds], ['ding_admin_xyz']);
    assert.deepEqual(ding.allowedGroups, []);
  });

  it('isAdmin checks are scoped to connectorId (Bug-9)', async () => {
    await store.setAdminOpenIds('feishu', ['shared_user_id']);

    assert.equal(await store.isAdmin('feishu', 'shared_user_id'), true);
    assert.equal(await store.isAdmin('wecom-bot', 'shared_user_id'), false);
    assert.equal(await store.isAdmin('dingtalk', 'shared_user_id'), false);
  });

  it('isGroupAllowed checks are scoped to connectorId (Bug-9)', async () => {
    await store.setWhitelistEnabled('feishu', true);
    await store.setWhitelistEnabled('wecom-bot', true);
    await store.allowGroup('feishu', 'group_123');

    assert.equal(await store.isGroupAllowed('feishu', 'group_123'), true);
    assert.equal(await store.isGroupAllowed('wecom-bot', 'group_123'), false);
    // dingtalk whitelist not enabled, so all groups allowed
    assert.equal(await store.isGroupAllowed('dingtalk', 'group_123'), true);
  });
});
