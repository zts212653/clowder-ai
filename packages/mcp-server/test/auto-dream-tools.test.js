import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('F255 auto-dream MCP tools', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-present-loop';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'callback-token';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('registers settle/read/list/settings-preview with owner identity absent from every public schema', async () => {
    const { autoDreamTools } = await import('../dist/tools/auto-dream-tools.js');
    const names = autoDreamTools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'cat_cafe_settle_present_loop',
      'cat_cafe_read_diary',
      'cat_cafe_list_diaries',
      'cat_cafe_preview_cat_life_settings',
    ]);

    for (const tool of autoDreamTools) {
      const keys = Object.keys(tool.inputSchema);
      for (const forbidden of ['ownerUserId', 'userId', 'threadId', 'invocationId', 'callbackToken']) {
        assert.equal(keys.includes(forbidden), false, `${tool.name} must not accept ${forbidden}`);
      }
      assert.match(tool.description, /Use when:/);
      assert.match(tool.description, /NOT for:/);
      assert.match(tool.description, /Output:/);
      assert.match(tool.description, /GOTCHA:/);
    }
    const settle = autoDreamTools.find((tool) => tool.name === 'cat_cafe_settle_present_loop');
    assert.ok(settle.inputSchema.seedDecision);
    assert.ok(settle.inputSchema.intent);
  });

  test('settle forwards only the product payload under invocation callback auth', async () => {
    let capturedUrl;
    let capturedOptions;
    globalThis.fetch = async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(JSON.stringify({ run: { state: 'settled' }, diary: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { handleSettlePresentLoop } = await import('../dist/tools/auto-dream-tools.js');
    const input = {
      runId: 'dreamrun_abc',
      outcome: 'quiet',
      sleepPosture: {},
      seedDecision: { kind: 'originate', claim: '我想拥有一张桌边小垫子' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'want',
        firstAction: { kind: 'sketch', summary: '先画一张可逆草图' },
        message: { body: '我想要一张桌边小垫子。' },
      },
    };
    const result = await handleSettlePresentLoop(input);
    assert.equal(result.isError, undefined);
    assert.match(capturedUrl, /\/api\/callbacks\/auto-dream\/settle$/);
    assert.equal(capturedOptions.headers['x-invocation-id'], 'inv-present-loop');
    assert.equal(capturedOptions.headers['x-callback-token'], 'callback-token');
    assert.deepEqual(JSON.parse(capturedOptions.body), input);
  });

  test('read/list use owner-scoped callback GET routes and encode filters', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ diaries: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { handleListDiaries, handleReadDiary } = await import('../dist/tools/auto-dream-tools.js');
    await handleReadDiary({ diaryId: 'dream_one' });
    await handleListDiaries({ catId: 'codex-sol', includeArchived: true, limit: 12 });

    assert.match(urls[0], /\/api\/callbacks\/auto-dream\/diaries\/dream_one$/);
    assert.match(urls[1], /\/api\/callbacks\/auto-dream\/diaries\?/);
    assert.match(urls[1], /catId=codex-sol/);
    assert.match(urls[1], /includeArchived=true/);
    assert.match(urls[1], /limit=12/);
    assert.doesNotMatch(urls.join('\n'), /ownerUserId|userId=/);
  });

  test('settings preview attaches a fixed-endpoint confirmation block without writing configuration', async () => {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).endsWith('/api/callbacks/auto-dream/life-settings/preview')) {
        return new Response(
          JSON.stringify({
            previewId: 'lifepreview_one',
            catId: 'codex-sol',
            settings: {
              enabled: true,
              rhythm: { kind: 'gentle' },
              wakeTime: '22:30',
              timezone: 'America/Los_Angeles',
            },
            nextWakeAt: 1_800_000_000_000,
            weeklyWakeCount: 3,
            costBand: 'low',
            costNotice: '每周约 3 次唤醒；每次都可能调用模型，请按猫粮预算调整。',
            expiresAt: 1_800_000_900_000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { handlePreviewCatLifeSettings } = await import('../dist/tools/auto-dream-tools.js');
    const input = {
      catId: 'codex-sol',
      settings: {
        enabled: true,
        rhythm: { kind: 'gentle' },
        wakeTime: '22:30',
        timezone: 'America/Los_Angeles',
      },
    };
    const result = await handlePreviewCatLifeSettings(input);

    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/api\/callbacks\/auto-dream\/life-settings\/preview$/);
    assert.deepEqual(calls[0].body, input);
    assert.match(calls[1].url, /\/api\/callbacks\/create-rich-block$/);
    assert.equal(calls[1].body.block.interactiveType, 'confirm');
    assert.deepEqual(
      calls[1].body.block.options.map((option) => option.action.endpoint),
      ['/api/auto-dream/life-settings/decision', '/api/auto-dream/life-settings/decision'],
    );
    assert.deepEqual(calls[1].body.block.options[0].action.payload, {
      previewId: 'lifepreview_one',
      decision: 'confirm',
    });
    assert.deepEqual(calls[1].body.block.options[1].action.payload, {
      previewId: 'lifepreview_one',
      decision: 'cancel',
    });
    assert.doesNotMatch(JSON.stringify(calls), /ownerUserId|userId|projectionTaskId|cronExpression/);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      previewId: 'lifepreview_one',
      catId: 'codex-sol',
      confirmationBlockAttached: true,
    });
  });

  test('settings preview does not claim attachment when the rich-block callback is stale', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/callbacks/auto-dream/life-settings/preview')) {
        return new Response(
          JSON.stringify({
            previewId: 'lifepreview_stale',
            catId: 'codex-sol',
            settings: {
              enabled: true,
              rhythm: { kind: 'gentle' },
              wakeTime: '22:30',
              timezone: 'America/Los_Angeles',
            },
            nextWakeAt: 1_800_000_000_000,
            weeklyWakeCount: 3,
            costBand: 'low',
            costNotice: '每周约 3 次唤醒；每次都可能调用模型，请按猫粮预算调整。',
            expiresAt: 1_800_000_900_000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'stale_ignored' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { handlePreviewCatLifeSettings } = await import('../dist/tools/auto-dream-tools.js');
    const result = await handlePreviewCatLifeSettings({
      catId: 'codex-sol',
      settings: {
        enabled: true,
        rhythm: { kind: 'gentle' },
        wakeTime: '22:30',
        timezone: 'America/Los_Angeles',
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /stale_ignored/);
    assert.doesNotMatch(result.content[0].text, /"confirmationBlockAttached":true/);
  });

  test('settings preview accepts a paused zero-wake preview', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/api/callbacks/auto-dream/life-settings/preview')) {
        return new Response(
          JSON.stringify({
            previewId: 'lifepreview_paused',
            catId: 'codex-sol',
            settings: {
              enabled: false,
              rhythm: { kind: 'gentle' },
              wakeTime: '22:30',
              timezone: 'America/Los_Angeles',
            },
            nextWakeAt: null,
            weeklyWakeCount: 0,
            costBand: 'low',
            costNotice: '当前已暂停，不会产生模型唤醒；恢复后按所选节奏运行。',
            expiresAt: 1_800_000_900_000,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { handlePreviewCatLifeSettings } = await import('../dist/tools/auto-dream-tools.js');
    const result = await handlePreviewCatLifeSettings({
      catId: 'codex-sol',
      settings: {
        enabled: false,
        rhythm: { kind: 'gentle' },
        wakeTime: '22:30',
        timezone: 'America/Los_Angeles',
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(result.content[0].text).confirmationBlockAttached, true);
  });
});
