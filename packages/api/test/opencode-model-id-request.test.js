import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  generateOpenCodeRuntimeConfig,
  OC_API_KEY_ENV,
  OC_BASE_URL_ENV,
} from '../dist/domains/cats/services/agents/providers/opencode-config-template.js';

const requiredOpenCodeVersion = '1.18.9';

function resolveOpenCodeExecutable() {
  if (process.platform !== 'win32') return 'opencode';
  const result = spawnSync('where.exe', ['opencode.cmd'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const commandShim = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!commandShim) return null;
  const executable = join(dirname(commandShim), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return existsSync(executable) ? executable : null;
}

const openCodeExecutable = resolveOpenCodeExecutable();
const openCodeVersion = installedOpenCodeVersion();

function installedOpenCodeVersion() {
  if (!openCodeExecutable) return null;
  const result = spawnSync(openCodeExecutable, ['--version'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function startOpenCode(args, options) {
  const child = spawn(openCodeExecutable, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const completed = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      reject(error);
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, completed, output: () => ({ stdout, stderr }) };
}

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), milliseconds).unref();
  });
}

test(
  'OpenCode v1.18.9 sends the configured upstream model id',
  { skip: openCodeVersion === null, timeout: 40_000 },
  async () => {
    assert.equal(
      openCodeVersion,
      requiredOpenCodeVersion,
      'OpenCode schema baseline changed; revalidate model id routing',
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-model-id-'));
    const gitInit = spawnSync('git', ['init', '--quiet', tempRoot], { encoding: 'utf8' });
    assert.equal(gitInit.status, 0, gitInit.stderr);
    let openCodeProcess;
    let captureResolve;
    const captured = new Promise((resolve) => {
      captureResolve = resolve;
    });
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const capturedRequest = {
          method: request.method,
          url: request.url,
          body: JSON.parse(body),
        };
        captureResolve(capturedRequest);
        response.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ error: { message: 'request captured' } }));
      });
    });

    try {
      const address = await listen(server);
      assert.equal(typeof address, 'object');
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const config = generateOpenCodeRuntimeConfig({
        providerName: 'kitcoding',
        models: ['kitcoding/kimi-code/k3'],
        defaultModel: 'kitcoding/kimi-code/k3',
        apiType: 'openai',
        hasBaseUrl: true,
        modelAliases: { 'kimi-code/k3': 'kimi-k3' },
      });
      const configPath = join(tempRoot, 'opencode.json');
      writeFileSync(configPath, JSON.stringify(config), 'utf8');

      openCodeProcess = startOpenCode(
        [
          'run',
          '--pure',
          '--print-logs',
          '--log-level',
          'DEBUG',
          '--format',
          'json',
          '--model',
          'kitcoding/kimi-code/k3',
          'Reply with OK only.',
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(tempRoot, 'xdg'),
            XDG_DATA_HOME: join(tempRoot, 'data'),
            XDG_STATE_HOME: join(tempRoot, 'state'),
            XDG_CACHE_HOME: join(tempRoot, 'cache'),
            OPENCODE_CONFIG: configPath,
            [OC_API_KEY_ENV]: 'test-key',
            [OC_BASE_URL_ENV]: baseUrl,
          },
        },
      );
      const outcome = await Promise.race([
        captured.then((request) => ({ request })),
        openCodeProcess.completed.then((result) => ({ result })),
        timeoutAfter(20_000, () => `OpenCode did not send a request: ${JSON.stringify(openCodeProcess.output())}`),
      ]);
      assert.ok(
        outcome.request,
        `OpenCode exited before sending a request: ${JSON.stringify(outcome.result ?? openCodeProcess.output())}`,
      );
      const capturedRequest = outcome.request;

      assert.equal(capturedRequest.method, 'POST');
      assert.equal(capturedRequest.url, '/v1/chat/completions');
      assert.equal(capturedRequest.body.model, 'kimi-k3');
    } finally {
      if (openCodeProcess?.child.exitCode === null) openCodeProcess.child.kill();
      if (openCodeProcess) {
        await Promise.race([
          openCodeProcess.completed,
          timeoutAfter(5_000, 'OpenCode did not terminate after capture'),
        ]);
      }
      server.closeAllConnections?.();
      await close(server);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
