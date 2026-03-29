/**
 * Commands API route tests
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { CommandRegistry } from '../dist/infrastructure/commands/CommandRegistry.js';
import { commandsRoutes } from '../dist/routes/commands.js';

// Mock opus service
const mockOpusService = {
  async *invoke() {
    yield { type: 'text', content: '[{"title": "Extracted task", "why": "From test", "sourceIndex": 0}]' };
    yield { type: 'done', catId: 'opus' };
  },
};

// Mock socket manager
const mockSocketManager = {
  broadcastToRoom: () => {},
};

describe('Commands Routes', () => {
  let app;
  let messageStore;
  let taskStore;
  let threadStore;
  let ownThreadId;
  let otherThreadId;

  beforeEach(async () => {
    app = Fastify();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    threadStore = new ThreadStore();
    ownThreadId = threadStore.create('test-user', 'Own thread').id;
    otherThreadId = threadStore.create('other-user', 'Other thread').id;

    await app.register(commandsRoutes, {
      messageStore,
      taskStore,
      socketManager: mockSocketManager,
      opusService: mockOpusService,
      threadStore,
    });
    await app.ready();
  });

  it('POST /api/commands/extract-tasks creates tasks', async () => {
    // Add some messages first
    await messageStore.append({
      content: 'TODO: write tests',
      userId: 'test-user',
      threadId: ownThreadId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 1);
    assert.equal(body.tasks[0].title, 'Extracted task');
  });

  it('POST /api/commands/extract-tasks returns 400 for missing threadId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {},
    });

    assert.equal(res.statusCode, 400);
  });

  it('POST /api/commands/extract-tasks returns empty for no messages', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 0);
    assert.equal(body.degraded, false);
  });

  it('uses X-Cat-Cafe-User header over legacy payload userId', async () => {
    await messageStore.append({
      content: 'TODO: header identity should win',
      userId: 'test-user',
      threadId: ownThreadId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: ownThreadId,
        userId: 'legacy-user-should-not-win',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.count, 1);
  });

  it('returns 401 when identity is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      payload: {
        threadId: ownThreadId,
      },
    });

    assert.equal(res.statusCode, 401);
  });

  it('returns 403 when accessing another user thread', async () => {
    await messageStore.append({
      content: 'TODO: should not be visible',
      userId: 'other-user',
      threadId: otherThreadId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/commands/extract-tasks',
      headers: { 'x-cat-cafe-user': 'test-user' },
      payload: {
        threadId: otherThreadId,
      },
    });

    assert.equal(res.statusCode, 403);
  });
});

// --- F142 Phase B: GET /api/commands (command listing) ---

const CORE_CMDS = [
  { name: '/help', usage: '/help', description: 'Help', category: 'general', surface: 'both', source: 'core' },
  {
    name: '/where',
    usage: '/where',
    description: 'Where',
    category: 'connector',
    surface: 'connector',
    source: 'core',
  },
  { name: '/config', usage: '/config', description: 'Config', category: 'general', surface: 'web', source: 'core' },
];

function buildListingApp(extraSkill) {
  const registry = new CommandRegistry(CORE_CMDS);
  if (extraSkill) {
    registry.registerSkillCommands(extraSkill.id, extraSkill.commands, { warn: () => {} });
  }
  const app = Fastify();
  app.register(commandsRoutes, {
    messageStore: new MessageStore(),
    taskStore: new TaskStore(),
    socketManager: { broadcastToRoom: () => {} },
    opusService: {
      async *invoke() {
        yield { type: 'done', catId: 'opus' };
      },
    },
    registry,
  });
  return app;
}

describe('GET /api/commands (F142-B)', () => {
  it('returns all commands without surface filter', async () => {
    const app = buildListingApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.commands.length, 3);
  });

  it('filters by surface=connector', async () => {
    const app = buildListingApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands?surface=connector' });
    const body = res.json();
    const names = body.commands.map((c) => c.name).sort();
    assert.deepEqual(names, ['/help', '/where']);
  });

  it('filters by surface=web', async () => {
    const app = buildListingApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands?surface=web' });
    const body = res.json();
    const names = body.commands.map((c) => c.name).sort();
    assert.deepEqual(names, ['/config', '/help']);
  });

  it('includes skill commands', async () => {
    const app = buildListingApp({
      id: 'debugging',
      commands: [
        {
          name: '/debug',
          usage: '/debug',
          description: 'Debug',
          category: 'general',
          surface: 'connector',
          source: 'skill',
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/commands?surface=connector' });
    const body = res.json();
    const debug = body.commands.find((c) => c.name === '/debug');
    assert.ok(debug);
    assert.equal(debug.source, 'skill');
    assert.equal(debug.skillId, 'debugging');
  });

  it('all commands have surface and source fields (AC-B8)', async () => {
    const app = buildListingApp();
    const res = await app.inject({ method: 'GET', url: '/api/commands' });
    for (const cmd of res.json().commands) {
      assert.ok(cmd.surface, `${cmd.name} missing surface`);
      assert.ok(cmd.source, `${cmd.name} missing source`);
    }
  });
});
