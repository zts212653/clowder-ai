import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { devNull } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { type LocalPluginPackageAdmission, LocalPluginPackageAdmissionError } from './local-package-admission.js';

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_CLONE_TIMEOUT_MS = 30_000;
const MAX_GIT_URL_LENGTH = 4_096;
const ALLOWED_GIT_PROTOCOLS = new Set(['https:', 'ssh:', 'git:', 'file:']);

export interface GitPluginPackageSource {
  readonly kind: 'git';
  readonly url: string;
}

export interface GitPluginPackageAdmissionOptions {
  readonly localAdmission: LocalPluginPackageAdmission;
  readonly cloneRoot: string;
  readonly gitBin?: string;
  readonly timeoutMs?: number;
}

function invalidGitSource(message: string, cause?: unknown): LocalPluginPackageAdmissionError {
  return new LocalPluginPackageAdmissionError('INVALID_LOCAL_SOURCE', message, cause === undefined ? {} : { cause });
}

function gitUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_GIT_URL_LENGTH ||
    value.trim() !== value ||
    value.startsWith('-')
  ) {
    throw invalidGitSource('git plugin URL is invalid');
  }
  const scpStyle = /^([^@\s]+)@([^/:\s]+):(.+)$/.exec(value);
  if (scpStyle) {
    throw invalidGitSource(
      `git plugin URL must use ssh://${scpStyle[1]}@${scpStyle[2]}/${scpStyle[3]} instead of scp syntax`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalidGitSource('git plugin URL must use an allowed absolute protocol', error);
  }
  if (!ALLOWED_GIT_PROTOCOLS.has(parsed.protocol)) {
    throw invalidGitSource('git plugin URL protocol is not allowed');
  }
  if (
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    ((parsed.protocol === 'https:' || parsed.protocol === 'git:') && parsed.username)
  ) {
    throw invalidGitSource('git plugin URL must not embed credentials');
  }
  return value;
}

export function createGitCloneEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  return {
    ...environment,
    GIT_ALLOW_PROTOCOL: 'https:ssh:git:file',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export class GitPluginPackageAdmission {
  private readonly cloneRoot: string;
  private readonly gitBin: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitPluginPackageAdmissionOptions) {
    this.cloneRoot = resolve(options.cloneRoot);
    this.gitBin = options.gitBin?.trim() || 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new TypeError('git clone timeout must be a positive safe integer');
    }
  }

  async install(source: GitPluginPackageSource) {
    const url = gitUrl(source.url);
    await mkdir(this.cloneRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await mkdtemp(resolve(this.cloneRoot, '.git-install-'));
    const repositoryRoot = resolve(stagingRoot, 'repository');
    try {
      await execFileAsync(
        this.gitBin,
        ['clone', '--depth', '1', '--no-tags', '--single-branch', '--no-recurse-submodules', '--', url, repositoryRoot],
        {
          env: createGitCloneEnvironment(),
          timeout: this.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      await rm(resolve(repositoryRoot, '.git'), { recursive: true, force: true });
      return await this.options.localAdmission.install(
        { kind: 'local-directory', path: repositoryRoot },
        {},
        { kind: 'git', url },
      );
    } catch (error) {
      if (error instanceof LocalPluginPackageAdmissionError) throw error;
      throw invalidGitSource('git plugin repository could not be cloned safely', error);
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}
