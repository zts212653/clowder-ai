import { extname } from 'node:path';
import { z } from 'zod';
import { execute, poll, scrubCredentials, submit } from '../protocol-engine/engine.js';
import type { AuthType, ExecutionParams, ProtocolTemplate, ProviderInstance } from '../protocol-engine/types.js';
import { callbackPost, getCallbackConfig } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';
import { errorResult, successResult } from './file-tools.js';

export interface ProtocolToolConfig {
  prefix: string;
  provider: ProviderInstance;
  template: ProtocolTemplate;
  credentials: Record<string, string>;
}

/** Extra context the MCP SDK passes to tool handlers (e.g. abort signal). */
export interface ToolExtra {
  signal?: AbortSignal;
}

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never, extra?: ToolExtra) => Promise<ToolResult>;
};

function buildParams(config: ProtocolToolConfig, capability: string, vars: Record<string, string>): ExecutionParams {
  return {
    provider: config.provider,
    capability,
    credentials: config.credentials,
    vars,
  };
}

function createSubmitTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_submit`,
    description:
      `Submit an async ${config.template.name} task. ` +
      `Capabilities: ${capabilities.join(', ')}. ` +
      `Returns taskId for polling with ${config.prefix}_poll. Template vars depend on capability ` +
      `(e.g. text2video: prompt; image2video: prompt + imageUrl). ` +
      `After poll succeeds the tool best-effort auto-emits a kind:"file" rich block so the media renders inline ` +
      `when callback credentials are available; for manual rendering prefer kind:"file" (see poll tool description).`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Capability to invoke'),
      vars: z.record(z.string()).describe('Template variables (prompt, imageUrl, etc.)'),
    },
    handler: (async (input: { capability: string; vars: Record<string, string> }, extra?: ToolExtra) => {
      try {
        const result = await submit(config.template, buildParams(config, input.capability, input.vars), extra?.signal);
        return successResult(JSON.stringify({ taskId: result.taskId, status: result.status }));
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return errorResult(`Submit failed: ${scrubCredentials(raw, config.credentials)}`);
      }
    }) as (args: never, extra?: ToolExtra) => Promise<ToolResult>,
  };
}

/** Known media extensions → mimeType. */
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/** True when the capability's OUTPUT is an image (not when image is an input). Exported for testing. */
export function isImageOutputCapability(capability?: string): boolean {
  if (!capability) return false;
  // text2image, img2img → image output. image2video → video output.
  return capability.endsWith('image') || capability === 'img2img';
}

/** Exported for testing. */
export function deriveMimeType(url: string, capability?: string): string {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (ext in MEDIA_MIME) return MEDIA_MIME[ext]!;
  } catch {
    /* not a valid URL */
  }
  // Infer from capability output type when URL has no recognizable extension.
  return isImageOutputCapability(capability) ? 'image/png' : 'video/mp4';
}

/** Exported for testing. */
export function deriveFileName(url: string, prefix: string, taskId: string, capability?: string): string {
  try {
    const basename = new URL(url).pathname.split('/').pop();
    if (basename?.includes('.')) return basename;
  } catch {
    /* fallback */
  }
  const ext = isImageOutputCapability(capability) ? '.png' : '.mp4';
  return `${prefix}_${taskId}${ext}`;
}

/**
 * Best-effort: create a RichFileBlock via callback API so the media renders
 * inline in chat. Returns true if the block was emitted, false otherwise.
 * Poll result is returned regardless of emission success.
 */
async function emitMediaRichBlock(url: string, prefix: string, taskId: string, capability?: string): Promise<boolean> {
  if (!getCallbackConfig()) return false; // no credentials — skip silently
  const block = {
    id: `protocol-media-${prefix}-${taskId}`,
    kind: 'file',
    v: 1,
    url,
    fileName: deriveFileName(url, prefix, taskId, capability),
    mimeType: deriveMimeType(url, capability),
  };
  // Server expects `block` as an object, not a JSON string.
  const result = await callbackPost('/api/callbacks/create-rich-block', { block });
  return !result.isError;
}

/** Signal-aware sleep: resolves after ms or when signal aborts (whichever first). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Fast path: already aborted — don't sleep at all.
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolve poll config (interval/maxAttempts) for a capability. */
function resolvePollConfig(config: ProtocolToolConfig, capability: string): { interval: number; maxAttempts: number } {
  const cap = config.template.capabilities[capability];
  const pollDef = cap?.poll ?? (cap?.inherit ? config.template.capabilities[cap.inherit]?.poll : undefined);
  return { interval: pollDef?.interval ?? 5000, maxAttempts: pollDef?.maxAttempts ?? 120 };
}

function createPollTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_poll`,
    description:
      `Poll an async ${config.template.name} task until completion. ` +
      `The tool automatically retries with provider-defined intervals until the task reaches ` +
      `a terminal state (succeeded/failed) or the maximum attempts are exhausted. ` +
      `Returns status, resultUrl (when succeeded), error (when failed), and richBlockEmitted (boolean). ` +
      `When the task succeeds, the tool best-effort auto-emits a kind:"file" rich block; ` +
      `richBlockEmitted=true means inline media is already rendered, false means you must manually ` +
      `create a rich block: prefer kind:"file" (url + fileName + mimeType). ` +
      `Do NOT just paste the URL as text — always render inline with create_rich_block.`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Original capability used for submit'),
      task_id: z.string().min(1).describe('Task ID from submit'),
    },
    handler: (async (input: { capability: string; task_id: string }, extra?: ToolExtra) => {
      try {
        const { interval, maxAttempts } = resolvePollConfig(config, input.capability);
        const params = buildParams(config, input.capability, {});
        const signal = extra?.signal;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          signal?.throwIfAborted();
          const result = await poll(config.template, params, input.task_id, signal);

          if (result.status === 'succeeded') {
            if (!result.resultUrl) {
              return errorResult('Poll succeeded but provider returned no resultUrl (malformed result).');
            }
            let richBlockEmitted = false;
            try {
              richBlockEmitted = await emitMediaRichBlock(
                result.resultUrl,
                config.prefix,
                input.task_id,
                input.capability,
              );
            } catch {
              /* best-effort */
            }
            return successResult(
              JSON.stringify(
                {
                  status: result.status,
                  resultUrl: result.resultUrl,
                  coverUrl: result.coverUrl,
                  richBlockEmitted,
                  attempt,
                },
                null,
                2,
              ),
            );
          }

          if (result.status === 'failed') {
            return successResult(JSON.stringify({ status: result.status, error: result.error, attempt }, null, 2));
          }

          // Non-terminal: signal-aware wait before next attempt (unless last attempt).
          if (attempt < maxAttempts) await sleep(interval, signal);
        }

        // Max attempts exhausted — return last known status from the final iteration.
        return errorResult(
          `Poll timed out after ${maxAttempts} attempts. Task may still be processing. ` +
            `Use ${config.prefix}_poll again to check.`,
        );
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return errorResult(`Poll failed: ${scrubCredentials(raw, config.credentials)}`);
      }
    }) as (args: never, extra?: ToolExtra) => Promise<ToolResult>,
  };
}

