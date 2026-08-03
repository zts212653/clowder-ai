import { createHash } from 'node:crypto';
import {
  type CandidateClaimDraftId,
  type PersonMemoryResolvedSourceBundle,
  type PersonMemorySourceBundleInput,
  type PersonMemorySourceInput,
  personMemoryResolvedSourceBundleSchema,
  type ResolvedPersonMemorySource,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { isDelivered } from '../../cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../../cats/services/stores/visibility.js';

export interface PersonMemorySourceAuth {
  ownerUserId: string;
}

export interface PersonMemoryAssertionTargetResolution {
  claimDraftIds: CandidateClaimDraftId[];
  relationshipDraftId?: CandidateClaimDraftId;
  interactionDraftId?: CandidateClaimDraftId;
}

export interface OwnerPrivateArtifactResolution {
  digest: string;
  boundedText: string;
}

export interface OwnerPrivateArtifactResolver {
  resolve(ownerUserId: string, artifactLocator: string): Promise<OwnerPrivateArtifactResolution | null>;
}

export type PersonMemorySourceResolution =
  | { status: 'resolved'; bundle: PersonMemoryResolvedSourceBundle; bundleDigest: string }
  | { status: 'invalid'; error: string };

interface ResolverDeps {
  messageStore: Pick<IMessageStore, 'getById'>;
  ownerPrivateArtifactResolver?: OwnerPrivateArtifactResolver;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').trim();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestPersonMemorySourceMaterial(value: unknown): string {
  const material = typeof value === 'string' ? normalizeText(value) : stableJson(value);
  return createHash('sha256').update(material).digest('hex');
}

export function digestPersonMemoryResolvedBundle(bundle: PersonMemoryResolvedSourceBundle): string {
  return digestPersonMemorySourceMaterial({
    sources: bundle.sources.map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      resolvedDigest: source.resolvedDigest,
    })),
    assertionBindings: bundle.assertionBindings,
  });
}

function eligibleOwnerMessage(message: StoredMessage | null, auth: PersonMemorySourceAuth): message is StoredMessage {
  return Boolean(
    message &&
      message.userId === auth.ownerUserId &&
      message.catId === null &&
      message.source === undefined &&
      message.deletedAt === undefined &&
      message._tombstone !== true &&
      isDelivered(message) &&
      canViewMessage(message, { type: 'user' }),
  );
}

function explicitlyConfirmsAccuracy(message: StoredMessage): boolean {
  const content = normalizeText(message.content);
  if (/(?:不对|不准确|未确认|not correct|inaccurate)/iu.test(content)) return false;
  return /(?:^|[\s，,。.!！])(?:对|是的|没错)(?:[\s，,。.!！]|$)|(?:转写|记录|内容).{0,24}(?:准确|没错|已确认)|\bconfirm(?:ed)?\b/iu.test(
    content,
  );
}

function sourceRef(message: StoredMessage) {
  return { kind: 'message' as const, threadId: message.threadId, messageId: message.id };
}

function attachmentBlock(
  message: StoredMessage,
  input: Extract<PersonMemorySourceInput, { kind: 'message_attachment' }>,
) {
  const index = input.attachmentLocator.index;
  if (input.attachmentLocator.surface === 'content_block') {
    return message.contentBlocks?.[index] ?? null;
  }
  return message.extra?.rich?.blocks[index] ?? null;
}

function attachmentTranscript(block: unknown): string {
  if (!block || typeof block !== 'object') return '';
  const value = block as Record<string, unknown>;
  if (value.type === 'text' && typeof value.text === 'string') return value.text;
  if (value.type === 'code' && typeof value.code === 'string') return value.code;
  if (value.type === 'image' && typeof value.alt === 'string') return value.alt;
  if (value.kind === 'media_gallery' && Array.isArray(value.items)) {
    return value.items
      .flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const media = item as Record<string, unknown>;
        return [media.alt, media.caption].filter((part): part is string => typeof part === 'string');
      })
      .join('\n');
  }
  if (value.kind === 'audio' && typeof value.text === 'string') return value.text;
  if (value.kind === 'file' && typeof value.fileName === 'string') return value.fileName;
  return '';
}

