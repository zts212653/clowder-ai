/**
 * Image upload pipeline tests
 * - saveUploadedImages: file saving + validation
 * - extractImagePaths: URL → absolute path conversion
 * - CLI flag construction for each agent
 * - Multipart POST + contentBlocks in GET response
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('claude');
ensureFakeCliOnPath('codex');
ensureFakeCliOnPath('gemini');

describe('saveUploadedImages', () => {
  let uploadDir;

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-upload-'));
  });

  afterEach(async () => {
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  it('saves a valid PNG file and returns metadata', async () => {
    const { saveUploadedImages } = await import('../dist/routes/image-upload.js');

    const fakeFile = createMockFile('test.png', 'image/png', Buffer.from('fake-png'));
    const saved = await saveUploadedImages([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.ok(saved[0].absPath.startsWith(resolve(uploadDir)));
    assert.ok(saved[0].urlPath.startsWith('/uploads/'));
    assert.equal(saved[0].content.type, 'image');
    assert.ok(saved[0].content.url.startsWith('/uploads/'));

    // Verify file was written
    const files = await readdir(uploadDir);
    assert.equal(files.length, 1);
    const content = await readFile(join(uploadDir, files[0]));
    assert.equal(content.toString(), 'fake-png');
  });

  it('rejects unsupported MIME types', async () => {
    const { saveUploadedImages, ImageUploadError } = await import('../dist/routes/image-upload.js');

    const fakeFile = createMockFile('evil.exe', 'application/octet-stream', Buffer.from('bad'));
    await assert.rejects(
      () => saveUploadedImages([fakeFile], uploadDir),
      (err) => err instanceof ImageUploadError && err.message.includes('Unsupported'),
    );
  });

  it('rejects files exceeding 10MB', async () => {
    const { saveUploadedImages, ImageUploadError } = await import('../dist/routes/image-upload.js');

    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, 0x42); // 11MB
    const fakeFile = createMockFile('huge.png', 'image/png', bigBuffer);
    await assert.rejects(
      () => saveUploadedImages([fakeFile], uploadDir),
      (err) => err instanceof ImageUploadError && err.message.includes('too large'),
    );
  });

  it('rejects more than 5 files', async () => {
    const { saveUploadedImages, ImageUploadError } = await import('../dist/routes/image-upload.js');

    const files = Array.from({ length: 6 }, (_, i) =>
      createMockFile(`img${i}.png`, 'image/png', Buffer.from(`img${i}`)),
    );
    await assert.rejects(
      () => saveUploadedImages(files, uploadDir),
      (err) => err instanceof ImageUploadError && err.message.includes('Too many'),
    );
  });

  it('saves multiple files with unique names', async () => {
    const { saveUploadedImages } = await import('../dist/routes/image-upload.js');

    const files = [
      createMockFile('a.png', 'image/png', Buffer.from('aaa')),
      createMockFile('b.jpg', 'image/jpeg', Buffer.from('bbb')),
    ];
    const saved = await saveUploadedImages(files, uploadDir);

    assert.equal(saved.length, 2);
    assert.notEqual(saved[0].absPath, saved[1].absPath);

    const diskFiles = await readdir(uploadDir);
    assert.equal(diskFiles.length, 2);
  });

  it('uses MIME extension, ignores malicious filename (regression: XSS via .html)', async () => {
    const { saveUploadedImages } = await import('../dist/routes/image-upload.js');

    const fakeFile = createMockFile('evil.html', 'image/png', Buffer.from('fake-png'));
    const saved = await saveUploadedImages([fakeFile], uploadDir);

    assert.equal(saved.length, 1);
    assert.ok(saved[0].absPath.endsWith('.png'), `expected .png, got ${saved[0].absPath}`);
    assert.ok(saved[0].urlPath.endsWith('.png'), `expected .png URL, got ${saved[0].urlPath}`);
  });
});

describe('extractImagePaths', () => {
  it('uses packages/api/uploads as the default upload dir regardless of cwd', async () => {
    const { getDefaultUploadDir } = await import('../dist/utils/upload-paths.js');

    const dir = getDefaultUploadDir();
    assert.ok(
      dir.endsWith('/packages/api/uploads'),
      `expected default upload dir to end with /packages/api/uploads, got ${dir}`,
    );
  });

  it('extracts absolute paths from /uploads/ URLs', async () => {
    const { extractImagePaths } = await import('../dist/domains/cats/services/agents/providers/image-paths.js');

    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'image', url: '/uploads/1234-abcd.png' },
      { type: 'image', url: '/uploads/5678-efgh.jpg' },
    ];

    const paths = extractImagePaths(blocks);
    assert.equal(paths.length, 2);
    assert.ok(paths[0].endsWith('1234-abcd.png'));
    assert.ok(paths[1].endsWith('5678-efgh.jpg'));
  });

  it('returns empty array for undefined contentBlocks', async () => {
    const { extractImagePaths } = await import('../dist/domains/cats/services/agents/providers/image-paths.js');
    assert.deepEqual(extractImagePaths(undefined), []);
  });

  it('ignores non-image blocks', async () => {
    const { extractImagePaths } = await import('../dist/domains/cats/services/agents/providers/image-paths.js');

    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'code', language: 'js', code: 'x=1' },
    ];
    assert.deepEqual(extractImagePaths(blocks), []);
  });

  it('uses custom uploadDir when provided (regression: env vs opts mismatch)', async () => {
    const { extractImagePaths } = await import('../dist/domains/cats/services/agents/providers/image-paths.js');
    const { resolve } = await import('node:path');

    const blocks = [{ type: 'image', url: '/uploads/test.png' }];
    const paths = extractImagePaths(blocks, '/custom/upload/dir');
    assert.equal(paths.length, 1);
    assert.equal(paths[0], resolve('/custom/upload/dir', 'test.png'));
  });
});

describe('Claude CLI image fallback', () => {
  it('does not use unsupported --images flag, grants image dir access, and appends local path hints', async () => {
    const spawnArgs = [];
    const mockSpawnFn = (cmd, args, opts) => {
      spawnArgs.push({ cmd, args: [...args], opts });
      return createMockProcess([]);
    };

    const { ClaudeAgentService } = await import('../dist/domains/cats/services/agents/providers/ClaudeAgentService.js');
    const service = new ClaudeAgentService({ spawnFn: mockSpawnFn });

    for await (const _ of service.invoke('test', {
      contentBlocks: [
        { type: 'text', text: 'look at this' },
        { type: 'image', url: '/uploads/photo.png' },
      ],
    })) {
      // consume
    }

    assert.equal(spawnArgs.length, 1);
    const args = spawnArgs[0].args;
    const imgIdx = args.indexOf('--images');
    assert.equal(imgIdx, -1, 'should not pass unsupported --images flag');
    const addDirIdx = args.indexOf('--add-dir');
    assert.ok(addDirIdx >= 0, 'should pass --add-dir for image directory');
    const prompt = args.find((a) => typeof a === 'string' && a.includes('[Local image path:'));
    assert.ok(prompt, 'prompt should include local image path hint');
    assert.ok(prompt.includes('photo.png'));
  });
});

describe('Codex CLI image text fallback', () => {
  it('uses native --image arguments instead of prompt text fallback', async () => {
    const spawnArgs = [];
    const mockSpawnFn = (cmd, args, opts) => {
      spawnArgs.push({ cmd, args: [...args], opts });
      return createMockProcess([]);
    };

    const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');
    const service = new CodexAgentService({ spawnFn: mockSpawnFn });

    for await (const _ of service.invoke('review this', {
      contentBlocks: [{ type: 'image', url: '/uploads/screenshot.png' }],
    })) {
      // consume
    }

    assert.equal(spawnArgs.length, 1);
    const args = spawnArgs[0].args;
    const imageIdx = args.indexOf('--image');
    assert.ok(imageIdx >= 0, 'should pass --image for codex exec');
    assert.ok(String(args[imageIdx + 1]).includes('screenshot.png'));
  });
});

describe('Gemini CLI image fallback', () => {
  it('does not use -i interactive flag, includes image dir, and appends local path hints', async () => {
    const spawnArgs = [];
    const mockSpawnFn = (cmd, args, opts) => {
      spawnArgs.push({ cmd, args: [...args], opts });
      return createMockProcess([]);
    };

    const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');
    const service = new GeminiAgentService({
      adapter: 'gemini-cli',
      spawnFn: mockSpawnFn,
    });

    for await (const _ of service.invoke('describe this', {
      contentBlocks: [{ type: 'image', url: '/uploads/cat-photo.jpg' }],
    })) {
      // consume
    }

    assert.equal(spawnArgs.length, 1);
    const args = spawnArgs[0].args;
    const imgIdx = args.indexOf('-i');
    assert.equal(imgIdx, -1, 'should not pass -i (interactive prompt) for images');
    const includeDirIdx = args.indexOf('--include-directories');
    assert.ok(includeDirIdx >= 0, 'should include image directory for tool access');
    const prompt = args.find((a) => typeof a === 'string' && a.includes('[Local image path:'));
    assert.ok(prompt, 'prompt should include local image path hint');
    assert.ok(prompt.includes('cat-photo.jpg'));
  });
});

describe('contentBlocks in GET /api/messages', () => {
  let app;
  let messageStore;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    messageStore = new MessageStore();
    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: { broadcastAgentMessage: () => {} },
      threadStore: new ThreadStore(),
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns contentBlocks when present', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'check this image',
      contentBlocks: [
        { type: 'text', text: 'check this image' },
        { type: 'image', url: '/uploads/test.png' },
      ],
      mentions: ['opus'],
      timestamp: 1000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.ok(body.messages[0].contentBlocks);
    assert.equal(body.messages[0].contentBlocks.length, 2);
    assert.equal(body.messages[0].contentBlocks[0].type, 'text');
    assert.equal(body.messages[0].contentBlocks[1].type, 'image');
  });

  it('omits contentBlocks when not present', async () => {
    messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'text only',
      mentions: [],
      timestamp: 1000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/messages' });
    const body = JSON.parse(res.body);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].contentBlocks, undefined);
  });
});

describe('multipart image target routing', () => {
  let app;
  let uploadDir;
  const routeExecutionCalls = [];
  const broadcastedAgentMessages = [];

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'cat-cafe-image-target-'));
    routeExecutionCalls.length = 0;
    broadcastedAgentMessages.length = 0;

    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const { messagesRoutes } = await import('../dist/routes/messages.js');

    const messageStore = new MessageStore();
    const mockRouter = {
      async resolveTargetsAndIntent() {
        return {
          targetCats: ['opus'],
          intent: { intent: 'execute', explicit: false, promptTags: [] },
        };
      },
      async *routeExecution(_userId, _content, _threadId, _userMessageId, targetCats, _intent, routeOptions) {
        routeExecutionCalls.push({
          targetCats: [...targetCats],
          contentBlocks: routeOptions?.contentBlocks,
          uploadDir: routeOptions?.uploadDir,
        });
        yield { type: 'done', catId: targetCats[0], timestamp: Date.now(), isFinal: true };
      },
      async ackCollectedCursors() {},
    };

    app = Fastify();
    await app.register(messagesRoutes, {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: {
        broadcastAgentMessage: (msg) => {
          broadcastedAgentMessages.push(msg);
        },
        broadcastToRoom: () => {},
      },
      router: mockRouter,
      invocationRecordStore: new InvocationRecordStore(),
      uploadDir,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
  });

  it('routes multipart image messages to the mentioned cat (not forced to codex)', async () => {
    const boundary = '----cat-cafe-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n请看图\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="clip.png"\r\nContent-Type: image/png\r\n\r\nfake-png-bytes\r\n`,
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-cat-cafe-user': 'alice',
      },
      payload,
    });

    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(routeExecutionCalls.length, 1);
    // P1 regression guard: targetCats must match router resolution, not be overridden to codex
    assert.deepEqual(
      routeExecutionCalls[0].targetCats,
      ['opus'],
      'image message should route to the resolved target cat, not forced to codex',
    );
    assert.equal(routeExecutionCalls[0].uploadDir, uploadDir);
    assert.ok(Array.isArray(routeExecutionCalls[0].contentBlocks), 'routeExecution should receive contentBlocks');
    assert.ok(
      routeExecutionCalls[0].contentBlocks.some((b) => b.type === 'image'),
      'routeExecution should receive image content block',
    );
    // No forced-to-codex notice should be broadcast
    const notice = broadcastedAgentMessages.find(
      (m) => m?.type === 'system_info' && typeof m?.content === 'string' && m.content.includes('已自动转交缅因猫'),
    );
    assert.equal(notice, undefined, 'should NOT broadcast forced-to-codex notice');
  });
});

// --- Test Helpers ---

function createMockFile(filename, mimetype, buffer) {
  return {
    filename,
    mimetype,
    toBuffer: async () => buffer,
  };
}

function createMockProcess(events) {
  const { Readable } = require('node:stream');

  const stdoutData = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  const stdout = Readable.from(stdoutData);
  const stderr = Readable.from('');

  return {
    stdout,
    stderr,
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(0, null), 10);
      if (event === 'error') {
        /* no-op */
      }
      return { stdout, stderr, on: () => ({}) };
    },
    kill: () => true,
    killed: false,
    pid: 12345,
  };
}
