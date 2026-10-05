import { WorkspaceContentReviewError } from '../../../domains/collaborative-content/workspace-review/errors.js';
import { probeEvolutionMedia } from '../../../domains/collaborative-content/workspace-review/evolution-media-probe.js';
import type { EvolutionMediaReadPort } from '../../../domains/collaborative-content/workspace-review/evolution-review-source.js';
import { EvolutionExplorationReadError, resolveAuthorizedExplorationProgram } from './program-exploration-access.js';
import { readPublishedExplorationMedia } from './program-exploration-media.js';

/** No authorization is minted here: the transport verifies the caller, then the original owner reauthorizes every read. */
export function createProgramContentMediaPort(
  deps: Parameters<typeof resolveAuthorizedExplorationProgram>[0],
): EvolutionMediaReadPort {
  return {
    async read(locator, principal) {
      try {
        const resolved = await resolveAuthorizedExplorationProgram(deps, locator.programId, principal.userId);
        const result = await readPublishedExplorationMedia(resolved, locator);
        return {
          bytes: result.bytes,
          mime: result.media.contentType,
          label: result.media.label,
          media: await probeEvolutionMedia(result.bytes, result.media.contentType),
        };
      } catch (error) {
        if (error instanceof EvolutionExplorationReadError)
          throw new WorkspaceContentReviewError(error.status === 404 ? 'access_denied' : 'source_unavailable');
        throw error;
      }
    },
  };
}
