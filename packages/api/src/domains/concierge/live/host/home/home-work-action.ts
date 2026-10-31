import { isDeepStrictEqual } from 'node:util';
import type { HomeActionRequest, HomeActionTarget } from '../../../action/HomeActionController.js';
import type { CompanionWorkDestination } from '../../work/companion-work-navigation.js';
import type { LiveContextScope } from '../live-controlled-context.js';
import { sha256 } from '../page-action/live-page-action-authority-contract.js';
import type { HomeHubDelivery, HomeWorkPublication } from './home-hub-delivery.js';
import type { HomeHubPage } from './home-hub-pages.js';

/** C supplies only original publications already readable by this Host-bound cat. */
export interface HomeWorkCandidate {
  readonly id: string;
  readonly label: string;
  readonly revision: string;
  readonly destination: CompanionWorkDestination;
}
export interface HomeWorkActionPort {
  read(scope: LiveContextScope, assertCurrent: () => Promise<void>): Promise<readonly HomeWorkCandidate[]>;
  resolve(
    scope: LiveContextScope,
    candidate: HomeWorkCandidate,
    assertCurrent: () => Promise<void>,
  ): Promise<HomeWorkPublication | null>;
}
export type HomeWorkTarget = HomeActionTarget & { readonly publication: HomeWorkCandidate };

export function homeWorkTargets(candidates: readonly HomeWorkCandidate[]): HomeWorkTarget[] {
  if (candidates.length > 8) throw new Error('Invalid work candidate count');
  return candidates.map((publication) => {
    const { destination, id, label, revision } = publication;
    if (
      !id ||
      !revision ||
      !label.trim() ||
      label.length > 512 ||
      !destination.threadId ||
      !destination.messageId ||
      !destination.item ||
      !destination.artifact?.contentRef ||
      !Number.isSafeInteger(destination.artifact.ownerRevision) ||
      destination.artifact.ownerRevision < 1
    )
      throw new Error('Original work publication/version required');
    const fingerprint = sha256(JSON.stringify(publication));
    return { id: `work-${fingerprint}`, label, revision: fingerprint, operation: 'click', publication };
  });
}

/** The original publication owner re-reads at one-use consume; Hub verifies the displayed version. */
export async function executeHomeWork(
  hub: HomeHubDelivery,
  port: HomeWorkActionPort,
  scope: LiveContextScope,
  request: HomeActionRequest,
  target: HomeWorkTarget,
  assertCurrent: () => Promise<void>,
  page: HomeHubPage,
) {
  const status = await hub.openWork(
    request.userId,
    async () => {
      const resolved = await port.resolve(scope, target.publication, assertCurrent);
      const original = target.publication.destination;
      if (
        !resolved ||
        resolved.source.threadId !== original.threadId ||
        resolved.source.messageId !== original.messageId ||
        !isDeepStrictEqual(resolved.source.item, original.item) ||
        !isDeepStrictEqual(resolved.artifact, original.artifact)
      )
        return null;
      return resolved;
    },
    assertCurrent,
    request.signal,
    page,
  );
  return { status };
}
