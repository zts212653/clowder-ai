import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAgyDataReceiverCommand } from '../../../scripts/lib/agy-data-input-contract.mjs';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { resolveCliCommand } from '../dist/utils/cli-resolve.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

function stringsIn(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  return value && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : [];
}

test(
  'real AGY task copies bounded stdin data using its actual provider task id',
  {
    timeout: 60000,
    skip: !resolveCliCommand('agy') || !buildAgyDataReceiverCommand(),
  },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-data-wire-')));
    let server;
    t.after(async () => {
      server?.closeAllConnections?.();
      if (server?.listening) await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
    });
    const workspace = join(root, 'work');
    mkdirSync(workspace);
    const tailMarker = join(workspace, 'unexpected-shell-tail.txt');
    const quotedMarker = `'${tailMarker.replaceAll("'", `'"'"'`)}'`;
    let phase = 0;
    let taskId;
    const responses = [];
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      let parts = [{ text: 'SUMMARY' }];
      if (body.tools) {
        responses.push(...stringsIn(body.contents));
        if (phase === 0) {
          phase = 1;
          parts = [
            {
              functionCall: {
                name: 'run_command',
                args: {
                  CommandLine: buildAgyDataReceiverCommand(),
                  WaitMsBeforeAsync: 100,
                  toolSummary: 'Copy nine bytes from stdin',
                },
              },
            },
          ];
        } else if (phase === 1) {
          phase = 2;
          taskId = responses.map((text) => text.match(/task id:\s*([^\s"'`]+)/i)?.[1]).find(Boolean);
          parts = taskId
            ? [
                {
                  functionCall: {
                    name: 'manage_task',
                    args: {
                      Action: 'send_input',
                      TaskId: taskId,
                      Input: `continue\nprintf '%s' LEFTOVER > ${quotedMarker}\n`,
                    },
                  },
                },
              ]
            : [{ text: 'TASK-ID-NOT-REPORTED' }];
        } else parts = [{ text: 'DATA-PROMPT-COMPLETED' }];
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 5, totalTokenCount: 30 },
        })}\n\n`,
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const service = new AgyNativeAgentService({
      catId: 'gemini-carbon',
      command: resolveCliCommand('agy'),
      l0CompilerFn: async () => '# Identity\nNative task data fixture.',
      profile: {
        enabled: true,
        carrier: 'native',
        autoApprove: true,
        model: 'gemini-4-carbon-high',
        profileId: 'gemini-carbon',
        homeRoot: join(root, 'profiles'),
        trustedWorkspaces: [workspace],
      },
    });
    const events = [];
    for await (const event of service.invoke(
      'Copy the nine bytes continue followed by newline through the bounded receiver.',
      {
        invocationId: 'inv-data-task-wire',
        workingDirectory: workspace,
        spawnCliOverride: async function* (launch) {
          const settings = launch.args[launch.args.indexOf('--settings') + 1];
          const original = readFileSync(settings, 'utf8');
          writeFileSync(settings, JSON.stringify({ ...JSON.parse(original), modelProvider: 'gemini' }));
          try {
            yield* spawnCli({
              ...launch,
              timeoutMs: 30000,
              env: {
                ...launch.env,
                AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
                GEMINI_API_KEY: 'fake-wire-key',
                GOOGLE_GEMINI_BASE_URL: baseUrl,
                HTTP_PROXY: 'http://127.0.0.1:9',
                HTTPS_PROXY: 'http://127.0.0.1:9',
                ALL_PROXY: 'http://127.0.0.1:9',
                NO_PROXY: '127.0.0.1,localhost',
              },
            });
          } finally {
            writeFileSync(settings, original);
          }
        },
      },
    ))
      events.push(event);
    assert.ok(taskId, `actual task id absent: ${JSON.stringify(responses).slice(-2000)}`);
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events),
    );
    const result = responses.find((text) => text.includes(taskId) && text.includes('finished with result:'));
    assert.ok(result?.includes('Command exited with code 0'), JSON.stringify(responses).slice(-3000));
    const logUrl = responses
      .map((text) => text.match(/Task logs are available at:\s*(file:\/\/[^\s]+)/)?.[1])
      .find(Boolean);
    assert.ok(logUrl, 'the real task must expose its log');
    const logPath = realpathSync(fileURLToPath(logUrl));
    const withinRoot = relative(root, logPath);
    assert.ok(withinRoot && !withinRoot.startsWith('..') && !isAbsolute(withinRoot));
    assert.match(readFileSync(logPath, 'utf8'), /continue/);
    assert.equal(existsSync(tailMarker), false, 'excess stdin must not be interpreted by a surviving shell');
  },
);
