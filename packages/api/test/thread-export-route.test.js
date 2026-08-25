/**
 * Thread Export Image Route Tests
 * 验证导出长图路由生成的前端 URL
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';

await import('tsx/esm');
const { threadExportRoutes, resolveFrontendBaseUrl } = await import('../src/routes/thread-export.ts');
const { resolveFrontendCorsOrigins } = await import('../src/config/frontend-origin.ts');
const { ImageExporter, buildImageExportUrl, resolveExportCaptureHeight, stitchImageExportChunks } = await import(
  '../src/services/ImageExporter.ts'
);
const { captureVerifiedImageExportCandidate, resolveHtmlWidgetExportReadiness } = await import(
  '../src/services/html-widget-export-readiness.ts'
);

const ORIGINAL_CAPTURE = ImageExporter.prototype.capture;
const ORIGINAL_CLOSE = ImageExporter.prototype.close;
const ORIGINAL_FRONTEND_URL = process.env.FRONTEND_URL;
const ORIGINAL_FRONTEND_PORT = process.env.FRONTEND_PORT;

function createThreadStore() {
  return {
    async get(threadId) {
      if (threadId !== 'thread-1') return null;
      return {
        id: 'thread-1',
        projectPath: '/tmp',
        title: '测试线程',
        createdBy: 'user-1',
        participants: [],
        lastActiveAt: Date.now(),
        createdAt: Date.now(),
      };
    },
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: 'hello',
    mentions: [],
    timestamp: 100,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

function createMessageStore(messages = [makeMessage()]) {
  return {
    async getById(messageId) {
      return messages.find((message) => message.id === messageId) ?? null;
    },
    // Whole-message selection resolves the canonical bubble group, so the store must expose the
    // same timeline the browser projected from.
    async getByThreadAfter(threadId) {
      return messages.filter((message) => message.threadId === threadId);
    },
  };
}

async function buildApp(messageStore = createMessageStore()) {
  const app = Fastify();
  await app.register(threadExportRoutes, {
    threadStore: createThreadStore(),
    messageStore,
  });
  await app.ready();
  return app;
}

describe('POST /api/threads/:threadId/export-image', () => {
  /** @type {{ url: string; userId: string; options?: { selectionMessageIds?: readonly string[] } }[]} */
  let captures = [];

  beforeEach(() => {
    captures = [];
    ImageExporter.prototype.capture = async (url, userId, options) => {
      captures.push({ url, userId, options });
      return Buffer.from('fake-png');
    };
    ImageExporter.prototype.close = async () => {};
  });

  afterEach(async () => {
    ImageExporter.prototype.capture = ORIGINAL_CAPTURE;
    ImageExporter.prototype.close = ORIGINAL_CLOSE;

    if (ORIGINAL_FRONTEND_URL === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = ORIGINAL_FRONTEND_URL;
    }

    if (ORIGINAL_FRONTEND_PORT === undefined) {
      delete process.env.FRONTEND_PORT;
    } else {
      process.env.FRONTEND_PORT = ORIGINAL_FRONTEND_PORT;
    }
  });

  it('uses localhost:3003 as default frontend URL when FRONTEND_URL is missing', async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.FRONTEND_PORT;

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:3003/thread/thread-1');
    assert.equal(captures[0].userId, 'user-1');
  });

  it('uses FRONTEND_PORT when FRONTEND_URL is missing', async () => {
    delete process.env.FRONTEND_URL;
    process.env.FRONTEND_PORT = '4101';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:4101/thread/thread-1');
  });

  it('uses FRONTEND_URL when present (higher priority than FRONTEND_PORT)', async () => {
    process.env.FRONTEND_URL = 'https://cat-cafe.example.com';
    process.env.FRONTEND_PORT = '4999';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'https://cat-cafe.example.com/thread/thread-1');
  });

  it('closes ImageExporter browser when app.close() fires (BACKLOG #86)', async () => {
    delete process.env.FRONTEND_URL;
    delete process.env.FRONTEND_PORT;

    let closeCalled = false;
    ImageExporter.prototype.close = async () => {
      closeCalled = true;
    };

    const app = await buildApp();

    // Trigger a capture so sharedExporter is instantiated
    await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });

    assert.equal(closeCalled, false, 'close() should not be called yet');

    // app.close() triggers Fastify onClose hooks
    await app.close();

    assert.equal(closeCalled, true, 'close() must be called during app.close()');
  });

  it('falls back to localhost:3003 when FRONTEND_PORT is invalid', async () => {
    delete process.env.FRONTEND_URL;
    process.env.FRONTEND_PORT = 'not-a-number';

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].url, 'http://localhost:3003/thread/thread-1');
  });

  it('resolves selection before capture and passes only timeline-normalized IDs', async () => {
    const messageStore = createMessageStore([
      makeMessage({ id: 'message-later', timestamp: 200, content: 'later' }),
      makeMessage({ id: 'message-earlier', timestamp: 100, content: 'earlier' }),
    ]);
    const app = await buildApp(messageStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-selection-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        items: [
          { kind: 'message', messageId: 'message-later' },
          { kind: 'message', messageId: 'message-earlier' },
        ],
      },
    });
    await app.close();

    assert.equal(res.statusCode, 200);
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].options, {
      selectionMessageIds: ['message-earlier', 'message-later'],
    });
  });

  it('does not launch capture when selection resolution fails', async () => {
    const app = await buildApp(createMessageStore([makeMessage({ id: 'message-1', _tombstone: true, content: '' })]));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/export-selection-image',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: { items: [{ kind: 'message', messageId: 'message-1' }] },
    });
    await app.close();

    assert.equal(res.statusCode, 400);
    assert.equal(captures.length, 0);
  });
});

