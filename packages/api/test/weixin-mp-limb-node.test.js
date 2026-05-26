import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WeixinMpLimbNode } from '../dist/domains/limb/WeixinMpLimbNode.js';

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
