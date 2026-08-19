import type {
  DeferredPersonMemoryReceipt,
  DeferredPersonMemoryResolvedSource,
  PersonIdentityDraft,
  PersonMemoryResolvedSourceBundle,
} from '@cat-cafe/shared';
import { digestPersonMemorySourceMaterial } from './PersonMemorySourceBundleResolver.js';

export type PersonMemoryDeltaBinding = NonNullable<DeferredPersonMemoryReceipt['registryBinding']>;

function sourceCoordinateKey(coordinate: DeferredPersonMemoryResolvedSource): string {
  const base = [
    coordinate.kind,
    coordinate.sourceRef.threadId,
    coordinate.sourceRef.messageId,
    coordinate.resolvedDigest,
  ];
  if (coordinate.kind === 'message_attachment') {
    base.push(coordinate.attachmentLocator.surface, String(coordinate.attachmentLocator.index));
  }
  return JSON.stringify(base);
}

export function canonicalizeDeferredPersonMemoryCoordinates(
  coordinates: readonly DeferredPersonMemoryResolvedSource[],
): { status: 'canonical'; coordinates: DeferredPersonMemoryResolvedSource[] } | { status: 'duplicate' } {
  const sorted = [...coordinates].sort((left, right) =>
    sourceCoordinateKey(left).localeCompare(sourceCoordinateKey(right)),
  );
  const keys = sorted.map(sourceCoordinateKey);
  return new Set(keys).size === keys.length ? { status: 'canonical', coordinates: sorted } : { status: 'duplicate' };
}

export function personMemoryDeltaFingerprint(
  binding: PersonMemoryDeltaBinding,
  coordinates: readonly DeferredPersonMemoryResolvedSource[],
): string {
  return digestPersonMemorySourceMaterial({
    version: 1,
    binding,
    sourceSet: coordinates.map(sourceCoordinateKey).sort(),
  });
}

export type ProposalPersonMemoryDeltaCoordinates =
  | { status: 'canonical'; coordinates: DeferredPersonMemoryResolvedSource[] }
  | { status: 'duplicate' | 'unsupported' };

export function proposalPersonMemoryDeltaCoordinates(
  bundle: PersonMemoryResolvedSourceBundle,
): ProposalPersonMemoryDeltaCoordinates {
  const coordinates: DeferredPersonMemoryResolvedSource[] = [];
  let fingerprintEligible = true;
  for (const source of bundle.sources) {
    if (source.kind === 'message_text') {
      coordinates.push({
        kind: 'message',
        sourceRef: source.sourceRef,
        resolvedDigest: source.resolvedDigest,
      });
      continue;
    }
    if (source.kind === 'message_attachment') {
      coordinates.push({
        kind: 'message_attachment',
        sourceRef: source.sourceRef,
        attachmentLocator: source.attachmentLocator,
        resolvedDigest: source.resolvedDigest,
      });
      continue;
    }
    fingerprintEligible = false;
  }
  const canonical = canonicalizeDeferredPersonMemoryCoordinates(coordinates);
  if (canonical.status === 'duplicate') return { status: 'duplicate' };
  return fingerprintEligible ? { status: 'canonical', coordinates: canonical.coordinates } : { status: 'unsupported' };
}

export function proposalPersonMemoryDeltaFingerprint(input: {
  targetPersonId?: string;
  person: PersonIdentityDraft;
  sourceBundle: PersonMemoryResolvedSourceBundle;
  replacesProposalId?: string;
}): string | null {
  if (input.replacesProposalId) return null;
  const binding: PersonMemoryDeltaBinding | null = input.targetPersonId
    ? { kind: 'registered_person', ref: input.targetPersonId }
    : input.person.workspaceEntityLink?.state === 'linked'
      ? { kind: 'registered_entity', ref: input.person.workspaceEntityLink.entityRef }
      : null;
  const coordinates = proposalPersonMemoryDeltaCoordinates(input.sourceBundle);
  return binding && coordinates.status === 'canonical'
    ? personMemoryDeltaFingerprint(binding, coordinates.coordinates)
    : null;
}

export function deferredReceiptLineageMarker(receiptId: string): string {
  return `receipt:${receiptId}`;
}

export function personMemoryProposalLineageMarker(proposalId: string): string {
  return `proposal:${proposalId}`;
}

export function parsePersonMemoryDeltaLineageMarker(
  value: string,
): { kind: 'receipt'; id: string } | { kind: 'proposal'; id: string } | null {
  if (value.startsWith('receipt:')) return { kind: 'receipt', id: value.slice('receipt:'.length) };
  if (value.startsWith('proposal:')) return { kind: 'proposal', id: value.slice('proposal:'.length) };
  return null;
}
