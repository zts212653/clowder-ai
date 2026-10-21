/**
 * Kimi CLI configuration, path resolution, and session utilities
 *
 * Reads config.toml / kimi.json, resolves model aliases, normalizes workdir
 * paths, and provides session/context reading helpers.
 */

import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { type KimiRuntimePaths, resolveKimiRuntimePaths } from '../../../../../utils/kimi-cli-runtime.js';

const log = createModuleLogger('kimi-config');

export const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
export const DEFAULT_KIMI_MODEL_ALIAS = 'kimi-code/kimi-for-coding';

const KIMI_CONTEXT_TAIL_BYTES = 64 * 1024;

function normalizeKimiApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === 'api.kimi.com' && /^\/coding\/?$/i.test(parsed.pathname)) {
      parsed.pathname = '/coding/v1';
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    // Fall through to raw string when baseUrl is not a fully-qualified URL.
  }
  return trimmed;
}

export interface KimiModelConfigInfo {
  defaultThinking: boolean;
  capabilities: string[];
  maxContextSize?: number;
}

export function resolveKimiShareDir(callbackEnv?: Record<string, string>, paths?: KimiRuntimePaths): string {
  return (paths ?? resolveKimiRuntimePaths(callbackEnv ?? {})).shareDir;
}

export function resolveKimiConfigPath(callbackEnv?: Record<string, string>, paths?: KimiRuntimePaths): string {
  return (paths ?? resolveKimiRuntimePaths(callbackEnv ?? {})).configPath;
}

export function normalizeKimiWorkDirPath(candidate: string): string {
  const resolved = resolve(candidate);
  try {
    return normalize(realpathSync(resolved));
  } catch {
    return normalize(resolved);
  }
}

export function readKimiModelConfigInfo(
  modelAlias: string,
  callbackEnv?: Record<string, string>,
  paths?: KimiRuntimePaths,
): KimiModelConfigInfo {
  const fallbackCapabilities: string[] =
    modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? ['thinking', 'image_in', 'video_in'] : [];
  const configPath = resolveKimiConfigPath(callbackEnv, paths);
  if (!existsSync(configPath)) {
    return {
      defaultThinking: fallbackCapabilities.includes('thinking'),
      capabilities: [...fallbackCapabilities],
      ...(modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? { maxContextSize: 262_144 } : {}),
    };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const defaultThinkingMatch = raw.match(/^\s*default_thinking\s*=\s*(true|false)\s*$/m);
    const sectionHeader = `[models."${modelAlias}"]`;
    const sectionStart = raw.indexOf(sectionHeader);
    let capabilities: string[] = [...fallbackCapabilities];
    let maxContextSize: number | undefined = modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? 262_144 : undefined;
    if (sectionStart >= 0) {
      const nextSection = raw.indexOf('\n[', sectionStart + sectionHeader.length);
      const section = raw.slice(sectionStart, nextSection >= 0 ? nextSection : undefined);
      const capsMatch = section.match(/^\s*capabilities\s*=\s*\[([^\]]*)\]/m);
      const maxContextMatch = section.match(/^\s*max_context_size\s*=\s*(\d+)\s*$/m);
      if (capsMatch?.[1]) {
        capabilities = Array.from(
          new Set(
            capsMatch[1]
              .split(',')
              .map((item) => item.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean),
          ),
        );
      }
      if (maxContextMatch?.[1]) {
        const parsed = Number.parseInt(maxContextMatch[1], 10);
        if (Number.isFinite(parsed) && parsed > 0) maxContextSize = parsed;
      }
    }
    return {
      defaultThinking:
        defaultThinkingMatch?.[1] === 'true' ||
        capabilities.includes('thinking') ||
        fallbackCapabilities.includes('thinking'),
      capabilities,
      ...(maxContextSize ? { maxContextSize } : {}),
    };
  } catch {
    return {
      defaultThinking: fallbackCapabilities.includes('thinking'),
      capabilities: [...fallbackCapabilities],
      ...(modelAlias === DEFAULT_KIMI_MODEL_ALIAS ? { maxContextSize: 262_144 } : {}),
    };
  }
}

