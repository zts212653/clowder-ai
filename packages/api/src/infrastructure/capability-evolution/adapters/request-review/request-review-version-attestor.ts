import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { type ExactAssetVersionRefV1, refIdentity } from '@cat-cafe/shared';
import { computeSkillPackageRevision } from '../../../../domains/cats/services/tool-usage/SkillConsumptionReceiptService.js';
import { isSkillMountedAtPoint } from '../../../../utils/skill-mount.js';
import { isRequestReviewAssetVersionRef, requestReviewAssetVersionRef } from './request-review-owner-identity.js';
import { requestReviewSemanticVersion } from './request-review-owner-port.js';

export interface RequestReviewMountedSkillCoordinate {
  mountRoots: string[];
  expectedSkillsRoot: string;
  fallbackSkillsRoot?: string;
}

export function requestReviewMountPointForClient(clientId: string): 'claude' | 'codex' | 'gemini' | 'kimi' | null {
  if (clientId === 'anthropic') return 'claude';
  if (clientId === 'openai') return 'codex';
  if (clientId === 'google') return 'gemini';
  if (clientId === 'kimi') return 'kimi';
  return null;
}

export function createRequestReviewVersionAttestor(options: {
  resolveMount(invocationId: string): Promise<RequestReviewMountedSkillCoordinate | null>;
}) {
  return {
    async deliver(ref: ExactAssetVersionRefV1, invocationId: string) {
      if (!isRequestReviewAssetVersionRef(ref)) return { status: 'unconfirmed' as const };
      try {
        const coordinate = await options.resolveMount(invocationId);
        if (!coordinate) return { status: 'unconfirmed' as const };
        const mountedRoot = await firstMountedRoot(coordinate);
        if (!mountedRoot) return { status: 'unconfirmed' as const };
        const packageRoot = await realpath(join(mountedRoot, 'request-review'));
        const [source, deliveredPackageRevision] = await Promise.all([
          readFile(join(packageRoot, 'SKILL.md'), 'utf8'),
          computeSkillPackageRevision(mountedRoot, 'request-review'),
        ]);
        const deliveredAssetVersionRef = requestReviewAssetVersionRef(requestReviewSemanticVersion(source));
        return {
          status:
            refIdentity(ref) === refIdentity(deliveredAssetVersionRef)
              ? ('attested' as const)
              : ('unconfirmed' as const),
          deliveredAssetVersionRef,
          deliveredPackageRevision,
        };
      } catch {
        return { status: 'unconfirmed' as const };
      }
    },
  };
}

async function firstMountedRoot(coordinate: RequestReviewMountedSkillCoordinate): Promise<string | null> {
  for (const mountRoot of coordinate.mountRoots) {
    try {
      await realpath(join(mountRoot, 'request-review'));
    } catch {
      continue;
    }
    if (
      await isSkillMountedAtPoint(
        [mountRoot],
        coordinate.expectedSkillsRoot,
        'request-review',
        coordinate.fallbackSkillsRoot,
      )
    ) {
      return mountRoot;
    }
    return null;
  }
  return null;
}
