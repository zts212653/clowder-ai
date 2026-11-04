import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import { resolveWindowsSpawnPlan } from '../../../../utils/cli-spawn-win.js';
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
  readonly windowsSpawnPlan?: typeof resolveWindowsSpawnPlan;
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

function hostCorepackPath(platform: NodeJS.Platform, execPath: string): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.join(path.dirname(execPath), platform === 'win32' ? 'corepack.cmd' : 'corepack');
}

function childFailure(
  error: unknown,
  packageManager: string,
  phase: MarketplacePreparationDiagnostic['phase'],
  root: string,
): MarketplacePreparationError {
  const record = error && typeof error === 'object' ? (error as { code?: unknown; stderr?: unknown }) : undefined;
  const exitCode = typeof record?.code === 'number' ? record.code : null;
  const rawStderr =
    typeof record?.stderr === 'string'
      ? record.stderr
      : Buffer.isBuffer(record?.stderr)
        ? record.stderr.toString('utf8')
        : '';
  const stderrExcerpt = excerptSanitizedStderr(rawStderr, {
    edge: 'head',
    maxLength: 1_000,
    additionalHomePaths: [root],
  });
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
  const corepack = hostCorepackPath(platform, deps.execPath ?? process.execPath);
  if (!(deps.exists ?? existsSync)(corepack)) {
    throw new Error('Marketplace preparation requires the Host-bundled Corepack executable');
  }
  const options = {
    cwd: root,
    env: {
      ...process.env,
      CI: 'true',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      COREPACK_ENABLE_PROJECT_SPEC: '1',
      COREPACK_ENABLE_STRICT: '1',
    },
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  const runExec = deps.exec ?? exec;
  // This is the repository's existing pnpm workspace preparation. In particular,
  // its postinstall restores retained SDK graphs before directory admission.
  const run = async (phase: MarketplacePreparationDiagnostic['phase'], args: string[]) => {
    const corepackArgs = [packageManager, ...args];
    try {
      if (platform === 'win32') {
        const plan = (deps.windowsSpawnPlan ?? resolveWindowsSpawnPlan)(corepack, corepackArgs);
        await runExec(plan.command, plan.args, { ...options, ...(plan.shell ? { shell: plan.shell } : {}) });
      } else await runExec(corepack, corepackArgs, options);
    } catch (error) {
      throw childFailure(error, packageManager, phase, root);
    }
  };
  await run('install', ['install', '--frozen-lockfile']);
  if (pkg.scripts?.build) await run('build', ['--filter', `${pkg.name}...`, 'build']);
}
