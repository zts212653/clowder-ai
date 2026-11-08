import type { CatId } from '@cat-cafe/shared';
import { z } from 'zod';
import type { KnowledgeDiscoverySource } from '../../knowledge-discovery.js';
import type { MessageSearchService } from '../../MessageSearchService.js';
import type { MatterMemoryService } from '../../matters/MatterMemoryService.js';
import { matchExplicitApprovedTasteTrigger } from '../ExplicitApprovedTasteTriggerCatalog.js';
import type { ContextProjectCueSource } from '../sources/ContextProjectCueSource.js';
import type { CanonicalTasteMemoryCueSource } from '../sources/TasteMemoryCueSource.js';
import { type PreparationSource, projectPreparationSource } from './project-preparation-source.js';
import type { PreparationDiscoveryInput, WorkPreparationSources } from './WorkPreparationService.js';

const MESSAGE_PREFIX = 'message-cue:';
const messageCoordinateSchema = z
  .object({ threadId: z.string().min(1).max(200), messageId: z.string().min(1).max(200) })
  .strict();
function messageCoordinate(anchor: string) {
  try {
    return messageCoordinateSchema.parse(
      JSON.parse(Buffer.from(anchor.slice(MESSAGE_PREFIX.length), 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
}

/** Only these existing owners can turn a candidate into a pointer or an original-source read. */
export class OwnerPreparationSources implements WorkPreparationSources {
  constructor(
    private readonly deps: {
      project?: ContextProjectCueSource;
      messages?: MessageSearchService;
      matters?: MatterMemoryService;
      taste: CanonicalTasteMemoryCueSource;
    },
  ) {}

  async create({ record, query, signal }: PreparationDiscoveryInput) {
    const sources: KnowledgeDiscoverySource<unknown, PreparationSource>[] = [];
    const principal = {
      userId: record.scope.ownerUserId,
      viewer: { type: 'cat' as const, catId: record.consumerCatId as CatId },
      source: { threadId: record.scope.threadId, messageId: record.sourceMessageId },
      publicReply: true,
    };
    const documents = await this.deps.project?.discoverySource({ scope: record.scope, query, signal });
    if (documents)
      sources.push(projectPreparationSource(documents, async (source) => ({ family: 'project_knowledge', source })));
    if (this.deps.messages) {
      const messages = this.deps.messages.discoverySource({ query, mode: 'hybrid' }, principal, { signal });
      sources.push(
        projectPreparationSource(messages, async (row) => {
          const anchor =
            MESSAGE_PREFIX +
            Buffer.from(JSON.stringify({ threadId: row.threadId, messageId: row.messageId })).toString('base64url');
          return anchor.length > 500
            ? null
            : {
                family: 'message_evidence',
                source: {
                  anchor,
                  revision: row.contentRevision,
                  title: 'Original message source',
                  summary: 'Read the original message, speaker, timestamp and conditions.',
                  asOf: row.result.timestamp,
                  visibility: 'owner_private',
                  drillFamily: 'evidence',
                },
              };
        }),
      );
    }
    if (this.deps.matters) {
      const matters = this.deps.matters;
      const native = matters.discoverySource(principal, { threadId: record.scope.threadId, query, signal });
      sources.push(
        projectPreparationSource(native, async (row, lifetime) => {
          const page = await matters.project({ ...principal, signal: lifetime.signal ?? signal }, row.item.matterId);
          if (
            !page ||
            page.summaryStatus ||
            page.matter.status !== 'active' ||
            page.matter.revision !== row.item.revision
          )
            return null;
          const entries = page.entries
            .filter((entry) => entry.status === 'active' && entry.sourceStatus === 'current' && entry.quote)
            .map((entry) => ({ entryId: entry.entryId, sourceRevision: entry.source.sourceRevision }));
          if (!entries.length) return null;
          return {
            family: 'matter',
            source: {
              anchor: `matter:${page.matter.matterId}`,
              revision: `revision:${page.matter.revision}`,
              title: 'Sourced Matter page',
              summary: 'Read all supporting messages and verify the page conditions.',
              visibility: 'owner_private',
              drillFamily: 'matter',
            },
            matterReadDetails: { matterId: page.matter.matterId, pageRevision: page.matter.revision, entries },
          };
        }),
      );
    }
    // Preserve the approved ELI5 mapping. HTML/video alone cannot widen its admission.
    const trigger = matchExplicitApprovedTasteTrigger(query);
    if (trigger) {
      const taste = this.deps.taste;
      const project = () =>
        taste.resolveExplicit({ ownerUserId: record.scope.ownerUserId, triggerKey: trigger.triggerKey });
      const native = {
        id: 'approved-taste',
        read: async () => ({ candidates: [trigger] }),
        project,
        revalidate: async (item: NonNullable<Awaited<ReturnType<typeof project>>>) => {
          const fresh = await project();
          return fresh?.revision === item.revision ? fresh : null;
        },
        key: (item: NonNullable<Awaited<ReturnType<typeof project>>>) => item.sourcePath,
      };
      sources.push(
        projectPreparationSource(native, async (item) => ({
          family: 'taste',
          resolverVersion: 3,
          source: {
            anchor: `taste-vignette:${item.sourcePath}`,
            revision: item.revision,
            title: 'Approved ELI5 Taste',
            summary: 'Read the original approved scope and application contract.',
            visibility: item.visibility,
            drillFamily: 'taste',
          },
        })),
      );
    }
    return sources;
  }

  async read(
    record: Parameters<WorkPreparationSources['read']>[0],
    request: Parameters<WorkPreparationSources['read']>[1],
    prepared: Parameters<WorkPreparationSources['read']>[2],
  ) {
    if (request.anchor.startsWith('project-collection:') && this.deps.project)
      return this.deps.project.read({
        scope: request.scope,
        anchor: request.anchor,
        expectedRevision: request.expectedRevision,
        window: request.window,
      });
    if (request.family === 'matter' && prepared.matterReadDetails && this.deps.matters) {
      const read = await this.deps.matters.readReceipt(
        record.scope.ownerUserId,
        record.consumerCatId as CatId,
        prepared.matterReadDetails,
        true,
      );
      return read.status === 'current'
        ? { status: 'ok' as const, payload: read.page }
        : {
            status: 'not_available' as const,
            invalidationReason: read.status === 'changed' ? ('source_corrected' as const) : ('scope_revoked' as const),
          };
    }
    if (request.family === 'taste')
      return this.deps.taste.read({
        ownerUserId: record.scope.ownerUserId,
        anchor: request.anchor,
        expectedRevision: request.expectedRevision,
      });
    if (request.anchor.startsWith(MESSAGE_PREFIX) && this.deps.messages)
      return this.readMessage(record, request, this.deps.messages);
    return { status: 'not_available' as const, invalidationReason: 'source_forgotten' as const };
  }
  private async readMessage(
    record: Parameters<WorkPreparationSources['read']>[0],
    request: Parameters<WorkPreparationSources['read']>[1],
    messages: MessageSearchService,
  ) {
    const ref = messageCoordinate(request.anchor);
    const read = ref
      ? await messages.resolveNavigationReference(
          { ...ref, contentRevision: request.expectedRevision },
          {
            userId: record.scope.ownerUserId,
            viewer: { type: 'cat', catId: record.consumerCatId as CatId },
            source: { threadId: record.scope.threadId, messageId: record.sourceMessageId },
            publicReply: true,
          },
          0,
        )
      : null;
    if (read && !read.updated && read.message) return { status: 'ok' as const, payload: read };
    return {
      status: 'not_available' as const,
      invalidationReason: read?.updated ? ('source_corrected' as const) : ('scope_revoked' as const),
    };
  }
}
