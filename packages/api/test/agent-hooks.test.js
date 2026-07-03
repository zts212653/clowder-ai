import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { buildAgentHookTargets, getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';
import { agentHooksRoutes } from '../dist/routes/agent-hooks.js';
import { resolveStartupProjectRoot } from '../dist/utils/startup-root.js';

const HEADERS = { 'x-cat-cafe-user': 'test-user' };
const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

function bashCmd(scriptPath) {
  return `bash "${scriptPath}"`;
}

function codexStopCmd(scriptPath) {
  return `${bashCmd(scriptPath)} --codex-json`;
}

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

  it('selects only user-level hook targets and renders Codex/Gemini paths per target home', () => {
    const targets = buildAgentHookTargets({ projectRoot, targetRoot });
    assert.deepEqual(
      targets.map((target) => target.name),
      ['hooks/session-start', 'hooks/session-stop', 'codex-hooks', 'gemini-hooks'],
    );

    const startScript = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'));
    const stopScript = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'));

    const codexHooks = targets.find((target) => target.name === 'codex-hooks');
    assert.ok(codexHooks);
    const codexRendered = JSON.parse(codexHooks.render());
    assert.equal(codexRendered.hooks.SessionStart[0].hooks[0].command, startScript);
    assert.equal(
      codexRendered.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
    );

    const geminiHooks = targets.find((target) => target.name === 'gemini-hooks');
    assert.ok(geminiHooks);
    const geminiRendered = JSON.parse(geminiHooks.render());
    assert.equal(geminiRendered.hooks.SessionStart[0].hooks[0].command, startScript);
    assert.equal(geminiRendered.hooks.Stop[0].hooks[0].command, stopScript);
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
    assert.equal(settings.hooks.SessionStart[1].hooks[0].command, bashCmd(startScript));
    assert.equal(settings.hooks.Stop.length, 1);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, bashCmd(stopScript));
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '/custom/pre.sh');

    const codex = JSON.parse(await readFile(join(targetRoot, '.codex', 'hooks.json'), 'utf8'));
    assert.equal(codex.hooks.SessionStart[0].hooks[0].command, bashCmd(startScript));
    assert.equal(codex.hooks.Stop[0].hooks[0].command, codexStopCmd(stopScript));

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
    assert.equal(beforeClaudeSettings?.status, 'stale');

    await syncAgentHooks({ projectRoot, targetRoot });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooks.SessionStart, [
      {
        hooks: [{ type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')) }],
      },
    ]);
    assert.deepEqual(settings.hooks.Stop, [
      { hooks: [{ type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')) }] },
    ]);
  });

  it('detects old-format (no bash prefix) commands as stale so UI shows repair prompt', async () => {
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
            SessionStart: [
              {
                hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh') }],
              },
            ],
            Stop: [
              { hooks: [{ type: 'command', command: join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh') }] },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'stale');
    assert.match(claudeSettings?.reason, /bash prefix/);
  });

  it('detects mixed old+new format entries in same event as stale', async () => {
    const claudeHooksDir = join(targetRoot, '.claude', 'hooks');
    await mkdir(claudeHooksDir, { recursive: true });
    await writeFile(join(claudeHooksDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(claudeHooksDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');

    const settingsPath = join(targetRoot, '.claude', 'settings.json');
    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    const stopScript = join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh');
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: 'command', command: startScript }] },
              { hooks: [{ type: 'command', command: bashCmd(startScript) }] },
            ],
            Stop: [{ hooks: [{ type: 'command', command: bashCmd(stopScript) }] }],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'stale');
    assert.match(claudeSettings?.reason, /bash prefix/);
  });

  it('detects bash-prefixed commands as configured', async () => {
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
            SessionStart: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
                  },
                ],
              },
            ],
            Stop: [
              {
                hooks: [
                  { type: 'command', command: bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')) },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const status = await getAgentHookStatus({ projectRoot, targetRoot });
    const claudeSettings = status.targets.find((target) => target.name === 'claude-settings');
    assert.equal(claudeSettings?.status, 'configured');
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

  it('ownerAuthorized=false syncs hooks but does not create capabilities.json', async () => {
    // Ensure no capabilities.json exists
    const capPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    await rm(capPath, { force: true });

    const result = await syncAgentHooks({ projectRoot, targetRoot, ownerAuthorized: false });

    // Hooks should still be written
    const startScript = join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh');
    assert.equal(await readFile(startScript, 'utf8'), '#!/bin/bash\necho start\n');

    // capabilities.json must NOT be created (fail-closed)
    const capExists = (await readFile(capPath, 'utf8').catch(() => null)) !== null;
    assert.equal(capExists, false, 'capabilities.json should not be created by non-owner sync');

    assert.ok(result.targets.length > 0);
  });

  it('health sync preserves project-local plugin MCP entries (no orphan removal)', async () => {
    // Regression: syncAgentHooks with ownerAuthorized=true must NOT remove
    // project-local MCP entries that are absent from the global config.
    // The keep-project policy only protects config-mismatch; project-orphan
    // issues must be filtered out of the health sync path entirely.
    const catCafeDir = join(projectRoot, '.cat-cafe');
    await mkdir(catCafeDir, { recursive: true });

    const pluginMcpId = `probe-plugin-${randomUUID().slice(0, 8)}`;
    const capabilities = {
      version: 2,
      capabilities: [
        {
          type: 'mcp',
          id: pluginMcpId,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          enabled: true,
          mcpServer: { command: 'echo', args: ['test'] },
        },
      ],
    };
    await writeFile(join(catCafeDir, 'capabilities.json'), JSON.stringify(capabilities, null, 2), 'utf-8');

    await syncAgentHooks({ projectRoot, targetRoot, ownerAuthorized: true });

    const afterSync = JSON.parse(await readFile(join(catCafeDir, 'capabilities.json'), 'utf-8'));
    const pluginEntry = afterSync.capabilities.find((c) => c.id === pluginMcpId);
    assert.ok(pluginEntry, `Plugin MCP "${pluginMcpId}" must survive health sync (not removed as orphan)`);
    assert.equal(pluginEntry.pluginId, 'test-plugin');
  });

  it('health status reports configured (not stale) when only orphan MCP drift exists', async () => {
    // Regression: checkMcpHealth must filter project-orphan issues the same way
    // syncAgentHooks does. Otherwise the UI shows an un-clearable stale badge
    // for projects with plugin MCPs not in global config.
    //
    // Strategy: seed an empty capabilities.json so syncAgentHooks populates
    // all global MCPs, then inject a plugin-owned orphan entry that has no
    // global counterpart. After sync, global-new drift = 0; only orphan remains.
    const catCafeDir = join(projectRoot, '.cat-cafe');
    const capPath = join(catCafeDir, 'capabilities.json');
    await mkdir(catCafeDir, { recursive: true });
    await writeFile(capPath, JSON.stringify({ version: 2, capabilities: [] }), 'utf-8');
    await syncAgentHooks({ projectRoot, targetRoot, ownerAuthorized: true });
    const synced = JSON.parse(await readFile(capPath, 'utf-8'));

    const pluginMcpId = `orphan-only-${randomUUID().slice(0, 8)}`;
    synced.capabilities.push({
      type: 'mcp',
      id: pluginMcpId,
      source: 'cat-cafe',
      pluginId: 'test-plugin',
      enabled: true,
      mcpServer: { command: 'echo', args: ['test'] },
    });
    await writeFile(capPath, JSON.stringify(synced, null, 2), 'utf-8');

    const status = await getAgentHookStatus({ projectRoot, targetRoot, ownerAuthorized: true });
    const mcpResult = status.targets.find((t) => t.name === 'mcp');
    assert.ok(mcpResult, 'health status must include mcp target');
    assert.equal(mcpResult.status, 'configured', 'orphan-only MCP drift must not report stale');
    assert.equal(mcpResult.drifted, false, 'orphan-only MCP drift must not report drifted');
  });

  it('health status reports stale for non-plugin managed MCP orphans', async () => {
    // Non-plugin orphans (managed MCPs removed from global config) should
    // surface as stale — they represent real drift, unlike plugin orphans.
    //
    // The orphan filter requires a valid global config at the startup root
    // (filterOrphanIssues falls back to filtering ALL orphans when global
    // is unreadable). Ensure a minimal global config exists for CI envs
    // where .cat-cafe/ is not checked in.
    const startupRoot = resolveStartupProjectRoot();
    const globalCapsPath = join(startupRoot, '.cat-cafe', 'capabilities.json');
    const globalCapsExisted = existsSync(globalCapsPath);
    if (!globalCapsExisted) {
      await mkdir(join(startupRoot, '.cat-cafe'), { recursive: true });
      await writeFile(globalCapsPath, JSON.stringify({ version: 2, capabilities: [] }), 'utf-8');
    }

    const catCafeDir = join(projectRoot, '.cat-cafe');
    const capPath = join(catCafeDir, 'capabilities.json');
    await mkdir(catCafeDir, { recursive: true });
    await writeFile(capPath, JSON.stringify({ version: 2, capabilities: [] }), 'utf-8');
    await syncAgentHooks({ projectRoot, targetRoot, ownerAuthorized: true });
    const synced = JSON.parse(await readFile(capPath, 'utf-8'));

    // Inject a managed (non-plugin) orphan — source 'cat-cafe' but NO pluginId
    const managedOrphanId = `managed-orphan-${randomUUID().slice(0, 8)}`;
    synced.capabilities.push({
      type: 'mcp',
      id: managedOrphanId,
      source: 'cat-cafe',
      enabled: true,
      mcpServer: { command: 'echo', args: ['test'] },
    });
    await writeFile(capPath, JSON.stringify(synced, null, 2), 'utf-8');

    try {
      const status = await getAgentHookStatus({ projectRoot, targetRoot, ownerAuthorized: true });
      const mcpResult = status.targets.find((t) => t.name === 'mcp');
      assert.ok(mcpResult, 'health status must include mcp target');
      assert.equal(mcpResult.status, 'stale', 'non-plugin managed orphan must report stale');
      assert.equal(mcpResult.drifted, true, 'non-plugin managed orphan must report drifted');
    } finally {
      // Clean up global config if we created it (don't leave artifacts in repo root)
      if (!globalCapsExisted) {
        await rm(globalCapsPath, { force: true });
      }
    }
  });

  it('ownerAuthorized omitted defaults to fail-closed (no capability sync)', async () => {
    // When ownerAuthorized is not passed at all (undefined), capability sync should NOT run.
    // This is the fail-closed default demanded by P2-4 re-review.
    const capPath = join(projectRoot, '.cat-cafe', 'capabilities.json');
    await rm(capPath, { force: true });

    // Call without ownerAuthorized (undefined)
    const result = await syncAgentHooks({ projectRoot, targetRoot });

    const capExists = (await readFile(capPath, 'utf8').catch(() => null)) !== null;
    assert.equal(capExists, false, 'capabilities.json should not be created when ownerAuthorized is omitted');
    assert.ok(result.targets.length > 0);
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
      bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
    );
    assert.equal(
      hooksJson.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
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
      bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh')),
    );
    assert.equal(
      hooksJson.hooks.Stop[0].hooks[0].command,
      codexStopCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh')),
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

  it('GET rejects explicit invalid projectPath instead of falling back to host (#1049 regression)', async () => {
    // An explicit projectPath that does not exist must return 400,
    // NOT silently fall back to host repo health.
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-hooks/status?projectPath=/nonexistent/path/that/does/not/exist`,
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 400, 'invalid projectPath must fail loud with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'response must include error message');
    // Must NOT contain health targets (which would mean it read host state)
    assert.equal(body.targets, undefined, 'must not return host health targets');
  });

  it('GET rejects explicit uninitialized projectPath (no .cat-cafe/) instead of falling back to host', async () => {
    // A valid directory that is not initialized as a project must not fall back to host
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-uninit-'));
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/agent-hooks/status?projectPath=${encodeURIComponent(uninitDir)}`,
        headers: SESSION_HEADERS,
      });
      assert.equal(res.statusCode, 400, 'uninitialized projectPath must fail loud with 400');
      const body = JSON.parse(res.payload);
      assert.ok(body.error, 'response must include error message');
      assert.equal(body.targets, undefined, 'must not return host health targets');
    } finally {
      await rm(uninitDir, { recursive: true, force: true });
    }
  });

  it('POST rejects explicit invalid projectPath instead of mutating host capabilities (#1049 regression)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent-hooks/sync',
      headers: SESSION_HEADERS,
      payload: { projectPath: '/nonexistent/sync/target' },
    });
    assert.equal(res.statusCode, 400, 'invalid projectPath must fail loud with 400');
    const body = JSON.parse(res.payload);
    assert.ok(body.error, 'response must include error message');
    assert.equal(body.targets, undefined, 'must not return sync results');
  });

  it('POST rejects explicit uninitialized projectPath instead of mutating host capabilities', async () => {
    const uninitDir = await mkdtemp(join(tmpdir(), 'agent-hooks-uninit-sync-'));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agent-hooks/sync',
        headers: SESSION_HEADERS,
        payload: { projectPath: uninitDir },
      });
      assert.equal(res.statusCode, 400, 'uninitialized projectPath must fail loud with 400');
      const body = JSON.parse(res.payload);
      assert.ok(body.error, 'response must include error message');
      assert.equal(body.targets, undefined, 'must not return sync results');
    } finally {
      await rm(uninitDir, { recursive: true, force: true });
    }
  });
});
