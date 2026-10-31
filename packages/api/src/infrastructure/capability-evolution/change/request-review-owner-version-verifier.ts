import type { ExactAssetVersionRefV1 } from '@cat-cafe/shared';
import type { RequestReviewOwnerPort } from '../adapters/request-review/request-review-owner-adapter.js';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_SKILL_FILE,
} from '../adapters/request-review/request-review-owner-identity.js';
import {
  requestReviewImmutableEnvelope,
  requestReviewSemanticVersion,
} from '../adapters/request-review/request-review-owner-port.js';

async function semanticVersionAt(port: RequestReviewOwnerPort, commitSha: string): Promise<string> {
  return requestReviewSemanticVersion(await port.readSkillFileAt(commitSha, REQUEST_REVIEW_SKILL_FILE));
}

export function createRequestReviewCommitVersionVerifier(port: RequestReviewOwnerPort) {
  return {
    async verifyCommitVersion(commitSha: string, versionRef: ExactAssetVersionRefV1): Promise<boolean> {
      if (!isRequestReviewAssetVersionRef(versionRef)) return false;
      try {
        return (await semanticVersionAt(port, commitSha)) === versionRef.version;
      } catch {
        return false;
      }
    },
    async verifyAllowedTransition(
      previousVersionRef: ExactAssetVersionRefV1,
      commitSha: string,
      nextVersionRef: ExactAssetVersionRefV1,
    ): Promise<boolean> {
      if (
        !isRequestReviewAssetVersionRef(previousVersionRef) ||
        !isRequestReviewAssetVersionRef(nextVersionRef) ||
        previousVersionRef.version === nextVersionRef.version
      ) {
        return false;
      }
      try {
        const nextSource = await port.readSkillFileAt(commitSha, REQUEST_REVIEW_SKILL_FILE);
        if (requestReviewSemanticVersion(nextSource) !== nextVersionRef.version) return false;
        const history = await port.listFileHistoryAt(commitSha, REQUEST_REVIEW_SKILL_FILE, 512);
        for (const entry of history) {
          const previousSource = await port
            .readSkillFileAt(entry.commitOid, REQUEST_REVIEW_SKILL_FILE)
            .catch(() => null);
          if (!previousSource || requestReviewSemanticVersion(previousSource) !== previousVersionRef.version) continue;
          return requestReviewImmutableEnvelope(previousSource) === requestReviewImmutableEnvelope(nextSource);
        }
        return false;
      } catch {
        return false;
      }
    },
    async isKnownVersion(versionRef: ExactAssetVersionRefV1): Promise<boolean> {
      if (!isRequestReviewAssetVersionRef(versionRef)) return false;
      try {
        const headOid = await port.gitHeadOid();
        const current = await semanticVersionAt(port, headOid);
        if (current === versionRef.version) return true;
        for (const entry of await port.listFileHistoryAt(headOid, REQUEST_REVIEW_SKILL_FILE, 512)) {
          if ((await semanticVersionAt(port, entry.commitOid).catch(() => undefined)) === versionRef.version)
            return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}