/**
 * Observe the model selected by the local CLI's own config.toml.
 *
 * This is identity evidence only: a native_tool member without an explicit
 * model deliberately lets the CLI own the request, so the observed value must
 * never be injected as `--model`. Returns undefined when the config cannot be
 * read, which keeps callers conservative instead of guessing a model.
 */
export function readKimiConfiguredModel(
  callbackEnv?: Record<string, string>,
  paths?: KimiRuntimePaths,
): string | undefined {
  const configPath = resolveKimiConfigPath(callbackEnv, paths);
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const value = raw.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m)?.[1]?.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function resolveKimiModelAlias(
  model: string,
  callbackEnv?: Record<string, string>,
  paths?: KimiRuntimePaths,
): string {
  if (callbackEnv?.CAT_CAFE_KIMI_API_KEY) return model;
  if (model.includes('/')) return model;

  const configPath = resolveKimiConfigPath(callbackEnv, paths);
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const match = raw.match(/^\s*default_model\s*=\s*["']([^"']+)["']/m);
      if (match?.[1]) return match[1].trim();
    } catch {
      // Fall through to baked-in alias.
    }
  }

  return DEFAULT_KIMI_MODEL_ALIAS;
}

export function readKimiSessionId(
  workingDirectory: string,
  callbackEnv?: Record<string, string>,
  paths?: KimiRuntimePaths,
): string | undefined {
  const shareDir = resolveKimiShareDir(callbackEnv, paths);
  const statePath = join(shareDir, 'kimi.json');
  if (!existsSync(statePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { work_dirs?: Array<Record<string, unknown>> };
    const workDirs = Array.isArray(raw?.work_dirs) ? raw.work_dirs : [];
    const target = normalizeKimiWorkDirPath(workingDirectory);
    const entry = workDirs.find(
      (item) => typeof item.path === 'string' && normalizeKimiWorkDirPath(item.path) === target,
    );
    return typeof entry?.last_session_id === 'string' && entry.last_session_id.trim().length > 0
      ? entry.last_session_id
      : undefined;
  } catch {
    return undefined;
  }
}

async function readTailUtf8(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const readBytes = Math.min(stat.size, maxBytes);
    if (readBytes <= 0) return '';
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, stat.size - readBytes);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function findKimiSessionContextFile(shareDir: string, sessionId: string): Promise<string | null> {
  const sessionsRoot = join(shareDir, 'sessions');
  const stack: string[] = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === sessionId) {
          const contextFile = join(abs, 'context.jsonl');
          try {
            await fs.access(contextFile);
            return contextFile;
          } catch {
            return null;
          }
        }
        stack.push(abs);
      }
    }
  }
  return null;
}

export async function readKimiContextUsedTokens(
  sessionId: string,
  callbackEnv?: Record<string, string>,
  paths?: KimiRuntimePaths,
): Promise<number | undefined> {
  const contextFile = await findKimiSessionContextFile(resolveKimiShareDir(callbackEnv, paths), sessionId);
  if (!contextFile) return undefined;
  const tail = await readTailUtf8(contextFile, KIMI_CONTEXT_TAIL_BYTES);
  if (!tail) return undefined;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.role === '_usage' && typeof parsed.token_count === 'number' && Number.isFinite(parsed.token_count)) {
        return parsed.token_count;
      }
    } catch {}
  }
  return undefined;
}

export function buildApiKeyEnv(model: string, callbackEnv?: Record<string, string>): Record<string, string> | null {
  const apiKey = callbackEnv?.CAT_CAFE_KIMI_API_KEY;
  if (!apiKey) return null;
  const baseUrl = normalizeKimiApiBaseUrl(callbackEnv?.CAT_CAFE_KIMI_BASE_URL || DEFAULT_KIMI_BASE_URL);
  const configuredModelName = model.trim();
  return {
    KIMI_API_KEY: apiKey,
    KIMI_BASE_URL: baseUrl,
    KIMI_MODEL_NAME: configuredModelName,
    KIMI_MODEL_MAX_CONTEXT_SIZE: callbackEnv?.KIMI_MODEL_MAX_CONTEXT_SIZE || '262144',
    ...(callbackEnv?.KIMI_MODEL_CAPABILITIES ? { KIMI_MODEL_CAPABILITIES: callbackEnv.KIMI_MODEL_CAPABILITIES } : {}),
  };
}
