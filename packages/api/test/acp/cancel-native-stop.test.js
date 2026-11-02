import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpProcessPool } from '../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js';
import { AgentSessionBridgeService } from '../../dist/domains/cats/services/agents/session-contract/AgentSessionBridgeService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { deferred } from '../agent-session-contract/fake-session-provider.js';

for (const { closeFails, consumerReturn } of [
  { closeFails: false, consumerReturn: false },
  { closeFails: true, consumerReturn: false },
  { closeFails: false, consumerReturn: true },
])
  test(
    `owned single-flight retirement; close failure=${closeFails}, consumer return=${consumerReturn}`,
    { timeout: 15000 },
    async (t) => {
      const parent = resolve('artifacts/role-agent-refactor/native-cancel-stop');
      mkdirSync(parent, { recursive: true });
      const root = mkdtempSync(join(parent, 'owned native state '));
      const fixture = fileURLToPath(new URL('../fixtures/codeagent-mock.mjs', import.meta.url));
      const stop = deferred(),
        closing = deferred();
      const client = new AcpClient({
        command: process.execPath,
        args: [fixture, '--acp', '--state-dir', root],
        cwd: root,
        inheritParentEnv: false,
        env: { HOME: root, USERPROFILE: root },
      });
      const close = client.close.bind(client);
      client.close = async () => {
        closing.resolve();
        await stop.promise;
        if (closeFails) throw new Error('owned retirement failure');
        await close();
      };
      const pool = new AcpProcessPool({ maxLiveProcesses: 1 }, { supportsMultiplexing: false }, () => client);
      const acquire = pool.acquire.bind(pool);
      let ownedLease;
      pool.acquire = async (...args) => {
        ownedLease = await acquire(...args);
        return ownedLease;
      };
      const catId = 'mock-native-stop';
      const service = new AcpAgentService({
        catId,
        clientId: 'acp',
        pool,
        poolKey: { projectPath: root, providerProfile: catId },
        projectRoot: root,
        mcpServers: [],
        mcpSupport: false,
        modelName: '',
        providerName: 'codeagent-mock',
      });
      const provider = new AcpSessionProvider({ catId, service });
      const bridge = new AgentSessionBridgeService({
        catId,
        provider,
        passHostOptions: true,
        resolveHostSession: () => ({ sessionId: 'owned-host-session' }),
      });
      const controller = new AbortController();
      let nativePid;
      const instance = {
        task: 'role-agent-refactor-20261029-gpt-sol',
        owner: 'codex',
        mock: true,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        runtimeModules: ['AcpAgentService.js', 'AcpProcessPool.js'].map((name) => ({
          name,
          sha256: createHash('sha256')
            .update(
              readFileSync(
                fileURLToPath(
                  new URL(`../../dist/domains/cats/services/agents/providers/acp/${name}`, import.meta.url),
                ),
              ),
            )
            .digest('hex'),
        })),
        executable: process.execPath,
        executableSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),
        fixture,
        fixtureSha256: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
        nativeHome: root,
        dataDirectory: root,
        ports: [],
        networkUsed: false,
        nativeCredentialsUsed: false,
        retention: 'current cancellation contract evidence',
        startedAt: new Date().toISOString(),
      };
      writeFileSync(join(root, 'instance.json'), JSON.stringify({ ...instance, status: 'starting' }, null, 2));
      t.after(async () => {
        controller.abort();
        stop.resolve();
        if (closeFails) await assert.rejects(pool.closeAll(), /owned retirement failure/);
        else await pool.closeAll();
        await close();
        writeFileSync(
          join(root, 'instance.json'),
          JSON.stringify(
            {
              ...instance,
              pid: nativePid,
              status: 'closed-data-retained',
              running: client.isAlive,
              stoppedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
        assert.equal(client.isAlive, false);
      });
      const iterator = (consumerReturn ? service : bridge)
        .invoke('#wait', { invocationId: 'owned-stop-invocation', signal: controller.signal, workingDirectory: root })
        [Symbol.asyncIterator]();
      while (true) {
        const event = await iterator.next();
        assert.equal(event.done, false, JSON.stringify(event.value));
        if (event.value.type === 'text' && event.value.content === 'waiting') break;
      }
      nativePid = client.pid;
      writeFileSync(
        join(root, 'instance.json'),
        JSON.stringify({ ...instance, pid: nativePid, status: 'running' }, null, 2),
      );
      let terminalPublished = false;
      const completion = (consumerReturn ? iterator.return() : iterator.next()).then((event) => {
        terminalPublished = true;
        return event;
      });
      if (!consumerReturn) controller.abort();
      await Promise.race([
        closing.promise,
        completion.then(() => assert.fail('the active native prompt must stop before consumer completion')),
      ]);
      let repeatedReleaseSettled = false;
      const repeatedRelease = ownedLease.release();
      void repeatedRelease.then(
        () => {
          repeatedReleaseSettled = true;
        },
        () => {
          repeatedReleaseSettled = true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(client.isAlive, true, 'the real mock process has not been stopped yet');
      assert.equal(client.isSafeForSingleFlightReuse, false, 'no provider stop receipt was observed');
      assert.equal(terminalPublished, false, 'a queued physical retirement is not a completed stop');
      assert.equal(repeatedReleaseSettled, false, 'another release caller must share the physical stop fence');
      stop.resolve();
      const terminal = await completion;
      assert.equal(terminal.done, consumerReturn);
      if (!consumerReturn) {
        assert.equal(terminal.value.type, 'done');
        assert.equal(terminal.value.errorCode, closeFails ? 'session_contract_failed' : 'cancelled');
      }
      if (closeFails) await assert.rejects(repeatedRelease, /owned retirement failure/);
      else await repeatedRelease;
      assert.equal(client.isAlive, closeFails);
      assert.equal((await iterator.next()).done, true);
      if (closeFails) {
        const next = [];
        for await (const event of bridge.invoke('second', { invocationId: 'second', workingDirectory: root }))
          next.push(event);
        assert.equal(next[0].errorCode, 'busy', 'failed retirement does not authorize another native turn');
      }
    },
  );
