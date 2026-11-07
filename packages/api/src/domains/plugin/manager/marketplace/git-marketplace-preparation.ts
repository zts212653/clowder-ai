import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { excerptSanitizedStderr } from '../../../../utils/sanitize-cli-stderr.js';

const exec = promisify(execFile);

export interface MarketplacePreparationDiagnostic {
  readonly packageManager: string;
  readonly phase: 'install' | 'build';
  readonly exitCode: number | null;
  readonly stderrExcerpt: string;
}

export class MarketplacePreparationError extends Error {
  constructor(
    message: string,
    readonly diagnostic: MarketplacePreparationDiagnostic,
  ) {
    super(message);
    this.name = 'MarketplacePreparationError';
  }
}

interface MarketplacePreparationDeps {
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly exists?: (path: string) => boolean;
  readonly exec?: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
}

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function exactPnpmPackageManager(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('pnpm@')) {
    throw new Error(
      'Marketplace repository must declare an exact pnpm version in packageManager (for example "pnpm@9.15.4")',
    );
  }
  const version = value.slice('pnpm@'.length);
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(
      'Marketplace repository must declare an exact pnpm version in packageManager (for example "pnpm@9.15.4")',
    );
  }
  return value;
}

function hostCorepackPaths(platform: NodeJS.Platform, execPath: string): { launcher: string; script: string } {
  const path = platform === 'win32' ? win32 : posix;
  const runtimeDirectory = path.dirname(execPath);
  return {
    launcher: path.join(runtimeDirectory, platform === 'win32' ? 'corepack.cmd' : 'corepack'),
    script:
      platform === 'win32'
        ? path.join(runtimeDirectory, 'node_modules', 'corepack', 'dist', 'corepack.js')
        : path.join(runtimeDirectory, '..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  };
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function boundedChildOutput(stderr: string, stdout: string, root: string): string {
  const sanitizerOptions = { edge: 'head' as const, additionalHomePaths: [root] };
  if (!stderr.trim()) {
    return excerptSanitizedStderr(stdout, { ...sanitizerOptions, maxLength: 1_000 });
  }
  if (!stdout.trim()) {
    return excerptSanitizedStderr(stderr, { ...sanitizerOptions, maxLength: 1_000 });
  }

  const stderrLabel = 'stderr: ';
  const stdoutLabel = 'stdout: ';
  const separator = '\n';
  const outputBudget = 1_000 - stderrLabel.length - stdoutLabel.length - separator.length;
  const stderrBudget = Math.floor(outputBudget / 2);
  const stdoutBudget = outputBudget - stderrBudget;
  const stderrExcerpt = excerptSanitizedStderr(stderr, { ...sanitizerOptions, maxLength: stderrBudget });
  const stdoutExcerpt = excerptSanitizedStderr(stdout, { ...sanitizerOptions, maxLength: stdoutBudget });
  return `${stderrLabel}${stderrExcerpt}${separator}${stdoutLabel}${stdoutExcerpt}`;
}

function childFailure(
  error: unknown,
  packageManager: string,
  phase: MarketplacePreparationDiagnostic['phase'],
  root: string,
): MarketplacePreparationError {
  const record =
    error && typeof error === 'object' ? (error as { code?: unknown; stderr?: unknown; stdout?: unknown }) : undefined;
  const exitCode = typeof record?.code === 'number' ? record.code : null;
  const rawStderr = outputText(record?.stderr);
  const stderrExcerpt = boundedChildOutput(rawStderr, outputText(record?.stdout), root);
  const diagnostic: MarketplacePreparationDiagnostic = {
    packageManager,
    phase,
    exitCode,
    stderrExcerpt,
  };
  const exit = exitCode === null ? 'unknown' : String(exitCode);
  return new MarketplacePreparationError(
    `Marketplace dependency ${phase} failed (${packageManager}, exit ${exit})${
      stderrExcerpt ? `: ${stderrExcerpt}` : ''
    }`,
    diagnostic,
  );
}

/** Runs only after the owner selects Install, never during repository discovery. */
export async function prepareMarketplaceDirectory(
  directory: string,
  root: string,
  deps: MarketplacePreparationDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const [pkg, rootPkg] = await Promise.all([
    readFile(join(directory, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name)) {
    throw new Error('Invalid marketplace package name');
  }
  const packageManager = exactPnpmPackageManager(rootPkg?.packageManager);
  const execPath = deps.execPath ?? process.execPath;
  const corepack = hostCorepackPaths(platform, execPath);
  const path = platform === 'win32' ? win32 : posix;
  const runtimeDirectory = path.dirname(execPath);
  const pathExists = deps.exists ?? existsSync;
  if (!pathExists(corepack.launcher)) {
    throw new Error('Marketplace preparation requires the Host-bundled Corepack executable');
  }
  if (!pathExists(corepack.script)) {
    throw new Error('Marketplace preparation requires the Host-bundled Corepack entry script');
  }
  const baseEnv = {
    ...process.env,
    CI: 'true',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_PROJECT_SPEC: '1',
    COREPACK_ENABLE_STRICT: '1',
  };
  const baseOptions = {
    cwd: root,
    env: baseEnv,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  const runExec = deps.exec ?? exec;
  const runCorepack = async (
    phase: MarketplacePreparationDiagnostic['phase'],
    args: string[],
    options: Record<string, unknown>,
  ) => {
    try {
      // Corepack's POSIX launcher uses `#!/usr/bin/env node`, while its Windows
      // .cmd shim is normally parsed by the generic external-CLI spawn helper.
      // Neither path proves that the packaged Host Node is used on a clean
      // machine. Invoke the entry script with this API process executable so
      // version selection never depends on a system Node or PATH.
      await runExec(execPath, [corepack.script, ...args], options);
    } catch (error) {
      throw childFailure(error, packageManager, phase, root);
    }
  };

  const shimDirectory = await mkdtemp(join(tmpdir(), 'clowder-marketplace-pnpm-'));
  try {
    await runCorepack('install', ['enable', 'pnpm', '--install-directory', shimDirectory], baseOptions);
    const pnpmShim = path.join(shimDirectory, platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    if (!pathExists(pnpmShim)) {
      throw new Error('Host Corepack did not create the isolated pnpm shim');
    }
    const inheritedPath = process.env.PATH;
    const lifecycleEnv = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key.toUpperCase() !== 'PATH'));
    const options = {
      ...baseOptions,
      env: {
        ...lifecycleEnv,
        PATH: [shimDirectory, runtimeDirectory, inheritedPath].filter(Boolean).join(path.delimiter),
      },
    };
    // This is the repository's existing pnpm workspace preparation. In particular,
    // its postinstall restores retained SDK graphs before directory admission. The
    // isolated shim also pins bare pnpm invocations made by lifecycle subprocesses.
    // Put this Host Node next so the shim's `#!/usr/bin/env node` cannot fall
    // through to a missing or unrelated system runtime.
    await runCorepack('install', [packageManager, 'install', '--frozen-lockfile'], options);
    if (pkg.scripts?.build) {
      await runCorepack('build', [packageManager, '--filter', `${pkg.name}...`, 'build'], options);
    }
  } finally {
    await rm(shimDirectory, { recursive: true, force: true });
  }
}
