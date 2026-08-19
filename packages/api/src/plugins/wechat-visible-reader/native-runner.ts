import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseWeChatConversationRecentResult,
  parseWeChatNavigationSpikeResult,
  parseWeChatVisibleProbeResult,
  parseWeChatVisibleReadResult,
  type WeChatConversationRecentResult,
  type WeChatNavigationSpikeResult,
  type WeChatVisibleFailure,
  type WeChatVisibleProbeResult,
  type WeChatVisibleReadResult,
} from './types.js';

export const DEFAULT_WECHAT_VISIBLE_BLOCKS = 80;
export const DEFAULT_WECHAT_VISIBLE_CHARS = 8_000;
export const MAX_WECHAT_VISIBLE_BLOCKS = 200;
export const MAX_WECHAT_VISIBLE_CHARS = 20_000;

const NATIVE_TIMEOUT_MS = 30_000;
const NATIVE_NAVIGATION_TIMEOUT_MS = 60_000;
const NATIVE_COMPILE_TIMEOUT_MS = 120_000;
const NATIVE_MAX_BUFFER_BYTES = 512 * 1024;
const DEFAULT_SOURCE_PATHS = [
  fileURLToPath(new URL('../../../src/plugins/wechat-visible-reader/native/WeChatReaderModels.swift', import.meta.url)),
  fileURLToPath(new URL('../../../src/plugins/wechat-visible-reader/native/WeChatReaderCore.swift', import.meta.url)),
  fileURLToPath(new URL('../../../src/plugins/wechat-visible-reader/native/WeChatLayoutGuard.swift', import.meta.url)),
  fileURLToPath(
    new URL('../../../src/plugins/wechat-visible-reader/native/WeChatNavigationModels.swift', import.meta.url),
  ),
  fileURLToPath(
    new URL('../../../src/plugins/wechat-visible-reader/native/WeChatConversationNavigator.swift', import.meta.url),
  ),
  fileURLToPath(
    new URL('../../../src/plugins/wechat-visible-reader/native/WeChatNavigationFixtures.swift', import.meta.url),
  ),
  fileURLToPath(
    new URL('../../../src/plugins/wechat-visible-reader/native/WeChatVisibleReader.swift', import.meta.url),
  ),
] as const;

export interface WeChatVisibleReadOptions {
  maxBlocks?: number;
  maxChars?: number;
}

export interface WeChatConversationRecentOptions {
  contact: string;
  limit: number;
}

export interface NativeExecutionOptions {
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}

export type NativeCommandExecutor = (
  file: string,
  args: readonly string[],
  options: NativeExecutionOptions,
) => Promise<{ stdout: string }>;

export interface WeChatVisibleReaderNativeRunnerOptions {
  /** Legacy single-source test seam. Production uses all default Swift sources. */
  sourcePath?: string;
  sourcePaths?: readonly string[];
  /** Test-only shortcut for deterministic compile assertions. */
  sourceDigest?: string;
  cacheDirectory?: string;
  /** Precompiled executable test seam; production leaves this unset. */
  executablePath?: string;
  execute?: NativeCommandExecutor;
}

export interface WeChatVisibleReaderNativeRunner {
  read(options?: WeChatVisibleReadOptions): Promise<WeChatVisibleReadResult>;
  probe(): Promise<WeChatVisibleProbeResult>;
  navigationSpike(contact: string): Promise<WeChatNavigationSpikeResult>;
  readConversationRecent(options: WeChatConversationRecentOptions): Promise<WeChatConversationRecentResult>;
}

const SAFE_CAPTURE_FAILURE: WeChatVisibleFailure = {
  ok: false,
  error: {
    code: 'capture_failed',
    userAction: '微信读取失败，请稍后重试。',
  },
};

const defaultExecutor: NativeCommandExecutor = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });

function isValidLimit(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximum;
}

function isValidContact(value: string): boolean {
  const trimmed = value.trim();
  const containsControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  return trimmed.length > 0 && [...trimmed].length <= 128 && !containsControlCharacter;
}

function safeCaptureFailure(): WeChatVisibleFailure {
  return {
    ok: false,
    error: { ...SAFE_CAPTURE_FAILURE.error },
  };
}

