import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  computeKimiL0Fingerprint,
  lookupKimiL0Fingerprint,
  recordKimiL0Fingerprint,
} from '../dist/domains/cats/services/agents/providers/kimi-l0-session-fingerprint.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createAgentAdapterNativeProcess } from '../dist/domains/plugin/declared/agent-adapter-native-process.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_KIMI_CANDIDATE_ARCHIVE;
const executable = process.env.CLOWDER_KIMI_CANDIDATE_EXECUTABLE;
const legacyL0 = 'CUTOVER_LEGACY_KIMI_SYSTEM';
const updatedL0 = 'CUTOVER_UPDATED_KIMI_SYSTEM';

test(
  'the independent Kimi archive resumes a real CLI session and uses edited L0 on a fresh session',
  {
    skip: !archive || !executable,
    timeout: 60_000,
  },
  async (t) => {
    assert.ok(isAbsolute(archive) && isAbsolute(executable));
    const ref = { pluginId: 'official.agent-kimi', contributionId: 'kimi' };
    const registry = new SessionImplementationRegistry();
    let approvedDigest;
    let legacySession;
    const { runtime, manager } = await setup(t, registry, (request) => {
      if (
        request.pluginId !== ref.pluginId ||
        request.contributionId !== ref.contributionId ||
        request.packageDigest !== approvedDigest ||
        request.catId !== 'fixture'
      )
        return;
      assert.equal(request.hostSession?.cwd, root);
      if (request.action === 'openSession')
        return {
          async prepare(input) {
            if (input.resumeNativeSessionId) {
              assert.equal(input.resumeNativeSessionId, legacySession);
              return {
                nativeSessionId: legacySession,
                sessionFingerprint: lookupKimiL0Fingerprint(home, 'fixture', legacySession),
              };
            }
            assert.equal(input.instructions, updatedL0);
            return { agentFile: await agentFile('updated', input.instructions) };
          },
        };
      if (request.action === 'startTurn')
        return {
          async recordSessionFingerprint(input) {
            recordKimiL0Fingerprint(home, 'fixture', input.nativeSessionId, input.fingerprint);
          },
          run: createAgentAdapterNativeProcess(({ args }) => ({
            command: executable,
            args,
            cwd: root,
            env: isolatedEnvironment,
            bindExecutionOwner: false,
            timeoutMs: 15_000,
          })),
        };
    });
    const root = runtime.projectRoot;
    const home = join(root, 'kimi');
    const isolatedEnvironment = {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      KIMI_CODE_HOME: home,
      KIMI_CODE_EXPERIMENTAL_FLAG: '1',
      TEMP: root,
      TMP: root,
    };
    await mkdir(home);
    const requests = [];
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      let raw = '';
      for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/v1/messages');
      requests.push(body);
      const id = 'cutover-' + requests.length;
      const events = [
        {
          type: 'message_start',
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: body.model,
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: id } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    server.listen(0, '127.0.0.1');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    await once(server, 'listening');
    await writeFile(
      join(home, 'config.toml'),
      [
        'default_model = "fixture-model"',
        '[providers.fixture]',
        'type = "kimi"',
        `base_url = "http://127.0.0.1:${server.address().port}"`,
        'api_key = "local-fixture-only"',
        '[models.fixture-model]',
        'provider = "fixture"',
        'model = "fixture-model"',
        'protocol = "anthropic"',
        'capabilities = []',
        'max_context_size = 8000',
        'max_output_size = 128',
        '',
      ].join('\n'),
    );
    async function agentFile(name, instructions) {
      const file = join(root, name + '.md');
      await writeFile(
        file,
        `---\nname: cutover-fixture-agent\ndescription: Isolated native role\n---\n\n${instructions}\n`,
      );
      return file;
    }
    async function startCli(args, signal) {
      const { stdout } = await promisify(execFile)(executable, args, {
        cwd: root,
        signal,
        timeout: 15_000,
        windowsHide: true,
        env: isolatedEnvironment,
      });
      return stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    }

    const originalAgent = await agentFile('legacy', legacyL0);
    const original = await startCli([
      '--output-format',
      'stream-json',
      '--agent-file',
      originalAgent,
      '-p',
      'Start legacy chat',
    ]);
    legacySession = original.find((event) => event.type === 'session.resume_hint')?.session_id;
    assert.ok(legacySession);
    recordKimiL0Fingerprint(home, 'fixture', legacySession, computeKimiL0Fingerprint(legacyL0));
    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    approvedDigest = plugin.packageDigest;
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const continued = await Array.fromAsync(
      service.invoke('Continue legacy chat', {
        hostSessionId: 'legacy-host',
        sessionId: legacySession,
        invocationId: 'legacy-continue',
        systemPrompt: legacyL0,
        workingDirectory: root,
      }),
    );
    assert.equal(continued.find((event) => event.type === 'text')?.content, 'cutover-2');
    assert.equal(continued.at(-1)?.metadata.sessionId, legacySession);
    assert.equal(continued.at(-1)?.errorCode, undefined);

    // The active Host service revalidates a different compiled role.
    const edited = {
      hostSessionId: 'legacy-host',
      sessionId: legacySession,
      systemPrompt: updatedL0,
      workingDirectory: root,
    };
    const exact = await Array.fromAsync(
      service.invoke('Require stale native chat', { ...edited, invocationId: 'exact-old', requireExactResume: true }),
    );
    assert.equal(exact.at(-1)?.errorCode, 'resume_unavailable');
    assert.equal(requests.length, 2);
    const fresh = await Array.fromAsync(
      service.invoke('Start a new chat', { ...edited, invocationId: 'new-role-turn' }),
    );
    assert.equal(fresh.find((event) => event.type === 'text')?.content, 'cutover-3');
    assert.ok(fresh.at(-1)?.metadata.sessionId);
    assert.notEqual(fresh.at(-1)?.metadata.sessionId, legacySession);
    assert.equal(fresh.at(-1)?.errorCode, undefined);
    const notice = fresh.find((event) => event.type === 'system_info')?.content;
    assert.ok(notice);
    assert.deepEqual(JSON.parse(notice), {
      type: 'l0_resume_fresh_start',
      previousSessionId: legacySession,
      reason: 'stale',
    });
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[1].system), new RegExp(legacyL0));
    assert.doesNotMatch(JSON.stringify(requests[1].system), new RegExp(updatedL0));
    assert.match(JSON.stringify(requests[1].messages), /cutover-1/);
    assert.match(JSON.stringify(requests[2].system), new RegExp(updatedL0));
    assert.doesNotMatch(JSON.stringify(requests[2].messages), new RegExp(updatedL0));
    assert.doesNotMatch(JSON.stringify(requests[2].messages), /cutover-1/);
    assert.equal(
      lookupKimiL0Fingerprint(home, 'fixture', fresh.at(-1).metadata.sessionId),
      computeKimiL0Fingerprint(updatedL0),
    );
    assert.equal(lookupKimiL0Fingerprint(home, 'fixture', legacySession), computeKimiL0Fingerprint(legacyL0));
    t.diagnostic(
      'Same identity resumed with history. Exact stale resume was blocked. Ordinary stale resume opened a new native session with a notice.',
    );
  },
);
