import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HOST_MEMBER_WORKSPACE_DIRECTORY } from '../../../utils/persistent-project-path.js';
import { freezeExecutionWorkspace } from '../../cats/services/agents/invocation/execution-workspace.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { readMemberThreadBinding } from './threads.js';
import type { MemberSessionScope, MemberSessionServices, PrepareMemberSession } from './types.js';
import { digest } from './validation.js';

/** Root owns this empty execution cwd; game diaries and scripts retain their
 * existing plugin storage. It never creates a matching source-checkout twin. */
export function createMemberWorkspaces(deps: {
  readonly projectRoot: string;
  readonly threads: IThreadStore;
  readonly storage: MemberSessionServices['storage'];
  assertInstallation(scope: MemberSessionScope): Promise<unknown>;
}) {
  const create = async (scope: MemberSessionScope, catId: string) => {
    await deps.assertInstallation(scope);
    const path = join(
      deps.projectRoot,
      HOST_MEMBER_WORKSPACE_DIRECTORY,
      digest([scope.ownerUserId, scope.pluginInstanceId, catId]),
    );
    await mkdir(path, { recursive: true, mode: 0o700 });
    await scope.assertCurrent();
    return path;
  };
  return {
    create,
    async freeze(input: PrepareMemberSession, scope: MemberSessionScope, provider?: string) {
      const thread = await deps.threads.get(input.threadId);
      if (thread?.projectPath === 'default') {
        const binding = await readMemberThreadBinding(deps.storage, input.threadId);
        if (
          binding?.ownerUserId === scope.ownerUserId &&
          binding.pluginInstanceId === scope.pluginInstanceId &&
          binding.catId === input.catId &&
          thread.createdBy === scope.ownerUserId
        ) {
          const path = await create(scope, input.catId);
          await deps.threads.updateProjectPath(input.threadId, path);
          await scope.assertCurrent();
        }
      }
      return freezeExecutionWorkspace({
        threadStore: deps.threads,
        threadId: input.threadId,
        userId: scope.ownerUserId,
        provider,
      });
    },
  };
}
