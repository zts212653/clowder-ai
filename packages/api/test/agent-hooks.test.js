import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { buildAgentHookTargets, getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';
import { agentHooksRoutes } from '../dist/routes/agent-hooks.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user' };
const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

async function createProjectRoot() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-project-'));
  const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
  await mkdir(hookDir, { recursive: true });
  await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
  await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
  return projectRoot;
}

describe('agent hook sync targets', () => {
  let projectRoot;
  let targetRoot;

  beforeEach(async () => {
    projectRoot = await createProjectRoot();
    targetRoot = await mkdtemp(join(tmpdir(), 'agent-hooks-home-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it('selects only user-level hook targets and renders Codex paths per target home', () => {
    const targets = buildAgentHookTargets({ projectRoot, targetRoot });
    assert.deepEqual(
      targets.map((target) => target.name),
      ['hooks/session-start', 'hooks/session-stop', 'codex-hooks'],
    );

    const codexHooks = targets.find((target) => target.name === 'codex-hooks');
    assert.ok(codexHooks);
    const rendered = JSON.parse(codexHooks.render());
    assert.equal(
      rendered.hooks.SessionStart[0].hooks[0].command,
      join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
    );
    assert.equal(
      rendered.hooks.Stop[0].hooks[0].command,
      join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'),
    );
  });

  it('sync writes scripts, Codex hooks.json, and preserves unknown Claude settings hooks', async () => {
    const claudeDir = join(targetRoot, '.claude');
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: '/custom/start.sh' },
                  { type: 'command', command: '/custom/session-start-recall.sh' },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: join(targetRoot, '.claude', 'hooks', 'legacy', 'session-stop-check.sh'),
                  },
                ],
              },
            ],
            PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/custom/pre.sh' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const result = await syncAgentHooks({ projectRoot, targetRoot });
    assert.equal(result.status, 'configured');

    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    const stopScript = join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh');
    assert.equal(await readFile(startScript, 'utf8'), '#!/bin/bash\necho start\n');
    assert.equal(await readFile(stopScript, 'utf8'), '#!/bin/bash\necho stop\n');

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, '/custom/start.sh');
    assert.equal(settings.hooks.SessionStart[0].hooks[1].command, '/custom/session-start-recall.sh');
    assert.equal(settings.hooks.SessionStart[1].hooks[0].command, startScript);
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, stopScript);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '/custom/pre.sh');

    const codex = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, startScript);
    assert.equal(codex.hooks.Stop[0].hooks[0].command, stopScript);

    for (const target of buildAgentHookTargets({ projectRoot, targetRoot })) {
      assert.equal(
        await readFile(target.targetPath, 'utf8'),
        target.render(),
        `${target.name} should match renderer bytes`,
      );
    }
  });

  it('recognizes quoted $HOME Claude template commands and avoids duplicate managed hooks on sync', async () => {
    await rm(targetRoot, { recursive: true, force: true });
    targetRoot = await mkdtemp(join(tmpdir(), 'agent hooks home-'));

    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/session-start-recall.sh"' }] }],
            Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.claude/hooks/session-stop-check.sh"' }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const before = await getAgentHookStatus({ projectRoot, targetRoot });
    const beforeClaudeSettings = before.targets.find((target) => target.name === 'claude-settings');
    assert.equal(beforeClaudeSettings?.status, 'configured');

    await syncAgentHooks({ projectRoot, targetRoot });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.SessionStart, [
      { hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh') }] },
    ]);
    assert.deepEqual(settings.hooks.Stop, [
      { hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh') }] },
    ]);
  });

  it('reports stale scripts with a diff summary and canonicalizes Codex hooks JSON', async () => {
    await syncAgentHooks({ projectRoot, targetRoot });

    await writeFile(
      join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
      '#!/bin/bash\necho stale\n',
      'utf8',
    );
    await writeFile(
      join(targetRoot, '.codex', 'hooks.json'),
      JSON.stringify(JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'))),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const start = status.targets.find((target) => target.name === 'hooks/session-start');
    const codex = status.targets.find((target) => target.name === 'codex-hooks');
    assert.equal(status.status, 'stale');
    assert.equal(start?.status, 'stale');
    assert.equal(start?.drifted, true);
    assert.equal(start?.diff?.kind, 'text');
    assert.equal(start?.diff?.line, 2);
    assert.equal(codex?.status, 'configured');
    assert.equal(codex?.drifted, false);
  });
});

describe('agent hook routes', () => {
  let app;
  let projectRoot;
  let targetRoot;

  function addSessionTestHook(fastify) {
    fastify.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string' && sessionUser.trim()) {
        request.sessionUserId = sessionUser.trim();
      }
    });
  }

  beforeEach(async () => {
    projectRoot = await createProjectRoot();
    targetRoot = await mkdtemp(join(tmpdir(), `agent-hooks-route-${randomUUID()}-`));
    app = Fastify();
    addSessionTestHook(app);
    await app.register(agentHooksRoutes, { projectRoot, targetRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  it('GET requires session identity and does not write user home files', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/agent-hooks/status' });
    assert.equal(unauthorized.statusCode, 401);

    const headerOnly = await app.inject({ method: 'GET', url: '/api/agent-hooks/status', headers: HEADERS });
    assert.equal(headerOnly.statusCode, 401);

    const res = await app.inject({ method: 'GET', url: '/api/agent-hooks/status', headers: SESSION_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'missing');
    const start = body.targets.find((target) => target.name === 'hooks/session-start');
    const codex = body.targets.find((target) => target.name === 'codex-hooks');
    assert.equal(start?.drifted, true);
    assert.equal(start?.diff?.kind, 'text');
    assert.equal(codex?.status, 'unsupported');
    assert.equal(codex?.drifted, false);

    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
  });

  it('browser requests require a real session before hook sync can write files', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: { origin: 'http://localhost:3003', host: 'localhost:3003' },
    });
    assert.equal(unauthorized.statusCode, 401);
    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));

    const authorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: { origin: 'http://localhost:3003', host: 'localhost:3003', 'x-test-session-user': 'session-user' },
    });
    assert.equal(authorized.statusCode, 200);
    const hooksJson = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(
      hooksJson.hooks.SessionStart[0].hooks[0].command,
      join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
    );
  });

  it('rejects no-origin header-only sync requests before writing hook files', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: HEADERS,
    });
    assert.equal(unauthorized.statusCode, 401);
    await assert.rejects(readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
  });

  it('does not fall back to the API process home for non-local peers', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: { ...SESSION_HEADERS, host: 'cat-cafe.example.com' },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('allows implicit status checks for local browser hosts', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'http://localhost:3003',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      assert.ok(Array.isArray(body.targets));
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust loopback proxy sockets for public Host headers', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'cafe.example.com',
          origin: 'https://cafe.example.com',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust spoofed local Host headers with public browser origins', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: {
          ...SESSION_HEADERS,
          host: 'localhost:3004',
          origin: 'https://cafe.example.com',
        },
        remoteAddress: '127.0.0.1',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('does not trust a forged localhost Host header from a remote peer', async () => {
    const implicitApp = Fastify();
    addSessionTestHook(implicitApp);
    await implicitApp.register(agentHooksRoutes, { projectRoot });
    await implicitApp.ready();

    try {
      const res = await implicitApp.inject({
        method: 'GET',
        url: '/api/agent-hooks/status',
        headers: { ...SESSION_HEADERS, host: 'localhost:3003' },
        remoteAddress: '203.0.113.10',
      });
      assert.equal(res.statusCode, 403);
      assert.match(res.payload, /local API host/);
    } finally {
      await implicitApp.close();
    }
  });

  it('POST is the explicit action that syncs and returns configured status', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/agent-hooks/sync', headers: SESSION_HEADERS });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'configured');
    assert.ok(body.targets.every((target) => target.status === 'configured'));

    const hooksJson = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(
      hooksJson.hooks.SessionStart[0].hooks[0].command,
      join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'),
    );
  });

  it('returns error status instead of throwing when a target file cannot be read', async () => {
    await syncAgentHooks({ projectRoot, targetRoot });
    const startPath = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    await chmod(startPath, 0o000);

    try {
      const body = await getAgentHookStatus({ projectRoot, targetRoot });
      const start = body.targets.find((target) => target.name === 'hooks/session-start');
      assert.equal(start?.status, 'error');
      assert.equal(body.status, 'error');
    } finally {
      await chmod(startPath, 0o755);
    }
  });
});
