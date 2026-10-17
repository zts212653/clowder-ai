import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublicInvocationExecution } from '../../cats/services/agents/invocation/public-invocation-execution.js';
import type { PublicInvocationLaunchLease } from './public-invocation-launch.js';

/** Filesystem ownership is separate from launch authority: a revoked invocation
 * must still be able to clean its own files, but never a replacement directory.
 * The private container is not passed to the provider. No owner files are copied.
 * These identity checks are not a substitute for the provider's OS sandbox. */
function allocatePublicWorkspace() {
  const container = mkdtempSync(join(realpathSync(tmpdir()), 'clowder-public-invocation-'));
  const containerIdentity = lstatSync(container);
  const workspaceRoot = join(container, 'workspace');
  let workspaceIdentity: Stats | undefined;
  let removed = false;

  const assertIdentity = (path: string, expected: Stats) => {
    const current = lstatSync(path);
    if (
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      realpathSync(path) !== path
    ) {
      throw new Error('public_workspace_identity_changed');
    }
    return current;
  };
  const dispose = () => {
    if (removed) return;
    assertIdentity(container, containerIdentity);
    if (workspaceIdentity) assertIdentity(workspaceRoot, workspaceIdentity);
    // No JS suspension between the ownership checks and removal. rmSync does
    // not follow symlinks inside this owned tree. Failure remains retryable.
    rmSync(container, { recursive: true });
    removed = true;
  };
  try {
    mkdirSync(workspaceRoot, { mode: 0o700 });
    workspaceIdentity = lstatSync(workspaceRoot);
    const assertCurrent = () => {
      if (removed || !workspaceIdentity) throw new Error('public_workspace_closed');
      const parent = assertIdentity(container, containerIdentity);
      const workspace = assertIdentity(workspaceRoot, workspaceIdentity);
      if ((parent.mode & 0o777) !== 0o700 || (workspace.mode & 0o777) !== 0o700) {
        throw new Error('public_workspace_permissions_changed');
      }
    };
    assertCurrent();
    return Object.freeze({ workspaceRoot, assertCurrent, dispose });
  } catch (error) {
    cleanAfterFailure(error, dispose);
  }
}

function cleanAfterFailure(error: unknown, dispose: () => void): never {
  try {
    dispose();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'public_preparation_cleanup_failed', { cause: error });
  }
  throw error;
}

/** The resolver captures caller coordinates synchronously. Await its verified
 * source before allocating, then retain cleanup ownership until this resolves. */
export async function preparePublicInvocationExecution(
  authority: Promise<PublicInvocationLaunchLease>,
): ReturnType<PublicInvocationExecution['prepare']> {
  const lease = await authority;
  let workspace: ReturnType<typeof allocatePublicWorkspace>;
  try {
    workspace = allocatePublicWorkspace();
  } catch (error) {
    lease.dispose();
    throw error;
  }
  const lifetime = new AbortController();
  const invalidate = () => {
    lifetime.abort(new Error('public_preparation_closed'));
    lease.dispose();
  };
  const dispose = async () => {
    invalidate();
    workspace.dispose();
  };
  const assertCurrent = async () => {
    try {
      lifetime.signal.throwIfAborted();
      workspace.assertCurrent();
      await lease.assertCurrent();
      lifetime.signal.throwIfAborted();
      workspace.assertCurrent();
    } catch (error) {
      invalidate();
      throw error;
    }
  };
  try {
    await assertCurrent();
    lifetime.signal.throwIfAborted();
    return Object.freeze({
      source: lease.source,
      launch: Object.freeze({
        server: lease.server,
        sandbox: Object.freeze({ kind: 'public' as const, workspaceRoot: workspace.workspaceRoot }),
        assertCurrent,
      }),
      dispose,
    });
  } catch (error) {
    invalidate();
    cleanAfterFailure(error, workspace.dispose);
  }
}
