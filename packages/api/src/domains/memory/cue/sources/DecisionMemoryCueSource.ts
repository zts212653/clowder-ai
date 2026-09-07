import type { EvidenceItem, IEvidenceStore } from '../../interfaces.js';
import type { MemoryCueEpisodeStore } from '../MemoryCueEpisodeStore.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import { canonicalProjectDocumentWindow, readCanonicalProjectDocument } from './canonical-project-document.js';

const DECISION_ANCHOR = /^ADR-\d{3}$/;
const DECISION_PATH = /^decisions\/[^/]+\.md$/;
const INACTIVE_STATUSES = new Set(['invalidated', 'superseded', 'retired', 'archived']);

function isDecisionIndexItem(item: EvidenceItem | null, anchor: string): item is EvidenceItem {
  return Boolean(
    item &&
      item.anchor === anchor &&
      item.kind === 'decision' &&
      item.sourcePath &&
      DECISION_PATH.test(item.sourcePath) &&
      !INACTIVE_STATUSES.has(item.status),
  );
}

function isAcceptedDecision(content: string): boolean {
  const header = content.slice(0, 2_000);
  const frontmatter = header.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
  if (/^status:\s*accepted(?:\s|$)/imu.test(frontmatter)) return true;
  return /^(?:>\s*)?(?:\*\*)?Status(?:\*\*)?:\s*accepted(?:\s|$)/imu.test(header);
}

export type DecisionMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' | 'superseded' };

export class DecisionMemoryCueSource {
  constructor(
    private readonly deps: {
      projectDocsRoot: string;
      evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>;
      episodeStore: Pick<MemoryCueEpisodeStore, 'hasTerminalConsumptionForSource'>;
    },
  ) {}

  async resolve(input: { ownerUserId: string; decisionAnchor: string }): Promise<MemoryCueSourceProjection | null> {
    if (!DECISION_ANCHOR.test(input.decisionAnchor)) return null;
    const item = await this.deps.evidenceStore.getByAnchor(input.decisionAnchor);
    if (!isDecisionIndexItem(item, input.decisionAnchor)) return null;
    if (item.supersededBy) return null;
    const document = await readCanonicalProjectDocument(this.deps.projectDocsRoot, item.sourcePath);
    if (!document) return null;
    if (!isAcceptedDecision(document.content)) return null;
    if (
      this.deps.episodeStore.hasTerminalConsumptionForSource({
        ownerUserId: input.ownerUserId,
        resolverFamily: 'decision',
        sourceAnchor: item.anchor,
        sourceRevision: document.revision,
      })
    ) {
      return null;
    }
    return {
      title: item.title,
      summary: item.summary ?? 'An accepted decision is available at the exact referenced revision.',
      anchor: item.anchor,
      revision: document.revision,
      visibility: 'owner_public',
      drillFamily: 'evidence',
    };
  }

  async read(input: { anchor: string; expectedRevision: string }): Promise<DecisionMemoryCueReadResult> {
    if (!DECISION_ANCHOR.test(input.anchor)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const item = await this.deps.evidenceStore.getByAnchor(input.anchor);
    if (!item) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (item.status === 'superseded') {
      return { status: 'not_available', invalidationReason: 'superseded' };
    }
    if (item.supersededBy) {
      return { status: 'not_available', invalidationReason: 'superseded' };
    }
    if (!isDecisionIndexItem(item, input.anchor)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const document = await readCanonicalProjectDocument(this.deps.projectDocsRoot, item.sourcePath);
    if (!document) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (document.revision !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    if (!isAcceptedDecision(document.content)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    return {
      status: 'ok',
      payload: {
        anchor: item.anchor,
        accepted: true,
        title: item.title,
        summary: item.summary,
        sourcePath: document.sourcePath,
        sourceRevision: document.revision,
        ...canonicalProjectDocumentWindow(document.content),
      },
    };
  }
}