function invalid(error: string): PersonMemorySourceResolution {
  return { status: 'invalid', error };
}

export class PersonMemorySourceBundleResolver {
  constructor(private readonly deps: ResolverDeps) {}

  async resolve(
    input: PersonMemorySourceBundleInput,
    auth: PersonMemorySourceAuth,
    targets: PersonMemoryAssertionTargetResolution,
  ): Promise<PersonMemorySourceResolution> {
    const sources: ResolvedPersonMemorySource[] = [];
    for (const source of input.sources) {
      const resolved = await this.resolveSource(source, auth);
      if (resolved.status === 'invalid') return resolved;
      sources.push(resolved.source);
    }
    const assertionBindings = input.assertionBindings.map((binding) => {
      if (binding.target.kind === 'claim') {
        const draftId = targets.claimDraftIds[binding.target.index];
        if (!draftId) throw new Error(`claim target index ${binding.target.index} is not present`);
        return { ...binding, target: { kind: 'claim' as const, draftId } };
      }
      if (binding.target.kind === 'relationship') {
        if (!targets.relationshipDraftId) throw new Error('relationship target is not present');
        return { ...binding, target: { ...binding.target, draftId: targets.relationshipDraftId } };
      }
      if (!targets.interactionDraftId) throw new Error('interaction target is not present');
      return { ...binding, target: { ...binding.target, draftId: targets.interactionDraftId } };
    });
    const bundle = personMemoryResolvedSourceBundleSchema.parse({
      sources,
      assertionBindings,
    });
    return {
      status: 'resolved',
      bundle,
      bundleDigest: digestPersonMemoryResolvedBundle(bundle),
    };
  }

  async revalidate(
    input: PersonMemorySourceBundleInput,
    auth: PersonMemorySourceAuth,
    targets: PersonMemoryAssertionTargetResolution,
    expectedBundleDigest: string,
  ): Promise<PersonMemorySourceResolution> {
    const current = await this.resolve(input, auth, targets);
    if (current.status === 'invalid') return current;
    if (current.bundleDigest !== expectedBundleDigest) return invalid('source_drift');
    return current;
  }

  private async resolveSource(
    input: PersonMemorySourceInput,
    auth: PersonMemorySourceAuth,
  ): Promise<{ status: 'resolved'; source: ResolvedPersonMemorySource } | { status: 'invalid'; error: string }> {
    if (input.kind === 'message_text') return this.resolveMessageText(input, auth);
    if (input.kind === 'message_attachment') return this.resolveMessageAttachment(input, auth);
    if (input.kind === 'owner_confirmed_transcript') return this.resolveConfirmedTranscript(input, auth);
    return this.resolvePrivateArtifact(input, auth);
  }

  private async resolveMessageText(
    input: Extract<PersonMemorySourceInput, { kind: 'message_text' }>,
    auth: PersonMemorySourceAuth,
  ) {
    const message = await this.deps.messageStore.getById(input.messageId);
    if (!eligibleOwnerMessage(message, auth)) return { status: 'invalid' as const, error: 'invalid_message_source' };
    if (!normalizeText(message.content).includes(normalizeText(input.excerpt))) {
      return { status: 'invalid' as const, error: 'source_excerpt_mismatch' };
    }
    const resolvedDigest = digestPersonMemorySourceMaterial(message.content);
    if (input.expectedDigest && input.expectedDigest !== resolvedDigest) {
      return { status: 'invalid' as const, error: 'source_digest_mismatch' };
    }
    return {
      status: 'resolved' as const,
      source: {
        sourceId: input.sourceId,
        kind: input.kind,
        sourceRef: sourceRef(message),
        ownerUserId: auth.ownerUserId,
        resolvedDigest,
        excerpt: input.excerpt,
      },
    };
  }

