import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readCodexLaunchProjection } from '../config/codex-launch-config.js';
import { buildChildEnv } from '../utils/cli-spawn.js';
import { resolveWindowsSpawnPlan } from '../utils/cli-spawn-win.js';
import { parseCodexModels, type RuntimeModelCatalog, record, rows } from './runtime-model-catalog.js';

/** Native inspection commands avoid App Server startup and its persistent history backfill. */
async function inspectCodex(command: string, args: string[], cwd: string, timeout: number) {
  const plan = process.platform === 'win32' ? resolveWindowsSpawnPlan(command, args) : { command, args };
  return new Promise<{ output: string; errorOutput: string; code: string | number | undefined; failed: boolean }>(
    (resolve) => {
      execFile(
        plan.command,
        plan.args,
        {
          cwd,
          env: buildChildEnv(undefined, { workingDirectory: cwd }),
          shell: 'shell' in plan ? plan.shell : false,
          windowsHide: true,
          timeout,
          maxBuffer: 4_000_000,
          encoding: 'utf8',
        },
        (error, output, errorOutput) =>
          resolve({ output, errorOutput, code: error?.code ?? undefined, failed: Boolean(error) }),
      );
    },
  );
}

/** Login evidence only; unknown output/errors never become a successful login. */
export async function probeCodexLogin(command: string, cwd: string): Promise<unknown> {
  const result = await inspectCodex(command, ['login', 'status'], cwd, 6_000);
  const output = `${result.output}\n${result.errorOutput}`.trim();
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  if (!result.failed && lines.some((line) => /^Logged in using ChatGPT(?:\s|$)/.test(line)))
    return { account: { type: 'chatgpt' } };
  if (!result.failed && lines.some((line) => /^Logged in using an API key(?:\s|$)/.test(line)))
    return { account: { type: 'apiKey' } };
  if (result.code === 1 && output === 'Not logged in') {
    const requiresOpenaiAuth = nativeProviderRequiresOpenaiAuth(cwd);
    return requiresOpenaiAuth === undefined ? null : { account: null, requiresOpenaiAuth };
  }
  return null;
}

/** A third-party native provider can use its own token without a ChatGPT/OpenAI login. */
function nativeProviderRequiresOpenaiAuth(cwd: string): boolean | undefined {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const { config, requirements } = readCodexLaunchProjection(home, cwd);
  const id = String(requirements.model_provider ?? config.model_provider ?? 'openai');
  const managed = record(record(requirements.model_providers)[id]).requires_openai_auth;
  if (typeof managed === 'boolean') return managed;
  // User definitions cannot replace the native built-in provider's authentication policy.
  if (id === 'openai' || id === 'openai_https') return true;
  const declared = record(record(config.model_providers)[id]).requires_openai_auth;
  return typeof declared === 'boolean' ? declared : undefined;
}

/** The CLI owns catalog refresh/cache/provider selection; no agent session or prompt is created. */
export async function probeCodexCatalog(command: string, args: string[], cwd: string): Promise<RuntimeModelCatalog> {
  const result = await inspectCodex(command, [...args, 'debug', 'models'], cwd, 20_000);
  if (result.failed) throw new Error('catalog_unavailable');
  const raw: unknown = JSON.parse(result.output);
  // Project only selectable model/effort metadata; raw catalog entries also contain native instructions.
  const models = parseCodexModels({
    data: rows(record(raw).models).map((item) => ({
      model: item.slug,
      displayName: item.display_name,
      description: item.description,
      hidden: item.visibility !== 'list',
      ...(Array.isArray(item.supported_reasoning_levels)
        ? {
            supportedReasoningEfforts: rows(item.supported_reasoning_levels).map((level) => ({
              reasoningEffort: level.effort,
              description: level.description,
            })),
          }
        : {}),
    })),
  });
  return { status: models.length ? 'live' : 'unavailable', models };
}
