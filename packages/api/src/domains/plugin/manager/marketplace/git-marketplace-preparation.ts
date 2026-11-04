import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveWindowsSpawnPlan } from '../../../../utils/cli-spawn-win.js';
import { excerptSanitizedStderr } from '../../../../utils/sanitize-cli-stderr.js';
import { resolveNpmInvocation } from '../npm-invocation.js';

export class MarketplacePreparationError extends Error {
  readonly diagnostic;

  constructor(
    diagnostic: {
      stage: 'version' | 'install' | 'build';
      requestedVersion: string | null;
      actualVersion: string | null;
      exitCode: number | string | null;
      output: string;
    },
    privatePaths: readonly string[] = [],
  ) {
    const output = excerptSanitizedStderr(diagnostic.output, {
      edge: 'head',
      maxLength: 2048,
      additionalHomePaths: privatePaths,
    });
    super(
      `Marketplace ${diagnostic.stage} failed (pnpm ${diagnostic.actualVersion ?? 'unknown'}; ` +
        `requested ${diagnostic.requestedVersion ?? 'environment'}; exit ${diagnostic.exitCode ?? 'unknown'}): ${output}`,
    );
    this.name = 'MarketplacePreparationError';
    this.diagnostic = { ...diagnostic, output };
  }
}

/** Runs only after the owner selects Install, never during repository discovery. */
export async function prepareMarketplaceDirectory(directory: string, root: string): Promise<void> {
  const pkg = z
    .object({
      name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/, 'Invalid marketplace package name'),
      scripts: z.object({ build: z.string().optional() }).optional(),
    })
    .parse(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')));
  const { packageManager } = z
    .object({
      packageManager: z
        .string()
        .regex(/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'Expected marketplace packageManager pnpm@<exact-version>')
        .optional(),
    })
    .parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
  const requestedVersion = packageManager?.slice('pnpm@'.length) ?? null;
  let actualVersion: string | null = null;
  // npm is already shipped with the desktop Node runtime. An exact package avoids
  // depending on the global pnpm's version-switch settings or Corepack availability.
  const invocation = packageManager ? resolveNpmInvocation('npm') : { command: 'pnpm', prefixArgs: [] };
  const prefix = packageManager
    ? [...invocation.prefixArgs, 'exec', '--yes', `--package=${packageManager}`, '--', 'pnpm']
    : [];
  const options = {
    cwd: root,
    env: { ...process.env, CI: 'true' },
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  };
  const run = (stage: 'version' | 'install' | 'build', args: string[]) => {
    const plan =
      process.platform === 'win32' && !packageManager
        ? resolveWindowsSpawnPlan('pnpm', args)
        : { command: invocation.command, args: [...prefix, ...args], shell: undefined };
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(
        plan.command,
        plan.args,
        { ...options, ...(plan.shell ? { shell: plan.shell } : {}) },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new MarketplacePreparationError(
                {
                  stage,
                  requestedVersion,
                  actualVersion,
                  exitCode: error.code ?? error.signal ?? null,
                  output: [stdout, stderr].filter(Boolean).join('\n') || error.message,
                },
                [root],
              ),
            );
          } else resolve({ stdout, stderr });
        },
      );
    });
  };
  const version = await run('version', ['--version']);
  const reportedVersion = version.stdout.trim();
  actualVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(reportedVersion) ? reportedVersion : null;
  if (!actualVersion || (requestedVersion && actualVersion !== requestedVersion)) {
    throw new MarketplacePreparationError(
      {
        stage: 'version',
        requestedVersion,
        actualVersion,
        exitCode: null,
        output: `Unexpected pnpm version: ${reportedVersion}\n${version.stderr}`,
      },
      [root],
    );
  }
  // Keep the repository's frozen lockfile and its own dependency-build policy.
  await run('install', ['install', '--frozen-lockfile']);
  if (pkg.scripts?.build) await run('build', ['--filter', `${pkg.name}...`, 'build']);
}
