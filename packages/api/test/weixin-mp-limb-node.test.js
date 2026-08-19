import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
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

    // submit_publish still has required params (mediaId)
    const result = await adapter.invoke('weixin_mp.submit_publish', {});
    assert.equal(result.success, false);
    assert.match(result.error, /Missing required params.*mediaId/);
  });

  it('routes invoke commands to registered handlers', async () => {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const handlers = {
      'weixin-mp:convert_markdown': async (params) => ({
        success: true,
        data: { filePath: `/tmp/mock-${params.markdown}.html` },
      }),
    };
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });

    const result = await adapter.invoke('weixin_mp.convert_markdown', { markdown: 'hello' });
    assert.equal(result.success, true);
    assert.equal(result.data.filePath, '/tmp/mock-hello.html');
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
    assert.equal(decl.commands['weixin_mp.create_draft']?.type, 'invoke');
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

    const result = await adapter.invoke('weixin_mp.upload_image', { fileLocation: 'https://example.com/image.png' });

    assert.equal(result.success, true, result.error);
    assert.deepEqual(result.data, { url: 'https://mmbiz.qpic.cn/fresh.png' });
    assert.equal(invalidateCalls, 1);
    assert.equal(tokenCalls, 2);
    assert.match(uploadUrls[0], /access_token=stale-token/);
    assert.match(uploadUrls[1], /access_token=fresh-token/);
  });
});

// ─── Upload with fileLocation param ─────────────────────────

describe('upload_image / upload_material with fileLocation param', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function makeUploadAdapter(uploadResults) {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const uploadUrls = [];
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => {
        throw new Error('should not fetch URL when local path is provided');
      },
      uploadFormData: async (url) => {
        uploadUrls.push(url);
        return uploadResults;
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };
    return { adapter, uploadUrls };
  }

  it('uploads image from local file path via fileLocation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const imgPath = join(tmpDir, 'test.png');
    await writeFile(imgPath, Buffer.from('fake-png-bytes'));

    const { adapter } = makeUploadAdapter({ errcode: 0, url: 'https://mmbiz.qpic.cn/local.png' });
    const result = await adapter.invoke('weixin_mp.upload_image', { fileLocation: imgPath });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.url, 'https://mmbiz.qpic.cn/local.png');
  });

  it('uploads material from local file path via fileLocation', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const imgPath = join(tmpDir, 'cover.jpg');
    await writeFile(imgPath, Buffer.from('fake-jpg-bytes'));

    const { adapter } = makeUploadAdapter({ errcode: 0, media_id: 'mid_123', url: 'https://mmbiz.qpic.cn/cover.jpg' });
    const result = await adapter.invoke('weixin_mp.upload_material', { fileLocation: imgPath });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'mid_123');
  });

  it('returns error when fileLocation not provided', async () => {
    const { adapter } = makeUploadAdapter({});
    const result = await adapter.invoke('weixin_mp.upload_image', {});

    assert.equal(result.success, false);
    assert.match(result.error, /fileLocation/);
  });

  it('returns error for unsupported file extension', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
    const badPath = join(tmpDir, 'doc.pdf');
    await writeFile(badPath, Buffer.from('fake-pdf'));

    const { adapter } = makeUploadAdapter({});
    const result = await adapter.invoke('weixin_mp.upload_image', { fileLocation: badPath });
    assert.equal(result.success, false);
    assert.match(result.error, /Unsupported image extension.*\.pdf/);
  });

  it('YAML declares fileLocation param for upload commands', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const imgParams = decl.commands['weixin_mp.upload_image']?.params;
    const matParams = decl.commands['weixin_mp.upload_material']?.params;

    assert.ok(imgParams.fileLocation, 'upload_image should have fileLocation param');
    assert.ok(matParams.fileLocation, 'upload_material should have fileLocation param');
    assert.equal(imgParams.fileLocation.required, true, 'fileLocation should be required');
  });
});

// ─── Content file path tests ────────────────────────────────

