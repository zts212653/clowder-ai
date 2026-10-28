import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execTool = promisify(execFile);
const TOOL_TIMEOUT_MS = 30_000;

/** Reuse only the source's verified Biome package/shim in the disposable checkout. */
export async function prepareTastePublicationToolchain(
  sourceRoot: string,
  checkoutRoot: string,
  filesToCommit: readonly string[],
): Promise<void> {
  // Taste publishes Markdown plus JSON tombstones. Markdown-only approval keeps
  // the hook's original no-Biome contract; deleted JSON needs no formatter either.
  if (!filesToCommit.some((path) => path.endsWith('.json') && existsSync(join(checkoutRoot, path)))) return;
  const packagePath = join(sourceRoot, 'node_modules/@biomejs/biome/package.json');
  const binaryPath = join(sourceRoot, 'node_modules/.bin/biome');
  // Absence stays with the real hook's fail-closed verdict, without installation.
  if (!existsSync(packagePath) || !existsSync(binaryPath)) return;

  // The existing checker compares this source install against the TARGET lock,
  // not an operator's potentially dirty or older source lockfile.
  await execTool(
    process.execPath,
    [join(sourceRoot, 'scripts/check-biome-version.mjs'), '--lockfile', join(checkoutRoot, 'pnpm-lock.yaml')],
    { cwd: checkoutRoot, timeout: TOOL_TIMEOUT_MS },
  );
  const installed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (
    !installed ||
    typeof installed !== 'object' ||
    !('name' in installed) ||
    installed.name !== '@biomejs/biome' ||
    !('version' in installed) ||
    typeof installed.version !== 'string'
  )
    throw new Error('Taste publication requires a verifiable local Biome package');
  const { stdout } = await execTool(binaryPath, ['--version'], { cwd: checkoutRoot, timeout: TOOL_TIMEOUT_MS });
  if (stdout.trim() !== `Version: ${installed.version}`) {
    throw new Error(`Biome binary version mismatch: expected ${installed.version}`);
  }

  const packageLink = join(checkoutRoot, 'node_modules/@biomejs/biome');
  const binaryLink = join(checkoutRoot, 'node_modules/.bin/biome');
  mkdirSync(dirname(packageLink), { recursive: true });
  mkdirSync(dirname(binaryLink), { recursive: true });
  symlinkSync(realpathSync(dirname(packagePath)), packageLink, 'dir');
  symlinkSync(realpathSync(binaryPath), binaryLink);
}
