import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { PluginLimbAdapter } from '../dist/domains/limb/PluginLimbAdapter.js';
import { createWeixinMpHandlers } from '../dist/plugins/weixin-mp/index.js';

const WEIXIN_MP_LIMB_PATH = fileURLToPath(new URL('../src/plugins/weixin-mp/limbs/weixin-mp.yml', import.meta.url));

describe('PluginLimbAdapter (weixin-mp)', () => {
  it('declares publish commands with an invokable auth level', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const registry = new LimbRegistry();
    registry.setDeps({
      accessPolicy: new LimbAccessPolicy(),
      leaseManager: new LimbLeaseManager(),
      actionLog: new LimbActionLog(),
    });
    const calls = [];
    await registry.register({
      nodeId: declaration.nodeId,
      displayName: declaration.displayName,
      platform: declaration.platform,
      capabilities: declaration.capabilities,
      invoke: async (command) => {
        calls.push(command);
        return { success: true };
      },
    });

    const draft = await registry.invoke(declaration.nodeId, 'weixin_mp.create_draft', {}, { catId: 'codex' });
    const upload = await registry.invoke(declaration.nodeId, 'weixin_mp.upload_image', {}, { catId: 'codex' });

    assert.equal(draft.success, true);
    assert.equal(upload.success, true);
    assert.deepEqual(calls, ['weixin_mp.create_draft', 'weixin_mp.upload_image']);
    const publishCap = declaration.capabilities.find((cap) => cap.cap === 'content_publish');
    assert.equal(publishCap?.authLevel, 'leased');
  });

  it('returns error for unknown commands', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
    });

    const result = await adapter.invoke('weixin_mp.nonexistent', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Unknown command/);
  });

  it('validates required params before execution', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
    });

    const result = await adapter.invoke('weixin_mp.convert_markdown', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Missing required params.*markdown/);
  });

  it('routes invoke commands to registered handlers', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const handlers = {
      'weixin-mp:convert_markdown': async (params) => ({
        success: true,
        data: { html: `<p>${params.markdown}</p>` },
      }),
    };
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });

    const result = await adapter.invoke('weixin_mp.convert_markdown', { markdown: 'hello' });
    assert.equal(result.success, true);
    assert.equal(result.data.html, '<p>hello</p>');
  });

  it('loads YAML with auth, error, and command type fields', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);

    assert.ok(decl.auth);
    assert.equal(decl.auth.type, 'client_credentials');
    assert.equal(decl.auth.tokenPlacement, 'query');
    assert.deepEqual(decl.auth.tokenExpiredCodes, [40001, 40014, 42001]);

    assert.ok(decl.error);
    assert.equal(decl.error.codePath, 'errcode');

    assert.equal(decl.commands['weixin_mp.check_status']?.type, 'invoke');
    assert.equal(decl.commands['weixin_mp.list_drafts']?.type, 'rest');
    assert.equal(decl.commands['weixin_mp.list_drafts']?.endpoint, '/draft/batchget');
  });

  it('refreshes upload tokens after WeChat token-expired errors', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const uploadUrls = [];
    let tokenCalls = 0;
    let invalidateCalls = 0;
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => ({
        contentType: 'image/png',
        body: Buffer.from('png'),
      }),
      uploadFormData: async (url) => {
        uploadUrls.push(url);
        if (uploadUrls.length === 1) {
          return { errcode: 40001, errmsg: 'invalid credential' };
        }
        return { errcode: 0, url: 'https://mmbiz.qpic.cn/fresh.png' };
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => {
        tokenCalls += 1;
        return tokenCalls === 1 ? 'stale-token' : 'fresh-token';
      },
      invalidateAccessToken: async () => {
        invalidateCalls += 1;
      },
      isTokenExpiredError: (code) => code === 40001,
    };

    const result = await adapter.invoke('weixin_mp.upload_image', { imageUrl: 'https://example.com/image.png' });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.data, { url: 'https://mmbiz.qpic.cn/fresh.png' });
    assert.equal(invalidateCalls, 1);
    assert.equal(tokenCalls, 2);
    assert.match(uploadUrls[0], /access_token=stale-token/);
    assert.match(uploadUrls[1], /access_token=fresh-token/);
  });
});
