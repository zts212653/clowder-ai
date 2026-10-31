import {
  type ChangeCollectiveProjectArtifactRequest,
  collectiveProjectArtifactChangeSchema,
  collectiveProjectArtifactListSchema,
} from '@cat-cafe/shared';
import type { ClientRequest } from './client-request.js';
import { acknowledgeCollaborationCommand, prepareCollaborationCommand } from './collaboration-command-custody.js';

type OmitCommand<T> = T extends unknown ? Omit<T, 'serviceInstanceId' | 'collectiveId' | 'requestId'> : never;
export type ProjectArtifactChange = OmitCommand<ChangeCollectiveProjectArtifactRequest>;
export function projectArtifactClient(
  request: ClientRequest,
  coordinates: { serviceInstanceId: string; collectiveId: string },
  namespace: string,
) {
  const post = (path: string, body: unknown) =>
    request(`/api/collaboration/projects/artifacts/${path}`, {
      method: 'POST',
      body: JSON.stringify({ ...coordinates, ...(body as object) }),
    });
  return {
    namespace,
    list: async (roadmapId: string, page: { offset?: number; expectedSnapshot?: string } = {}) => {
      const feed = collectiveProjectArtifactListSchema.parse(await post('list', { roadmapId, ...page }));
      if (
        feed.serviceInstanceId !== coordinates.serviceInstanceId ||
        feed.collectiveId !== coordinates.collectiveId ||
        feed.roadmapId !== roadmapId ||
        feed.offset !== (page.offset ?? 0) ||
        (page.expectedSnapshot && feed.snapshot !== page.expectedSnapshot) ||
        feed.items.some(
          (item) =>
            item.reference.roadmapId !== roadmapId ||
            item.reference.serviceInstanceId !== coordinates.serviceInstanceId ||
            item.reference.collectiveId !== coordinates.collectiveId,
        )
      )
        throw new Error('项目引用已改变，请重新读取。');
      return feed;
    },
    change: async (input: ProjectArtifactChange) => {
      const intent = { path: 'project-artifact-reference', ...input };
      const requestId = prepareCollaborationCommand(localStorage, namespace, intent);
      const result = collectiveProjectArtifactChangeSchema.parse(await post('change', { ...input, requestId }));
      if (
        result.item &&
        (result.item.reference.artifactId !== input.artifactId ||
          result.item.reference.roadmapId !== input.roadmapId ||
          result.item.reference.serviceInstanceId !== coordinates.serviceInstanceId ||
          result.item.reference.collectiveId !== coordinates.collectiveId)
      )
        throw new Error('项目引用已改变，请重新读取。');
      acknowledgeCollaborationCommand(localStorage, namespace, requestId);
      window.dispatchEvent(new Event('collective:project-artifacts-changed'));
      return result;
    },
  };
}
