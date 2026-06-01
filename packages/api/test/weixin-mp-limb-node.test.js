import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { WeixinMpLimbNode } from '../dist/domains/limb/WeixinMpLimbNode.js';

const WEIXIN_MP_LIMB_PATH = fileURLToPath(new URL('../../../plugins/weixin-mp/limbs/weixin-mp.yml', import.meta.url));

function createNodeWithDraftClient() {
  const node = new WeixinMpLimbNode({
    capabilities: [],
    pluginConfig: {
      WEIXIN_MP_APP_ID: 'app-id',
      WEIXIN_MP_APP_SECRET: 'app-secret',
    },
  });
  const calls = { publishDraft: 0 };
  node.client.createDraft = async () => 'draft-media-id';
  node.client.publishDraft = async () => {
    calls.publishDraft += 1;
    return 'publish-id';
  };
  return { node, calls };
}

describe('WeixinMpLimbNode', () => {
  it('declares publish commands with an invokable auth level', async () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const registry = new LimbRegistry();
    registry.setDeps({
      accessPolicy: new LimbAccessPolicy(),
      leaseManager: new LimbLeaseManager(),
      actionLog: new LimbActionLog(),
    });
    const calls = [];
    await registry.register({
      nodeId: decl.nodeId,
      displayName: decl.displayName,
      platform: decl.platform,
      capabilities: decl.capabilities,
      invoke: async (command) => {
        calls.push(command);
        return { success: true };
      },
    });

    const publish = await registry.invoke(decl.nodeId, 'weixin_mp.publish_article', {}, { catId: 'codex' });
    const upload = await registry.invoke(decl.nodeId, 'weixin_mp.upload_image', {}, { catId: 'codex' });

    assert.equal(publish.success, true);
    assert.equal(upload.success, true);
    assert.deepEqual(calls, ['weixin_mp.publish_article', 'weixin_mp.upload_image']);
    const publishCap = decl.capabilities.find((cap) => cap.cap === 'content_publish');
    assert.equal(publishCap?.authLevel, 'leased');
  });

  it('does not publish when publish is the string "false"', async () => {
    const { node, calls } = createNodeWithDraftClient();

    const result = await node.invoke('weixin_mp.publish_article', {
      title: 'Draft title',
      markdown: '# Draft',
      thumbMediaId: 'thumb-media-id',
      publish: 'false',
    });

    assert.equal(result.success, true);
    assert.equal(calls.publishDraft, 0);
    assert.deepEqual(result.data, { draftMediaId: 'draft-media-id' });
  });

  it('publishes only when publish is the boolean true', async () => {
    const { node, calls } = createNodeWithDraftClient();

    const result = await node.invoke('weixin_mp.publish_article', {
      title: 'Live title',
      markdown: '# Live',
      thumbMediaId: 'thumb-media-id',
      publish: true,
    });

    assert.equal(result.success, true);
    assert.equal(calls.publishDraft, 1);
    assert.deepEqual(result.data, { draftMediaId: 'draft-media-id', publishId: 'publish-id' });
  });
});