describe('buildImageExportUrl', () => {
  it('appends export identity and repeated validated selection parameters', () => {
    const result = new URL(
      buildImageExportUrl('http://localhost:3003/thread/thread-1', 'user-1', {
        selectionMessageIds: ['message-1', 'message-2'],
      }),
    );

    assert.equal(result.searchParams.get('export'), 'true');
    assert.equal(result.searchParams.get('userId'), 'user-1');
    assert.deepEqual(result.searchParams.getAll('messageId'), ['message-1', 'message-2']);
  });

  it('uses the export root height instead of the 4000px capture viewport floor', () => {
    assert.equal(resolveExportCaptureHeight({ documentHeight: 4000, exportRootHeight: 214.2 }), 215);
    assert.equal(resolveExportCaptureHeight({ documentHeight: 5100, exportRootHeight: 5100 }), 5100);
    assert.equal(resolveExportCaptureHeight({ documentHeight: 900, exportRootHeight: null }), 900);
  });

  it('requires every html_widget to be measured and fully expanded before capture', () => {
    assert.deepEqual(resolveHtmlWidgetExportReadiness([]), { status: 'ready', widgetIds: [] });
    assert.deepEqual(
      resolveHtmlWidgetExportReadiness([
        { widgetId: 'short', layoutState: 'ready', expanded: true },
        { widgetId: 'long', layoutState: 'pending', expanded: true },
      ]),
      { status: 'pending', widgetIds: ['long'] },
    );
    assert.deepEqual(resolveHtmlWidgetExportReadiness([{ widgetId: 'long', layoutState: 'ready', expanded: false }]), {
      status: 'pending',
      widgetIds: ['long'],
    });
    assert.deepEqual(
      resolveHtmlWidgetExportReadiness([
        { widgetId: 'short', layoutState: 'ready', expanded: true },
        { widgetId: 'long', layoutState: 'ready', expanded: true },
      ]),
      { status: 'ready', widgetIds: ['short', 'long'] },
    );
  });

  it('surfaces html_widget measurement failures instead of permitting a clipped PNG', () => {
    assert.deepEqual(resolveHtmlWidgetExportReadiness([{ widgetId: 'broken', layoutState: 'error', expanded: true }]), {
      status: 'error',
      widgetIds: ['broken'],
    });
  });

  it('requires every html_widget to acknowledge the current exporter proof request', () => {
    const widgets = [
      { widgetId: 'fresh', layoutState: 'ready', expanded: true, proofRequestId: 'proof-current' },
      { widgetId: 'stale', layoutState: 'ready', expanded: true, proofRequestId: 'proof-previous' },
    ];
    assert.deepEqual(resolveHtmlWidgetExportReadiness(widgets, 'proof-current'), {
      status: 'pending',
      widgetIds: ['stale'],
    });
    assert.deepEqual(resolveHtmlWidgetExportReadiness([widgets[0]], 'proof-current'), {
      status: 'ready',
      widgetIds: ['fresh'],
    });
  });

  it('commits a screenshot candidate only after fresh proof both before and after capture', async () => {
    const events = [];
    let proofCount = 0;
    await assert.rejects(
      () =>
        captureVerifiedImageExportCandidate(
          async () => {
            events.push('proof');
            proofCount += 1;
            if (proofCount === 2) throw new Error('post-capture layout changed');
          },
          async () => {
            events.push('screenshot');
            return Buffer.from('candidate-png');
          },
        ),
      /post-capture layout changed/,
    );
    assert.deepEqual(events, ['proof', 'screenshot', 'proof']);
  });

  it('stitches exact chunk boundaries without repeating or dropping boundary content', async () => {
    const first = await sharp({
      create: { width: 2, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const second = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const stitched = await stitchImageExportChunks(2, 6, [
      { buffer: first, top: 0 },
      { buffer: second, top: 4 },
    ]);
    const { data, info } = await sharp(stitched).raw().toBuffer({ resolveWithObject: true });
    const pixel = (y) => Array.from(data.subarray(y * info.width * info.channels, y * info.width * info.channels + 3));

    assert.equal(info.height, 6);
    assert.deepEqual(pixel(3), [255, 0, 0]);
    assert.deepEqual(pixel(4), [0, 255, 0]);
  });
});

describe('resolveFrontendBaseUrl', () => {
  it('is exported for direct unit testing', () => {
    assert.equal(typeof resolveFrontendBaseUrl, 'function');
  });

  it('warns and falls back when FRONTEND_PORT is invalid', () => {
    const warnings = [];
    const logger = {
      warn(payload, message) {
        warnings.push({ payload, message });
      },
    };

    const baseUrl = resolveFrontendBaseUrl({ FRONTEND_PORT: 'abc' }, logger);

    assert.equal(baseUrl, 'http://localhost:3003');
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0].message), /FRONTEND_PORT/i);
  });
});

describe('resolveFrontendCorsOrigins', () => {
  it('includes FRONTEND_PORT origin when configured', () => {
    const origins = resolveFrontendCorsOrigins({ FRONTEND_PORT: '4101' });
    assert.ok(origins.includes('http://localhost:4101'));
    assert.ok(origins.includes('http://localhost:3000'));
    assert.ok(origins.includes('http://localhost:3003'));
  });

  it('includes FRONTEND_URL origin when configured', () => {
    const origins = resolveFrontendCorsOrigins({ FRONTEND_URL: 'https://cat-cafe.example.com/path' });
    assert.ok(origins.includes('https://cat-cafe.example.com'));
  });
});
