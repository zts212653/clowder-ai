import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { ExecutionAdmissionConflict } from '../dist/domains/cats/services/agents/registry/AgentServiceUnavailableError.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';
import { routingJourneyDeps } from './helpers/routing-journey-deps.js';

for (const source of ['global', 'project', 'thread-window', 'same-bytes', 'serial', 'parallel']) {
  test(`formal admission checks ${source} MCP file versions through the last asynchronous read`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/mcp-currentness');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-')),
      host = join(root, 'host'),
      project = join(root, 'project');
    mkdirSync(join(host, '.cat-cafe'), { recursive: true });
    mkdirSync(join(project, '.cat-cafe'), { recursive: true });
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_PROJECT_ALLOWED_ROOTS'];
    const old = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = host;
    process.env.CAT_CAFE_PROJECT_ALLOWED_ROOTS = root;
    const all = catRegistry.getAllConfigs(),
      catId = 'mcp-currentness',
      serverId = 'owned-mcp-source';
    catRegistry.register(catId, {
      ...all.codex,
      id: catId,
      clientId: 'acp',
      carrier: 'acp',
      mcpSupport: true,
      configurationSource: 'native_tool',
      accountRef: undefined,
      defaultModel: '',
      cli: { ...all.codex.cli, effort: '' },
    });
    t.after(() => {
      old.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, member]) => catRegistry.register(id, member));
    });
    const write = (directory, marker) =>
      writeFileSync(
        join(directory, '.cat-cafe/capabilities.json'),
        JSON.stringify({
          version: 2,
          capabilities: [
            {
              id: serverId,
              type: 'mcp',
              enabled: true,
              globalEnabled: true,
              mcpServer: { command: process.execPath, args: [`--${marker}`] },
            },
          ],
        }),
      );
    write(host, 'before');
    if (source === 'project') write(project, 'before');
    writeFileSync(
      join(host, 'cat-template.json'),
      JSON.stringify({
        breeds: [
          {
            id: 'fixture',
            variants: [
              { id: 'default', catId, acp: { command: process.execPath, startupArgs: [], mcpWhitelist: [serverId] } },
            ],
          },
        ],
      }),
    );
    let captures = 0,
      threadReads = 0;
    let sentServers,
      sessionStarts = 0,
      turnCloses = 0,
      releases = 0;
    const client = {
      async newSession(_cwd, servers) {
        sessionStarts++;
        sentServers = servers;
        return { sessionId: 'owned-mcp-version-session' };
      },
      async *promptStream() {
        yield {
          sessionId: 'owned-mcp-version-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'owned-mcp-version-reply' } },
        };
        return 'end_turn';
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const service = new AcpAgentService({
      catId,
      clientId: 'acp',
      projectRoot: host,
      mcpSupport: true,
      mcpWhitelist: [serverId],
      poolKey: { projectPath: host, providerProfile: catId },
      pool: {
        async acquire() {
          return {
            client,
            async closeTurn() {
              turnCloses++;
            },
            release() {
              releases++;
            },
          };
        },
        async releaseSession() {},
      },
    });
    const capture = service.captureInvocationOptions.bind(service);
    service.captureInvocationOptions = async (input) => {
      const result = await capture(input);
      if (++captures === 1 && source !== 'thread-window')
        write(source === 'project' ? project : host, source === 'same-bytes' ? 'before' : 'after');
      return result;
    };
    const deps = {
      apiUrl: 'http://127.0.0.1:13004',
      threadStore: {
        updateParticipantActivity() {},
        get() {
          if (++threadReads === 2 && source === 'thread-window') write(host, 'after');
          return { id: 'thread', projectPath: project, createdBy: 'owner' };
        },
      },
    };
    const prepare = () =>
      prepareInvocationExecutionBinding(deps, { catId, service, threadId: 'thread', userId: 'owner' });
    if (source === 'serial' || source === 'parallel') {
      const { deps: routing } = routingJourneyDeps(undefined, undefined, service);
      routing.services = { [catId]: service };
      Object.assign(routing.invocationDeps, deps, {
        contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
      });
      const route = source === 'serial' ? routeSerial : routeParallel;
      const messages = await Array.fromAsync(
        route(routing, [catId], 'owned MCP source task', 'owner', 'thread', { thinkingMode: 'play' }),
      );
      assert.deepEqual(
        messages.filter((message) => message.type === 'error'),
        [],
      );
      assert.ok(messages.some((message) => message.type === 'text' && message.content === 'owned-mcp-version-reply'));
      assert.equal(captures, 2);
      assert.equal(sessionStarts, 1);
      assert.equal(turnCloses, 1);
      assert.equal(releases, 1);
      assert.deepEqual(sentServers[0].args, ['--after']);
      return;
    }
    if (source === 'same-bytes') {
      const initial = await prepare();
      assert.deepEqual(initial.providerOptions.frozenAcpMcpServers[0].args, ['--before']);
      write(host, 'after');
    } else await assert.rejects(prepare(), ExecutionAdmissionConflict);
    const next = await prepare();
    assert.deepEqual(next.providerOptions.frozenAcpMcpServers[0].args, ['--after']);
    assert.equal(captures, 2);
  });
}
