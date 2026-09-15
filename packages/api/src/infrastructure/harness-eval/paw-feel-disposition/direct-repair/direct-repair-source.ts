import { type OwnerTruthRefV1, ownerTruthRefV1Schema, type PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import { inspectPawFeelMessage } from '../../friction/paw-feel-source.js';
import { PawFeelDirectRepairError } from './direct-repair-errors.js';

export interface VerifiedPawFeelDirectRepairSourceContext {
  sourceSignalRef: OwnerTruthRefV1;
  sourceToolRef: OwnerTruthRefV1;
  markerDigest: string;
  sameDigestOrdinal: number;
  markerIndex: number;
}

export interface VerifiedPawFeelSourceIdentityContext {
  sourceSignalRef: OwnerTruthRefV1;
  markerDigest: string;
  sameDigestOrdinal: number;
  markerIndex: number;
  tool?: string;
}

export interface PawFeelDirectRepairSourceVerifierOptions {
  messageStore: Pick<IMessageStore, 'getById'>;
  classifyTool(tool: string): OwnerTruthRefV1 | null | Promise<OwnerTruthRefV1 | null>;
}

export function derivePawFeelSourceSignalRef(projection: PawFeelDispositionProjection): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F278',
    ownerStateRef: `paw-feel-signal:${projection.signalId}`,
    version: `${projection.markerDigest}:${projection.sameDigestOrdinal}`,
  });
}

export function defaultPawFeelSourceToolClassifier(tool: string): OwnerTruthRefV1 | null {
  const normalized = tool.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'cat_cafe_record_memory_cue_outcome') {
    return ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F287',
      ownerStateRef: `mcp-tool:${normalized}`,
    });
  }
  if (normalized === 'cat_cafe_list_tasks') {
    return ownerTruthRefV1Schema.parse({
      ownerFeatureId: 'F160',
      ownerStateRef: `mcp-tool:${normalized}`,
    });
  }
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F278',
    ownerStateRef: `paw-feel-tool:${encodeURIComponent(normalized)}`,
  });
}

export class PawFeelDirectRepairSourceVerifier {
  constructor(private readonly options: PawFeelDirectRepairSourceVerifierOptions) {}

  async verifyIdentity(projection: PawFeelDispositionProjection): Promise<VerifiedPawFeelSourceIdentityContext> {
    let message: StoredMessage | null;
    try {
      message = await this.options.messageStore.getById(projection.sourceMessageId);
    } catch (error) {
      throw new PawFeelDirectRepairError(
        'source_unavailable',
        `canonical source read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!message) throw new PawFeelDirectRepairError('source_unavailable', 'canonical source message is unavailable');
    if (
      message.id !== projection.sourceMessageId ||
      message.threadId !== projection.sourceThreadId ||
      message.catId !== projection.sourceCatId
    ) {
      throw new PawFeelDirectRepairError('source_mismatch', 'canonical source identity changed');
    }
    const inspection = inspectPawFeelMessage(message);
    const candidate =
      inspection.kind === 'canonical'
        ? inspection.candidates.find(
            (entry) =>
              entry.markerDigest === projection.markerDigest &&
              entry.sameDigestOrdinal === projection.sameDigestOrdinal,
          )
        : undefined;
    if (
      !candidate ||
      candidate.signalId !== projection.signalId ||
      candidate.sourceThreadId !== projection.sourceThreadId ||
      candidate.sourceCatId !== projection.sourceCatId
    ) {
      throw new PawFeelDirectRepairError('source_mismatch', 'canonical source marker digest or ordinal changed');
    }
    const tool = candidate.marker.tool?.trim();
    return {
      sourceSignalRef: derivePawFeelSourceSignalRef(projection),
      markerDigest: projection.markerDigest,
      sameDigestOrdinal: projection.sameDigestOrdinal,
      markerIndex: candidate.markerIndex,
      ...(tool ? { tool } : {}),
    };
  }

  async verify(projection: PawFeelDispositionProjection): Promise<VerifiedPawFeelDirectRepairSourceContext> {
    const identity = await this.verifyIdentity(projection);
    const tool = identity.tool;
    if (!tool) throw new PawFeelDirectRepairError('source_tool_unclassified', 'source marker has no tool route');
    let classified: OwnerTruthRefV1 | null;
    try {
      classified = await this.options.classifyTool(tool);
    } catch (error) {
      throw new PawFeelDirectRepairError(
        'source_tool_unclassified',
        `source tool classifier failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!classified) throw new PawFeelDirectRepairError('source_tool_unclassified', 'source tool route is unknown');
    return {
      sourceSignalRef: identity.sourceSignalRef,
      sourceToolRef: ownerTruthRefV1Schema.parse(classified),
      markerDigest: identity.markerDigest,
      sameDigestOrdinal: identity.sameDigestOrdinal,
      markerIndex: identity.markerIndex,
    };
  }
}
