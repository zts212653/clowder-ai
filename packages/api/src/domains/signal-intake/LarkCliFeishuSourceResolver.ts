import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SourceArtifact, SourceResolver } from './SourceAccessLeaseService.js';

const execFileAsync = promisify(execFile);
const MAX_TRANSCRIPT_BYTES = 2_000_000;

export interface LarkCliRunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface LarkCliFeishuSourceResolverOptions {
  readonly run?: (args: readonly string[], signal: AbortSignal) => Promise<LarkCliRunResult>;
  readonly makeTempDirectory?: () => Promise<string>;
  readonly readText?: (path: string) => Promise<string>;
  readonly removeTempDirectory?: (path: string) => Promise<void>;
}

interface FeishuLocator {
  readonly kind: 'minute' | 'note';
  readonly artifactId: string;
  readonly revision: string;
}

function parseSourceHandle(value: string): FeishuLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Feishu source handle must be canonical');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const revision = url.searchParams.get('revision');
  if (
    url.protocol !== 'feishu:' ||
    url.hostname !== 'meeting-artifacts' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    parts.length !== 2 ||
    (parts[0] !== 'minute' && parts[0] !== 'note') ||
    [...url.searchParams.keys()].join(',') !== 'revision' ||
    !revision ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(parts[1] ?? '') ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(revision)
  ) {
    throw new TypeError('Feishu source handle must be canonical');
  }
  const canonical = `feishu://meeting-artifacts/${parts[0]}/${parts[1]}?revision=${encodeURIComponent(revision)}`;
  if (value !== canonical) throw new TypeError('Feishu source handle must be canonical');
  return { kind: parts[0], artifactId: parts[1]!, revision };
}

function parseJson(stdout: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    // Mapped to a bounded source error below.
  }
  throw Object.assign(new Error('lark-cli returned invalid JSON'), { code: 'EXECUTION_FAILED' });
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const nested = value[key];
  return typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : null;
}

function findString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].length > 0) return value[key];
  }
  const data = nestedRecord(value, 'data');
  return data ? findString(data, keys) : null;
}

function requireTranscript(text: string): SourceArtifact {
  if (text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw Object.assign(new Error('Feishu transcript is empty or too large'), { code: 'EXECUTION_FAILED' });
  }
  return { contentType: 'text/plain', text };
}

function requirePathInside(root: string, candidate: string): string {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw Object.assign(new Error('lark-cli returned an unsafe transcript path'), { code: 'EXECUTION_FAILED' });
  }
  return candidatePath;
}

function mappedCliError(error: unknown): Error {
  const detail = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const code = /auth|login|token|permission|unauthorized|forbidden/u.test(detail)
    ? 'SOURCE_AUTH_REQUIRED'
    : /not found|deleted|404/u.test(detail)
      ? 'SOURCE_DELETED'
      : /not ready|pending|generating|409/u.test(detail)
        ? 'SOURCE_NOT_READY'
        : 'EXECUTION_FAILED';
  return Object.assign(new Error('Feishu transcript resolution failed'), { code });
}

async function defaultRun(args: readonly string[], signal: AbortSignal): Promise<LarkCliRunResult> {
  try {
    const result = await execFileAsync('lark-cli', [...args], {
      signal,
      maxBuffer: 4_000_000,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw mappedCliError(error);
  }
}

export class LarkCliFeishuSourceResolver implements SourceResolver {
  readonly adapterId = 'host.lark-cli.feishu-transcript.v1';
  private readonly run: NonNullable<LarkCliFeishuSourceResolverOptions['run']>;
  private readonly makeTempDirectory: NonNullable<LarkCliFeishuSourceResolverOptions['makeTempDirectory']>;
  private readonly readText: NonNullable<LarkCliFeishuSourceResolverOptions['readText']>;
  private readonly removeTempDirectory: NonNullable<LarkCliFeishuSourceResolverOptions['removeTempDirectory']>;

  constructor(options: LarkCliFeishuSourceResolverOptions = {}) {
    this.run = options.run ?? defaultRun;
    this.makeTempDirectory = options.makeTempDirectory ?? (() => mkdtemp(join(tmpdir(), 'cat-cafe-f292-')));
    this.readText = options.readText ?? ((path) => readFile(path, 'utf8'));
    this.removeTempDirectory = options.removeTempDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  supports(sourceHandle: string): boolean {
    try {
      parseSourceHandle(sourceHandle);
      return true;
    } catch {
      return false;
    }
  }

  async resolve(
    access: { readonly sourceHandle: string; readonly intakeId: string; readonly sourceGrant: string },
    signal: AbortSignal,
  ): Promise<SourceArtifact> {
    const locator = parseSourceHandle(access.sourceHandle);
    const temporaryDirectory = await this.makeTempDirectory();
    try {
      if (locator.kind === 'minute') {
        const response = parseJson(
          (
            await this.run(
              [
                'minutes',
                '+detail',
                '--minute-tokens',
                locator.artifactId,
                '--transcript',
                '--output-dir',
                temporaryDirectory,
                '--format',
                'json',
                '--as',
                'user',
              ],
              signal,
            )
          ).stdout,
        );
        const inline = findString(response, ['transcript', 'content', 'text']);
        if (inline) return requireTranscript(inline);
        const path = findString(response, ['transcript_file', 'transcriptFile', 'output']);
        if (!path) {
          throw Object.assign(new Error('lark-cli did not return a bounded transcript file'), {
            code: 'EXECUTION_FAILED',
          });
        }
        return requireTranscript(await this.readText(requirePathInside(temporaryDirectory, path)));
      }

      const detail = parseJson(
        (
          await this.run(
            ['note', '+detail', '--note-id', locator.artifactId, '--format', 'json', '--as', 'user'],
            signal,
          )
        ).stdout,
      );
      const displayType = findString(detail, ['note_display_type', 'noteDisplayType']);
      if (displayType === 'unified') {
        const outputPath = join(temporaryDirectory, 'note.txt');
        const response = parseJson(
          (
            await this.run(
              [
                'note',
                '+transcript',
                '--note-id',
                locator.artifactId,
                '--transcript-format',
                'plain_text',
                '--output',
                outputPath,
                '--format',
                'json',
                '--as',
                'user',
              ],
              signal,
            )
          ).stdout,
        );
        const inline = findString(response, ['transcript', 'content', 'text']);
        if (inline) return requireTranscript(inline);
        const responsePath = findString(response, ['transcript_file', 'transcriptFile', 'output']) ?? outputPath;
        return requireTranscript(await this.readText(requirePathInside(temporaryDirectory, responsePath)));
      }

      const verbatimToken = findString(detail, ['verbatim_token', 'verbatimToken']);
      if (!verbatimToken || !/^[A-Za-z0-9._-]{1,128}$/u.test(verbatimToken)) {
        throw Object.assign(new Error('Feishu note transcript is not ready'), { code: 'SOURCE_NOT_READY' });
      }
      const document = parseJson(
        (
          await this.run(
            ['docs', '+fetch', '--doc', verbatimToken, '--doc-format', 'markdown', '--format', 'json', '--as', 'user'],
            signal,
          )
        ).stdout,
      );
      const content = findString(document, ['content', 'markdown', 'text']);
      if (!content) throw Object.assign(new Error('Feishu note transcript is not ready'), { code: 'SOURCE_NOT_READY' });
      return requireTranscript(content);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error;
      throw mappedCliError(error);
    } finally {
      await this.removeTempDirectory(temporaryDirectory).catch(() => undefined);
    }
  }
}
