import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { materializeAgyNativeAgentFile } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-agent-file.js';
import { materializeAgyNativeEffectGuard } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-effect-guard.js';
import { buildAgyNativePolicy } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-policy.js';
import { materializeAgyNativeSettings } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-settings.js';

// Test-only Gemini API backend. OAuth admission and billing are unchanged and
// separately covered by the production launch tests; no real account is loaded.
const available = spawnSync('which', ['agy'], { timeout: 5000 }).status === 0;
for (const contaminated of [false, true])
  test(
    `installed AGY ${contaminated ? 'blocks write content before projection' : 'executes clean write'}`,
    {
      timeout: 35000,
      skip: !available,
    },
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'secret-agy-')));
      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true });
      await mkdir(join(home, '.gemini/config'), { recursive: true });
      await mkdir(workspace);
      const target = join(workspace, 'effect.txt');
      const fake = ['ghp', '_', 'V'.repeat(36)].join('');
      const policy = buildAgyNativePolicy({ workspaceRoot: workspace, autoApprove: true });
      const settingsPath = materializeAgyNativeSettings({ profileHome: home, model: 'gemini-2.5-flash', policy });
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      await writeFile(settingsPath, JSON.stringify({ ...settings, modelProvider: 'gemini' }));
      const { agentName } = materializeAgyNativeAgentFile({
        profileHome: home,
        catId: 'gemini-argon',
        systemPrompt: '# Identity\nPerform the local fixture action.\n',
        autoApprove: true,
        tools: ['write_to_file'],
      });
      materializeAgyNativeEffectGuard({
        profileHome: home,
        runtimeRoot: resolve(import.meta.dirname, '../../..'),
        readOnly: false,
      });
      let calls = 0;
      const paths: string[] = [];
      const replies: string[] = [];
      const toolNames: string[] = [];
      const api = createServer(async (req, res) => {
        paths.push(req.url ?? '');
        let raw = '';
        for await (const chunk of req) raw += chunk;
        if (!req.url?.includes('GenerateContent')) {
          res.setHeader('content-type', 'application/json');
          res.end('{}');
          return;
        }
        const input = JSON.parse(raw);
        const names: string[] = (input.tools ?? []).flatMap(
          (group: { functionDeclarations?: Array<{ name: string }> }) =>
            group.functionDeclarations?.map((tool) => tool.name) ?? [],
        );
        toolNames.push(...names);
        replies.push(JSON.stringify(input.contents?.slice(-1) ?? []));
        const parts =
          names.includes('write_to_file') && ++calls === 1
            ? [
                {
                  functionCall: {
                    name: 'write_to_file',
                    args: {
                      TargetFile: target,
                      CodeContent: contaminated ? fake : 'clean fixture',
                      Description: 'Write local fixture',
                      Overwrite: true,
                    },
                  },
                },
              ]
            : [{ text: 'Completed.' }];
        const reply = {
          candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(reply)}\n\n`);
      });
      await new Promise<void>((done) => api.listen(0, '127.0.0.1', done));
      const address = api.address();
      assert.ok(address && typeof address !== 'string');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      let stderr = '';
      try {
        const child = spawn(
          'agy',
          [
            '-p',
            'Perform the local fixture action.',
            '--output-format',
            'stream-json',
            '--agent',
            agentName,
            '--dangerously-skip-permissions',
            `--gemini_dir=${join(home, '.gemini')}`,
          ],
          {
            cwd: workspace,
            signal: controller.signal,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              GEMINI_API_KEY: 'fixture-only',
              GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
              NO_PROXY: '127.0.0.1,localhost',
              no_proxy: '127.0.0.1,localhost',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.stdout.resume();
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const code = await new Promise((done, fail) => {
          child.on('close', done);
          child.on('error', fail);
        });
        assert.equal(code, 0, `paths=${JSON.stringify(paths)}; ${stderr.slice(-2000)}`);
        assert.ok(
          calls >= 2,
          `actual native tool result must return to the local model backend; tools=${JSON.stringify([...new Set(toolNames)])}`,
        );
        if (contaminated) {
          await assert.rejects(readFile(target));
          assert.match(replies.slice(1).join('\n'), /secret_content_blocked_before_send/);
        } else
          assert.equal(
            await readFile(target, 'utf8').catch(() => undefined),
            'clean fixture\n',
            JSON.stringify(replies),
          );
      } finally {
        clearTimeout(timeout);
        api.closeAllConnections();
        await new Promise<void>((done) => api.close(() => done()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