describe('convert_markdown / create_draft with file path params', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function makeContentAdapter(jsonPostResults) {
    const declaration = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const postBodies = [];
    const handlers = createWeixinMpHandlers({
      fetchExternalUrlPinned: async () => {
        throw new Error('unused');
      },
      uploadFormData: async () => {
        throw new Error('unused');
      },
      jsonPost: async (_url, body) => {
        postBodies.push(body);
        return jsonPostResults;
      },
    });
    const adapter = new PluginLimbAdapter({
      declaration,
      pluginConfig: { WEIXIN_MP_APP_ID: 'id', WEIXIN_MP_APP_SECRET: 'secret' },
      handlers,
    });
    adapter.tokenManager = {
      getAccessToken: async () => 'test-token',
      invalidateAccessToken: async () => {},
      isTokenExpiredError: () => false,
    };
    return { adapter, postBodies };
  }

  it('converts markdown from a local file and writes HTML to output file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-md-'));
    const mdPath = join(tmpDir, 'article.md');
    await writeFile(mdPath, '# Hello\n\nWorld', 'utf-8');

    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.convert_markdown', { markdownFilePath: mdPath });

    assert.equal(result.success, true, result.error);
    assert.ok(result.data.filePath, 'Should return filePath');
    assert.match(result.data.filePath, /wx-converted-\d+\.html$/, 'Output should use tmpdir naming pattern');
    const htmlContent = await readFile(result.data.filePath, 'utf-8');
    assert.ok(htmlContent.includes('Hello'), 'HTML file should contain heading text');
  });

  it('uses distinct output files when conversions share the same millisecond', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-md-race-'));
    const firstMdPath = join(tmpDir, 'first.md');
    const secondMdPath = join(tmpDir, 'second.md');
    await Promise.all([
      writeFile(firstMdPath, '# First\n\nOne', 'utf-8'),
      writeFile(secondMdPath, '# Second\n\nTwo', 'utf-8'),
    ]);

    const { adapter } = makeContentAdapter({});
    const realNow = Date.now;
    Date.now = () => 1_789_000_000_000;
    try {
      const [first, second] = await Promise.all([
        adapter.invoke('weixin_mp.convert_markdown', { markdownFilePath: firstMdPath }),
        adapter.invoke('weixin_mp.convert_markdown', { markdownFilePath: secondMdPath }),
      ]);

      assert.equal(first.success, true, first.error);
      assert.equal(second.success, true, second.error);
      assert.notEqual(first.data.filePath, second.data.filePath, 'same-ms conversions must not collide');
      const [firstHtml, secondHtml] = await Promise.all([
        readFile(first.data.filePath, 'utf-8'),
        readFile(second.data.filePath, 'utf-8'),
      ]);
      assert.ok(firstHtml.includes('First'), 'first output should keep first heading');
      assert.ok(secondHtml.includes('Second'), 'second output should keep second heading');
    } finally {
      Date.now = realNow;
    }
  });

  it('returns error when neither markdown nor markdownFilePath provided', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.convert_markdown', {});

    assert.equal(result.success, false);
    assert.match(result.error, /markdown or markdownFilePath is required/);
  });

  it('creates draft with inline content', async () => {
    const { adapter, postBodies } = makeContentAdapter({ errcode: 0, media_id: 'draft_001' });
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'Test Article',
      content: '<p>Hello</p>',
      thumbMediaId: 'thumb_001',
      author: 'Cat',
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'draft_001');
    assert.equal(postBodies[0].articles[0].title, 'Test Article');
    assert.equal(postBodies[0].articles[0].content, '<p>Hello</p>');
    assert.equal(postBodies[0].articles[0].author, 'Cat');
  });

  it('creates draft from a local HTML file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-draft-'));
    const htmlPath = join(tmpDir, 'article.html');
    await writeFile(htmlPath, '<section>Long article content here</section>', 'utf-8');

    const { adapter, postBodies } = makeContentAdapter({ errcode: 0, media_id: 'draft_002' });
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'File Article',
      contentFilePath: htmlPath,
      thumbMediaId: 'thumb_002',
    });

    assert.equal(result.success, true, result.error);
    assert.equal(result.data.mediaId, 'draft_002');
    assert.ok(postBodies[0].articles[0].content.includes('Long article content'));
  });

  it('returns error when neither content nor contentFilePath provided', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.create_draft', {
      title: 'No Content',
      thumbMediaId: 'thumb_003',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /content or contentFilePath is required/);
  });

  it('returns error when required draft params missing', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.create_draft', {
      content: '<p>test</p>',
    });

    assert.equal(result.success, false);
    assert.match(result.error, /title.*thumbMediaId/);
  });

  it('updates draft with inline content', async () => {
    const { adapter, postBodies } = makeContentAdapter({ errcode: 0 });
    const result = await adapter.invoke('weixin_mp.update_draft', {
      mediaId: 'mid_001',
      title: 'Updated Title',
      content: '<p>New content</p>',
    });
    assert.equal(result.success, true, result.error);
    assert.equal(postBodies[0].media_id, 'mid_001');
    assert.equal(postBodies[0].index, 0);
    assert.equal(postBodies[0].articles.title, 'Updated Title');
    assert.equal(postBodies[0].articles.content, '<p>New content</p>');
  });

  it('updates draft from a local HTML file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-update-'));
    const htmlPath = join(tmpDir, 'updated.html');
    await writeFile(htmlPath, '<section>Updated article</section>', 'utf-8');
    const { adapter, postBodies } = makeContentAdapter({ errcode: 0 });
    const result = await adapter.invoke('weixin_mp.update_draft', {
      mediaId: 'mid_002',
      contentFilePath: htmlPath,
    });
    assert.equal(result.success, true, result.error);
    assert.ok(postBodies[0].articles.content.includes('Updated article'));
  });

  it('returns error when no update fields provided', async () => {
    const { adapter } = makeContentAdapter({});
    const result = await adapter.invoke('weixin_mp.update_draft', { mediaId: 'mid_003' });
    assert.equal(result.success, false);
    assert.match(result.error, /At least one field/);
  });

  it('YAML declares all P0/P1/P2 commands', () => {
    const decl = loadLimbDeclaration(WEIXIN_MP_LIMB_PATH);
    const cmds = Object.keys(decl.commands);
    // P0
    assert.ok(cmds.includes('weixin_mp.update_draft'), 'should have update_draft');
    assert.ok(cmds.includes('weixin_mp.delete_draft'), 'should have delete_draft');
    // P1
    assert.ok(cmds.includes('weixin_mp.delete_material'), 'should have delete_material');
    assert.ok(cmds.includes('weixin_mp.list_material'), 'should have list_material');
    assert.ok(cmds.includes('weixin_mp.get_material_count'), 'should have get_material_count');
    // P2
    assert.ok(cmds.includes('weixin_mp.list_articles'), 'should have list_articles');
    assert.ok(cmds.includes('weixin_mp.delete_article'), 'should have delete_article');
    // GET method for material count
    assert.equal(decl.commands['weixin_mp.get_material_count']?.method, 'GET');
  });
});