async function hashSources(sourcePaths: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const sourcePath of sourcePaths) {
    hash.update(sourcePath);
    hash.update('\0');
    hash.update(await readFile(sourcePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function createWeChatVisibleReaderNativeRunner(
  options: WeChatVisibleReaderNativeRunnerOptions = {},
): WeChatVisibleReaderNativeRunner {
  const execute = options.execute ?? defaultExecutor;
  const hasCompileConfiguration =
    options.sourcePath !== undefined || options.sourcePaths !== undefined || options.sourceDigest !== undefined;
  const injectedExecutable =
    options.executablePath ??
    (options.execute && !hasCompileConfiguration ? '/injected/cat-cafe-wechat-visible-reader' : undefined);
  const sourcePaths =
    options.sourcePaths ??
    (options.sourcePath ? [...DEFAULT_SOURCE_PATHS.slice(0, -1), options.sourcePath] : DEFAULT_SOURCE_PATHS);
  const cacheDirectory = options.cacheDirectory ?? tmpdir();
  let executablePromise: Promise<string> | undefined;

  const resolveExecutable = (): Promise<string> => {
    if (injectedExecutable) return Promise.resolve(injectedExecutable);
    executablePromise ??= (async () => {
      const digest = options.sourceDigest ?? (await hashSources(sourcePaths));
      const executable = join(cacheDirectory, `cat-cafe-wechat-reader-${digest}`);
      try {
        await access(executable, fsConstants.X_OK);
        return executable;
      } catch {
        // A source-hash keyed executable contains code only. No capture, OCR,
        // message body, or user data is written into this cache.
      }
      if (execute === defaultExecutor) {
        await mkdir(cacheDirectory, { recursive: true });
      }
      await execute('/usr/bin/xcrun', ['swiftc', ...sourcePaths, '-o', executable], {
        encoding: 'utf8',
        timeout: NATIVE_COMPILE_TIMEOUT_MS,
        maxBuffer: NATIVE_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      return executable;
    })();
    return executablePromise;
  };

  return {
    async probe(): Promise<WeChatVisibleProbeResult> {
      try {
        const executable = await resolveExecutable();
        const { stdout } = await execute(executable, ['--probe'], {
          encoding: 'utf8',
          timeout: NATIVE_TIMEOUT_MS,
          maxBuffer: NATIVE_MAX_BUFFER_BYTES,
          windowsHide: true,
        });
        return parseWeChatVisibleProbeResult(JSON.parse(stdout));
      } catch {
        return safeCaptureFailure();
      }
    },
    async navigationSpike(contact: string): Promise<WeChatNavigationSpikeResult> {
      if (!isValidContact(contact)) return safeCaptureFailure();
      try {
        const executable = await resolveExecutable();
        const { stdout } = await execute(executable, ['--navigation-spike', '--contact', contact], {
          encoding: 'utf8',
          timeout: NATIVE_TIMEOUT_MS,
          maxBuffer: NATIVE_MAX_BUFFER_BYTES,
          windowsHide: true,
        });
        return parseWeChatNavigationSpikeResult(JSON.parse(stdout));
      } catch {
        return safeCaptureFailure();
      }
    },
    async readConversationRecent(readOptions): Promise<WeChatConversationRecentResult> {
      if (!isValidContact(readOptions.contact) || !isValidLimit(readOptions.limit, 30)) {
        return safeCaptureFailure();
      }
      const contact = readOptions.contact.trim();
      try {
        const executable = await resolveExecutable();
        const { stdout } = await execute(
          executable,
          ['--read-conversation-recent', '--contact', contact, '--limit', String(readOptions.limit)],
          {
            encoding: 'utf8',
            timeout: NATIVE_NAVIGATION_TIMEOUT_MS,
            maxBuffer: NATIVE_MAX_BUFFER_BYTES,
            windowsHide: true,
          },
        );
        return parseWeChatConversationRecentResult(JSON.parse(stdout), {
          maxBlocks: readOptions.limit,
          maxChars: MAX_WECHAT_VISIBLE_CHARS,
        });
      } catch {
        return safeCaptureFailure();
      }
    },
    async read(readOptions = {}): Promise<WeChatVisibleReadResult> {
      const maxBlocks = readOptions.maxBlocks ?? DEFAULT_WECHAT_VISIBLE_BLOCKS;
      const maxChars = readOptions.maxChars ?? DEFAULT_WECHAT_VISIBLE_CHARS;
      if (!isValidLimit(maxBlocks, MAX_WECHAT_VISIBLE_BLOCKS) || !isValidLimit(maxChars, MAX_WECHAT_VISIBLE_CHARS)) {
        return safeCaptureFailure();
      }

      try {
        const executable = await resolveExecutable();
        const { stdout } = await execute(
          executable,
          ['--read', '--max-blocks', String(maxBlocks), '--max-chars', String(maxChars)],
          {
            encoding: 'utf8',
            timeout: NATIVE_TIMEOUT_MS,
            maxBuffer: NATIVE_MAX_BUFFER_BYTES,
            windowsHide: true,
          },
        );
        return parseWeChatVisibleReadResult(JSON.parse(stdout), { maxBlocks, maxChars });
      } catch {
        return safeCaptureFailure();
      }
    },
  };
}