  private async resolveMessageAttachment(
    input: Extract<PersonMemorySourceInput, { kind: 'message_attachment' }>,
    auth: PersonMemorySourceAuth,
  ) {
    const message = await this.deps.messageStore.getById(input.messageId);
    if (!eligibleOwnerMessage(message, auth)) {
      return { status: 'invalid' as const, error: 'invalid_attachment_source' };
    }
    const block = attachmentBlock(message, input);
    const transcript = attachmentTranscript(block);
    if (!block || !normalizeText(transcript).includes(normalizeText(input.boundedTranscript))) {
      return { status: 'invalid' as const, error: 'attachment_transcript_mismatch' };
    }
    const resolvedDigest = digestPersonMemorySourceMaterial(block);
    if (input.expectedDigest !== resolvedDigest) {
      return { status: 'invalid' as const, error: 'source_digest_mismatch' };
    }
    return {
      status: 'resolved' as const,
      source: {
        sourceId: input.sourceId,
        kind: input.kind,
        sourceRef: sourceRef(message),
        ownerUserId: auth.ownerUserId,
        attachmentLocator: input.attachmentLocator,
        resolvedDigest,
        boundedTranscript: input.boundedTranscript,
      },
    };
  }

  private async resolveConfirmedTranscript(
    input: Extract<PersonMemorySourceInput, { kind: 'owner_confirmed_transcript' }>,
    auth: PersonMemorySourceAuth,
  ) {
    if (digestPersonMemorySourceMaterial(input.transcript) !== input.transcriptDigest) {
      return { status: 'invalid' as const, error: 'source_digest_mismatch' };
    }
    const confirmation = await this.deps.messageStore.getById(input.confirmationMessageId);
    if (!eligibleOwnerMessage(confirmation, auth) || !explicitlyConfirmsAccuracy(confirmation)) {
      return { status: 'invalid' as const, error: 'invalid_transcript_confirmation' };
    }
    const resolvedDigest = digestPersonMemorySourceMaterial({
      transcript: normalizeText(input.transcript),
      confirmation: normalizeText(confirmation.content),
    });
    return {
      status: 'resolved' as const,
      source: {
        sourceId: input.sourceId,
        kind: input.kind,
        confirmationSourceRef: sourceRef(confirmation),
        ownerUserId: auth.ownerUserId,
        resolvedDigest,
        transcript: input.transcript,
        confirmationScope: input.confirmationScope,
      },
    };
  }

  private async resolvePrivateArtifact(
    input: Extract<PersonMemorySourceInput, { kind: 'owner_private_artifact' }>,
    auth: PersonMemorySourceAuth,
  ) {
    const confirmation = await this.deps.messageStore.getById(input.confirmationMessageId);
    if (!eligibleOwnerMessage(confirmation, auth) || !explicitlyConfirmsAccuracy(confirmation)) {
      return { status: 'invalid' as const, error: 'invalid_artifact_confirmation' };
    }
    const artifact = await this.deps.ownerPrivateArtifactResolver?.resolve(auth.ownerUserId, input.artifactLocator);
    if (
      !artifact ||
      artifact.digest !== input.expectedDigest ||
      !normalizeText(artifact.boundedText).includes(normalizeText(input.boundedExcerpt))
    ) {
      return { status: 'invalid' as const, error: 'invalid_private_artifact' };
    }
    const resolvedDigest = digestPersonMemorySourceMaterial({
      artifactDigest: artifact.digest,
      confirmation: normalizeText(confirmation.content),
    });
    return {
      status: 'resolved' as const,
      source: {
        sourceId: input.sourceId,
        kind: input.kind,
        artifactLocator: input.artifactLocator,
        confirmationSourceRef: sourceRef(confirmation),
        ownerUserId: auth.ownerUserId,
        resolvedDigest,
        boundedExcerpt: input.boundedExcerpt,
      },
    };
  }
}