function createExecuteTool(config: ProtocolToolConfig, capabilities: string[]): ToolDef {
  return {
    name: `${config.prefix}_execute`,
    description:
      `Execute a sync ${config.template.name} request. ` +
      `Capabilities: ${capabilities.join(', ')}. ` +
      `Returns result directly.`,
    inputSchema: {
      capability: z.enum(capabilities as [string, ...string[]]).describe('Capability to invoke'),
      vars: z.record(z.string()).describe('Template variables (videoUrl, prompt, etc.)'),
    },
    handler: (async (input: { capability: string; vars: Record<string, string> }, extra?: ToolExtra) => {
      try {
        const result = await execute(config.template, buildParams(config, input.capability, input.vars), extra?.signal);
        return successResult(result.result);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        return errorResult(`Execute failed: ${scrubCredentials(raw, config.credentials)}`);
      }
    }) as (args: never, extra?: ToolExtra) => Promise<ToolResult>,
  };
}

export function createProtocolTools(config: ProtocolToolConfig): ToolDef[] {
  const capabilities = Object.keys(config.template.capabilities);
  if (capabilities.length === 0) return [];

  if (config.template.mode === 'async') {
    return [createSubmitTool(config, capabilities), createPollTool(config, capabilities)];
  }
  return [createExecuteTool(config, capabilities)];
}

export function buildProviderFromEnv(
  prefix: string,
  templateBaseUrl?: string,
  templateAuthType?: string,
): ProviderInstance | null {
  const provider = process.env[`${prefix}_PROVIDER`];
  const envAuthType = process.env[`${prefix}_AUTH_TYPE`];
  const authType = (envAuthType || templateAuthType || 'apikey') as AuthType;
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const model = process.env[`${prefix}_MODEL`];

  if (!provider) return null;

  const resolvedBaseUrl = baseUrl || templateBaseUrl || '';
  return {
    id: provider,
    name: provider,
    protocol: provider,
    baseUrl: resolvedBaseUrl,
    authType,
    model,
  };
}

export function buildCredentialsFromEnv(prefix: string): Record<string, string> {
  const creds: Record<string, string> = {};
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (apiKey) creds['apiKey'] = apiKey;
  const secretKey = process.env[`${prefix}_SECRET_KEY`];
  if (secretKey) creds['secretKey'] = secretKey;
  const accessKey = process.env[`${prefix}_ACCESS_KEY`];
  if (accessKey) creds['accessKey'] = accessKey;
  return creds;
}
