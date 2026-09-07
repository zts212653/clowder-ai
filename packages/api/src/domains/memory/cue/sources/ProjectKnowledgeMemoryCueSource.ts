import type { EvidenceItem, IEvidenceStore } from '../../interfaces.js';
import type { MemoryCueEpisodeStore } from '../MemoryCueEpisodeStore.js';
import type { MemoryCueSourceProjection } from '../MemoryCueResolverRegistry.js';
import { canonicalProjectDocumentWindow, readCanonicalProjectDocument } from './canonical-project-document.js';

const FEATURE_ANCHOR = /^F\d{3,}$/;
const FEATURE_PATH = /^features\/F\d{3,}-[^/]+\.md$/;
const INACTIVE_STATUSES = new Set(['invalidated', 'superseded', 'retired', 'archived']);

function isFeatureIndexItem(item: EvidenceItem | null, featureId: string): item is EvidenceItem {
  return Boolean(
    item &&
      item.anchor === featureId &&
      item.kind === 'feature' &&
      item.sourcePath &&
      FEATURE_PATH.test(item.sourcePath) &&
      item.sourcePath.split('/').at(-1)?.startsWith(`${featureId}-`) &&
      !INACTIVE_STATUSES.has(item.status),
  );
}

export type ProjectKnowledgeMemoryCueReadResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'not_available'; invalidationReason: 'source_corrected' | 'source_forgotten' | 'superseded' };

export class ProjectKnowledgeMemoryCueSource {
  constructor(
    private readonly deps: {
      projectDocsRoot: string;
      evidenceStore: Pick<IEvidenceStore, 'getByAnchor'>;
      episodeStore: Pick<MemoryCueEpisodeStore, 'hasTerminalConsumptionForSource'>;
    },
  ) {}

  async resolve(input: { ownerUserId: string; featureId: string }): Promise<MemoryCueSourceProjection | null> {
    if (!FEATURE_ANCHOR.test(input.featureId)) return null;
    const item = await this.deps.evidenceStore.getByAnchor(input.featureId);
    if (!isFeatureIndexItem(item, input.featureId)) return null;
    const document = await readCanonicalProjectDocument(this.deps.projectDocsRoot, item.sourcePath);
    if (!document) return null;
    if (
      this.deps.episodeStore.hasTerminalConsumptionForSource({
        ownerUserId: input.ownerUserId,
        resolverFamily: 'project_knowledge',
        sourceAnchor: item.anchor,
        sourceRevision: document.revision,
      })
    ) {
      return null;
    }
    return {
      title: item.title,
      summary: item.summary ?? 'The exact feature source for this task is available to drill.',
      anchor: item.anchor,
      revision: document.revision,
      visibility: 'owner_public',
      drillFamily: 'evidence',
    };
  }

  async read(input: { anchor: string; expectedRevision: string }): Promise<ProjectKnowledgeMemoryCueReadResult> {
    if (!FEATURE_ANCHOR.test(input.anchor)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const item = await this.deps.evidenceStore.getByAnchor(input.anchor);
    if (!item) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (item.status === 'superseded' || item.supersededBy) {
      return { status: 'not_available', invalidationReason: 'superseded' };
    }
    if (!isFeatureIndexItem(item, input.anchor)) {
      return { status: 'not_available', invalidationReason: 'source_forgotten' };
    }
    const document = await readCanonicalProjectDocument(this.deps.projectDocsRoot, item.sourcePath);
    if (!document) return { status: 'not_available', invalidationReason: 'source_forgotten' };
    if (document.revision !== input.expectedRevision) {
      return { status: 'not_available', invalidationReason: 'source_corrected' };
    }
    return {
      status: 'ok',
      payload: {
        anchor: item.anchor,
        title: item.title,
        summary: item.summary,
        sourcePath: document.sourcePath,
        sourceRevision: document.revision,
        ...canonicalProjectDocumentWindow(document.content),
      },
    };
  }
}
