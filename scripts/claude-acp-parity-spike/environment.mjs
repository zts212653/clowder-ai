import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const root = resolve('.cat-cafe/tmp/claude-acp-parity');
export const upstream = join(root, 'upstream');
export const nativePath = process.env.CLOWDER_PARITY_CLAUDE_BIN;
export const baselineSdk = process.env.CLOWDER_PARITY_BASELINE_SDK;
export const matchingSdk = join(upstream, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
export const sha = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
export async function prepareEnvironment(runId) {
  if (!/^[a-z0-9-]{1,48}$/.test(runId)) throw new Error('Bad evidence ID');
  const dir = join(root, 'runs', runId);
  await mkdir(join(root, 'runs'), { recursive: true });
  await mkdir(dir); // No overwrite of failed/incomplete evidence.
  await mkdir(join(dir, 'home'));
  await mkdir(join(dir, 'fixture'));
  const settingsPath = process.env.CLOWDER_PARITY_TEST_SETTINGS;
  if (!settingsPath || !nativePath || !baselineSdk) {
    throw new Error('Set CLOWDER_PARITY_TEST_SETTINGS, CLOWDER_PARITY_CLAUDE_BIN and CLOWDER_PARITY_BASELINE_SDK for isolated parity runs');
  }
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  const auth = Object.fromEntries(
    Object.entries(settings.env ?? {}).filter(
      ([key, value]) => typeof value === 'string' && key.startsWith('ANTHROPIC_'),
    ),
  );
  const model = auth.ANTHROPIC_MODEL ?? settings.model;
  const secrets = Object.entries(auth)
    .filter(([key]) => /TOKEN|KEY|BASE_URL/i.test(key))
    .map(([, value]) => value);
  const redact = (value) => {
    let text = JSON.stringify(value);
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return JSON.parse(text);
  };
  const env = Object.fromEntries(
    [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'COMSPEC',
      'PATHEXT',
      'PROCESSOR_ARCHITECTURE',
      'NUMBER_OF_PROCESSORS',
    ]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, auth, {
    HOME: join(dir, 'home'),
    USERPROFILE: join(dir, 'home'),
    CLAUDE_CONFIG_DIR: join(dir, 'home'),
    CLAUDE_CODE_EXECUTABLE: nativePath,
    CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
    CLAUDECODE: '',
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_AGENT_ACP_PROTOCOL: 'v1',
    CLOWDER_SPIKE_PROCESS_TRACE: join(dir, 'processes.jsonl'),
  });
  if ((await sha(nativePath)) !== '295b49ec092f31a7de9c6ff286d9d8f120a4f029b9ad9a5ac0b12c35cbf4df2b')
    throw new Error('Native pin mismatch');
  const state = { dir, env, model, redact, runId };
  await writeFile(
    join(dir, 'binding.json'),
    JSON.stringify(
      {
        runId,
        model,
        nativePath,
        nativeVersion: '2.1.299',
        nativeSha256: await sha(nativePath),
        isolatedNativeRoot: env.CLAUDE_CONFIG_DIR,
        userHistoryShared: false,
        credentialSource: 'operator-provided test settings, values excluded',
        production: false,
      },
      null,
      2,
    ),
  );
  return state;
}
export async function loadBaselineLogic(dir) {
  const file = resolve('packages/api/src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts');
  const source = await readFile(file, 'utf8');
  const start = source.indexOf('function consumedClientInputIds');
  const end = source.indexOf('\n/**', start);
  const { default: ts } = await import(pathToFileURL(join(upstream, 'node_modules/typescript/lib/typescript.js')));
  const compiled = ts.transpile(`export ${source.slice(start, end)}`, {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  });
  const output = join(dir, 'baseline-consumption.mjs');
  await writeFile(output, compiled);
  return { ...(await import(pathToFileURL(output))), sourceSha256: await sha(file) };
}
