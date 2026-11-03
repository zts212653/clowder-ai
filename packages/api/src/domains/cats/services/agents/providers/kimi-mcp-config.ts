import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { resolveBinaryRoot } from '../../../../../config/capabilities/capability-orchestrator.js';
import { isSameCapabilityRoot } from '../../../../../config/capabilities/invoke-capability-root.js';
import { resolveKimiRuntimePaths } from '../../../../../utils/kimi-cli-runtime.js';
import { pathsEqual } from '../../../../../utils/project-path.js';
import { prepareKimiMcpCredentialLease } from './kimi-mcp-credential-lease.js';
import { captureKimiMcpSurface, type KimiMcpConfigPlan, resolveKimiMcpSurface } from './kimi-mcp-surface.js';

export interface KimiMcpLease {
  env: Record<string, string>;
  dispose(): Promise<void>;
}

/** link is exclusive: an editor's new target must never be replaced during restoration. */
async function restoreWithoutOverwrite(source: string, target: string): Promise<void> {
  await link(source, target);
  await unlink(source);
}

function isNativeHomeDirectory(directory: string, nativeDirectory: string): boolean {
  return (
    isSameCapabilityRoot(directory, nativeDirectory) ||
    (pathsEqual(basename(directory), basename(nativeDirectory)) &&
      isSameCapabilityRoot(dirname(directory), dirname(nativeDirectory)))
  );
}

/** Kimi Code has no invoke-time MCP flag: lend it a native project config.
 * Keep the original file intact under a recoverable name until the client exits.
 * A second invocation must not replace the first invocation's capability surface.
 */
export async function captureKimiMcpConfig(input: {
  callbackEnv: Record<string, string>;
  workingDirectory?: string;
  mcpServerPath?: string;
  mcpSupport?: boolean;
}): Promise<KimiMcpConfigPlan> {
  const mcpSupport = input.mcpSupport ?? catRegistry.tryGet(input.callbackEnv.CAT_CAFE_CAT_ID)?.config.mcpSupport;
  const nativeDirectory = resolveKimiRuntimePaths(input.callbackEnv).shareDir;
  if (input.mcpServerPath === '' && mcpSupport !== false) return { nativeDirectory, denialLayers: [] };
  if (!input.workingDirectory) throw new Error('Kimi MCP injection requires an explicit working directory');
  const binaryRoot = resolveBinaryRoot(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../..'));
  return captureKimiMcpSurface({
    ...input,
    workingDirectory: input.workingDirectory,
    nativeDirectory,
    mcpSupport,
    mcpServerPath: input.mcpServerPath ?? join(binaryRoot, 'packages/mcp-server/dist/index.js'),
  });
}

export async function prepareKimiMcpConfig(input: {
  callbackEnv?: Record<string, string>;
  workingDirectory?: string;
  mcpServerPath?: string;
  frozenKimiMcpConfig?: KimiMcpConfigPlan;
}): Promise<KimiMcpLease> {
  const noop: KimiMcpLease = { env: {}, dispose: async () => {} };
  if (!input.callbackEnv?.CAT_CAFE_CAT_ID) return noop;
  const plan = input.frozenKimiMcpConfig ?? (await captureKimiMcpConfig({ ...input, callbackEnv: input.callbackEnv }));
  const nativeEnvironment = { KIMI_CODE_HOME: plan.nativeDirectory };
  if (!plan.mcpConfig) return { ...noop, env: nativeEnvironment };
  if (!input.workingDirectory) throw new Error('Kimi MCP injection requires an explicit working directory');
  // Project entries shadow native HOME entries. Explicitly block native-only
  // servers so the managed invocation cannot bypass the capability registry.
  const nativeDirectory = plan.nativeDirectory;
  const directory = join(input.workingDirectory, '.kimi-code');
  // Compare existing parents too: first use may not have created either leaf yet.
  if (isNativeHomeDirectory(directory, nativeDirectory)) {
    throw new Error('Refusing to replace the native HOME Kimi MCP configuration');
  }
  const credentials = await prepareKimiMcpCredentialLease(input.callbackEnv);
  try {
    const servers = await resolveKimiMcpSurface({
      workingDirectory: input.workingDirectory,
      callbackEnv: { ...input.callbackEnv, ...credentials.env },
      mcpServerPath: input.mcpServerPath ?? '',
      nativeDirectory,
      frozenKimiMcpConfig: plan,
      credentialFile: credentials.path,
    });
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Refusing a linked Kimi MCP directory');
    const file = join(directory, 'mcp.json');
    const lock = join(directory, '.clowder-mcp.lock');
    const backup = join(directory, `.clowder-mcp-original-${randomUUID()}.json`);
    const handle = await open(lock, 'wx', 0o600).catch(() => {
      throw new Error(`Kimi MCP workspace is in use or requires recovery: ${lock}`);
    });
    let original = false;
    let installed = false;
    const rendered = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, file, backup }));
      await handle.close();
      const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
          throw new Error('Refusing a linked or non-file Kimi MCP configuration');
        }
        await rename(file, backup);
        original = true;
      }
      await writeFile(file, rendered, { flag: 'wx', mode: 0o600 });
      installed = true;
    } catch (error) {
      await handle.close().catch(() => {});
      if (original && !installed) {
        await restoreWithoutOverwrite(backup, file).catch((failure: unknown) => {
          throw new Error(`Kimi MCP installation conflicted; original preserved at ${backup}`, { cause: failure });
        });
      }
      await unlink(lock);
      throw error;
    }
    let disposed = false;
    return {
      // Only the capability set resolved by Clowder is written to this project file.
      // This trust applies to the managed child process, never to the user's native HOME.
      env: { ...nativeEnvironment, KIMI_CODE_TRUST_WORKSPACE: '1', ...credentials.env },
      async dispose() {
        try {
          if (disposed) return;
          // Capture the current inode before inspecting it. An atomic save after this
          // rename creates a new target which exclusive restoration cannot overwrite.
          const parked = join(directory, `.clowder-mcp-current-${randomUUID()}.json`);
          await rename(file, parked);
          if ((await readFile(parked, 'utf8')) !== rendered) {
            await restoreWithoutOverwrite(parked, file).catch((failure: unknown) => {
              throw new Error(`Kimi MCP recovery required; current preserved at ${parked}, original at ${backup}`, {
                cause: failure,
              });
            });
            throw new Error(`Kimi MCP configuration changed during invocation; original preserved at ${backup}`);
          }
          if (original) await restoreWithoutOverwrite(backup, file);
          await unlink(parked);
          await unlink(lock);
          disposed = true;
        } finally {
          await credentials.dispose();
        }
      },
    };
  } catch (error) {
    await credentials.dispose();
    throw error;
  }
}
