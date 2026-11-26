import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { resolveCliCommand } from '../dist/utils/cli-resolve.js';
import { spawnCli } from '../dist/utils/cli-spawn.js';

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('F325 AGY Work Parity Slice 2 — Real agy CLI Loopback Wire', () => {
  for (const variant of [
    { readOnly: false, lateUpload: false },
    { readOnly: true, lateUpload: false },
    { readOnly: false, lateUpload: true },
    { readOnly: true, lateUpload: true },
  ])
    it(
      `real agy approvals, effort and PNG supplement ${JSON.stringify(variant)}`,
      { timeout: 60000, skip: !resolveCliCommand('agy') },
      async (t) => {
        const agyBinary = resolveCliCommand('agy');
        assert.ok(agyBinary, 'real agy binary must be installed on development host');

        const raw = mkdtempSync(join(tmpdir(), 'f325-parity-s2-wire-'));
        const root = realpathSync(raw);
        let fakeGeminiServer;
        t.after(async () => {
          fakeGeminiServer?.closeAllConnections?.();
          if (fakeGeminiServer?.listening) await new Promise((done) => fakeGeminiServer.close(done));
          rmSync(root, { recursive: true, force: true });
        });
        const workspace = join(root, 'work');
        const uploadDir = join(root, 'uploads');
        const homeRoot = join(root, 'profiles');
        mkdirSync(workspace, { recursive: true });
        if (!variant.lateUpload) mkdirSync(uploadDir, { recursive: true });
        mkdirSync(homeRoot, { recursive: true });

        const midRunShot = join(uploadDir, 'midrun-shot.png');
        const imageBytes = readFileSync(new URL('../../web/public/avatars/default.png', import.meta.url));
        if (!variant.lateUpload) writeFileSync(midRunShot, imageBytes);
        const workspaceRead = join(workspace, 'readme.txt');
        writeFileSync(workspaceRead, 'WORKSPACE-READ-OK');
        const sandboxedRead = variant.readOnly || variant.lateUpload;

        const mainRequests = [];
        let mode = 'approval';
        let approvalTurnStep = 0;
        let multiTurnStep = 0;
        let triggerMidRunAppend;
        let resolveFirstModelRequest;
        const firstModelRequest = new Promise((resolve) => {
          resolveFirstModelRequest = resolve;
        });

        fakeGeminiServer = createServer(async (req, res) => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (body.tools) {
            mainRequests.push({
              url: req.url,
              thinkingConfig: body.generationConfig?.thinkingConfig,
              contentsText: JSON.stringify(body.contents ?? []),
            });
          }

          let parts = [{ text: 'SUMMARY-OK' }];
          if (body.tools && mode === 'approval') {
            if (approvalTurnStep === 0) {
              approvalTurnStep = 1;
              parts = [
                {
                  functionCall: {
                    name: 'write_file',
                    args: {
                      Path: join(workspace, 'human-approved.txt'),
                      Content: 'APPROVED-BY-operator',
                      Overwrite: true,
                    },
                  },
                },
                {
                  functionCall: {
                    name: 'run_command',
                    args: {
                      CommandLine: `touch ${JSON.stringify(join(workspace, 'declined-command-ran.txt'))}`,
                      WaitMsBeforeAsync: 5000,
                      toolSummary: 'Declined command',
                    },
                  },
                },
              ];
            } else {
              parts = [{ text: 'APPROVAL-TURN-COMPLETED-CLEANLY' }];
            }
          } else if (body.tools && mode === 'effort-and-supplement') {
            if (multiTurnStep === 0) {
              resolveFirstModelRequest();
              multiTurnStep = 1;
              await triggerMidRunAppend?.();
              parts = [
                {
                  functionCall: {
                    name: sandboxedRead ? 'read_file' : 'run_command',
                    args: sandboxedRead
                      ? { Path: workspaceRead }
                      : {
                          CommandLine: 'rg --version',
                          WaitMsBeforeAsync: 5000,
                          toolSummary: 'Check rg availability',
                        },
                  },
                },
              ];
            } else if (multiTurnStep === 1) {
              multiTurnStep = 2;
              parts = [{ text: 'FIRST-TURN-WITH-RG-OK' }];
            } else if (multiTurnStep === 2) {
              multiTurnStep = 3;
              parts = [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { Path: midRunShot },
                  },
                },
              ];
            } else {
              parts = [{ text: 'SECOND-TURN-READ-UPLOAD-OK' }];
            }
          }

          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(
            `data: ${JSON.stringify({
              candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
              usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 5, totalTokenCount: 30 },
            })}\n\n`,
          );
        });
        fakeGeminiServer.listen(0, '127.0.0.1');
        await once(fakeGeminiServer, 'listening');
        const geminiBaseUrl = `http://127.0.0.1:${fakeGeminiServer.address().port}`;

        const withSyntheticUpstream = (launch) => {
          const settingsIdx = launch.args.indexOf('--settings');
          const settingsFile = settingsIdx >= 0 ? launch.args[settingsIdx + 1] : null;
          assert.ok(settingsFile, 'must pass explicit per-run --settings');
          const original = readFileSync(settingsFile, 'utf8');
          writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(original), modelProvider: 'gemini' }), 'utf8');
          return (async function* () {
            try {
              const stream = spawnCli({
                ...launch,
                timeoutMs: 30_000,
                env: {
                  ...launch.env,
                  AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
                  GEMINI_API_KEY: 'fake-wire-key',
                  GOOGLE_GEMINI_BASE_URL: geminiBaseUrl,
                  HTTP_PROXY: 'http://127.0.0.1:9',
                  HTTPS_PROXY: 'http://127.0.0.1:9',
                  ALL_PROXY: 'http://127.0.0.1:9',
                  NO_PROXY: '127.0.0.1,localhost',
                },
              });
              for await (const event of stream) {
                // Exercise the valid ordering where the model request precedes Host init consumption.
                if (mode === 'effort-and-supplement' && event?.event === 'init') await firstModelRequest;
                yield event;
              }
            } finally {
              writeFileSync(settingsFile, original, 'utf8');
            }
          })();
        };

        const frozenL0 = '## 1. 身份\n你是 暹罗猫/碳碳·烁烁。\n## 3. 家规\n实事求是。\n';

        // Part A: autoApprove=false with RuntimeInteractionPort — approves write_file, declines run_command
        const approvalRequests = [];
        const reviewService = new AgyNativeAgentService({
          catId: 'gemini-carbon',
          profile: {
            enabled: true,
            carrier: 'native',
            autoApprove: false,
            model: 'gemini-4-carbon-high',
            profileId: 'gemini-carbon',
            homeRoot,
            trustedWorkspaces: [workspace],
          },
          command: agyBinary,
          l0CompilerFn: async () => frozenL0,
        });

        const reviewMsgs = await collect(
          reviewService.invoke('write a file and run a command', {
            invocationId: 'inv-wire-review',
            workingDirectory: workspace,
            auditContext: {
              invocationId: 'inv-wire-review',
              threadId: 'thread-wire',
              catId: 'gemini-carbon',
              userId: 'user-1',
            },
            runtimeInteractionPort: {
              async request(req) {
                approvalRequests.push(req);
                const isWrite = req.title.includes('write_file');
                return { kind: 'decision', decisionId: isWrite ? 'allow_once' : 'reject_once' };
              },
            },
            spawnCliOverride: withSyntheticUpstream,
          }),
        );
        assert.equal(approvalRequests.length, 2, 'both write_file and run_command must hit RuntimeInteractionPort');
        assert.equal(existsSync(join(workspace, 'human-approved.txt')), true, 'approved write_file must succeed');
        assert.equal(readFileSync(join(workspace, 'human-approved.txt'), 'utf8'), 'APPROVED-BY-operator');
        assert.equal(
          existsSync(join(workspace, 'declined-command-ran.txt')),
          false,
          'declined run_command must produce no side effect',
        );
        assert.equal(
          reviewMsgs.some((m) => m.type === 'error'),
          false,
          `declined tool pre-execution refusal must not fail completed reply: ${JSON.stringify(reviewMsgs)}`,
        );
        assert.ok(
          reviewMsgs.some((m) => m.type === 'text' && String(m.content).includes('APPROVAL-TURN-COMPLETED-CLEANLY')),
        );

        // Part B: --effort low + sanitized PATH (rg --version) + mid-run image supplement in uploadDir
        assert.equal(existsSync(uploadDir), !variant.lateUpload, 'first-upload directory must be absent before launch');
        mode = 'effort-and-supplement';
        mainRequests.length = 0;
        const autoService = new AgyNativeAgentService({
          catId: 'gemini-carbon',
          profile: {
            enabled: true,
            carrier: 'native',
            autoApprove: !sandboxedRead,
            model: 'gemini-4-carbon-high',
            profileId: 'gemini-carbon',
            homeRoot,
            trustedWorkspaces: [workspace],
          },
          command: agyBinary,
          l0CompilerFn: async () => frozenL0,
        });

        let resolveActiveDispatcher;
        const activeDispatcherReady = new Promise((resolve) => {
          resolveActiveDispatcher = resolve;
        });
        let supplementRead = false;
        let supplementCompleted = false;
        triggerMidRunAppend = async () => {
          const activeDispatcher = await activeDispatcherReady;
          await activeDispatcher.initialInputRead;
          if (variant.lateUpload) {
            mkdirSync(uploadDir, { recursive: true });
            writeFileSync(midRunShot, imageBytes);
          }
          const dispatched = await activeDispatcher.dispatch(
            {
              deliveryId: 'wire-supp-1',
              text: 'Please also inspect this uploaded file',
              messageIds: ['msg-supp-1'],
              imagePaths: [midRunShot],
              onInputRead: async () => {
                supplementRead = true;
              },
              onInputCompleted: async (ok) => {
                supplementCompleted = ok;
              },
            },
            { expectedInvocationId: 'inv-wire-multi' },
          );
          assert.equal(dispatched.accepted, true, JSON.stringify(dispatched));
        };

        const prevPath = process.env.PATH;
        let multiMsgs;
        try {
          process.env.PATH =
            '/usr/bin:/bin:Unknown command: "bin"\n\nTo see a list of supported npm commands, run:\n  npm help';
          multiMsgs = await collect(
            autoService.invoke(sandboxedRead ? 'read workspace file' : 'check rg version', {
              invocationId: 'inv-wire-multi',
              workingDirectory: workspace,
              uploadDir,
              ...(variant.readOnly ? { toolExecutionPolicy: { mode: 'read_only' } } : {}),
              reasoningEffortOverride: 'low',
              accountEnv: { TZ: 'UTC' },
              activeRunDispatch: {
                invocationId: 'inv-wire-multi',
                register(reg) {
                  resolveActiveDispatcher(reg);
                  return () => {};
                },
              },
              spawnCliOverride: withSyntheticUpstream,
            }),
          );
        } finally {
          process.env.PATH = prevPath;
        }

        assert.equal(
          multiMsgs.some((m) => m.type === 'error'),
          false,
          `unexpected error in effort+supplement wire run: ${JSON.stringify(multiMsgs)}`,
        );
        assert.equal(mainRequests[0]?.thinkingConfig?.thinkingLevel, 'LOW');
        assert.ok(
          mainRequests.some((r) => r.contentsText.includes(sandboxedRead ? 'WORKSPACE-READ-OK' : 'ripgrep')),
          'the original permitted read must reach the model before the attachment turn',
        );
        assert.ok(
          mainRequests.some(
            (r) => r.contentsText.includes('image/png') && r.contentsText.includes(imageBytes.toString('base64')),
          ),
          'mid-run PNG bytes must reach the actual model wire after read_file without CLI restart',
        );
        assert.equal(supplementRead, true);
        assert.equal(supplementCompleted, true);
      },
    );
});
