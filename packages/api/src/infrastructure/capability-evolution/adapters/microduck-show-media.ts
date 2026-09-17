import { createHash } from 'node:crypto';
import type {
  MicroduckApprovalResolver,
  MicroduckBlocked,
  MicroduckObservation,
  MicroduckOwnerPort,
  MicroduckProgramScope,
  MicroduckProposalResolver,
  MicroduckShowMediaAsset,
  MicroduckShowMediaDescriptor,
} from './microduck-owner-contract.js';
import { microduckShowMediaSchema, microduckShowStateSchema } from './microduck-owner-schemas.js';
import { blocked, microduckScope, ownerRef, parsedOwnerResponse, sameRef } from './microduck-owner-validation.js';
import {
  canonicalMicroduckShowTruthMatches,
  validMicroduckObservationMedia,
  validMicroduckSceneMedia,
} from './microduck-show-manifest.js';
import { MICRODUCK_SHOW_MEDIA_MAX_BYTES } from './microduck-show-media-contract.js';

interface MicroduckShowMediaResolverOptions {
  owner: MicroduckOwnerPort;
  observe: (input: MicroduckProgramScope) => Promise<MicroduckObservation | MicroduckBlocked>;
  approvalResolver: MicroduckApprovalResolver;
  proposalResolver: MicroduckProposalResolver;
}

function contentTypeMatches(asset: MicroduckShowMediaAsset): boolean {
  return asset.kind === 'image' ? asset.contentType.startsWith('image/') : asset.contentType.startsWith('video/');
}

function captureHashMatches(asset: MicroduckShowMediaAsset): boolean {
  const expected = asset.captureRef.ownerStateRef.match(/^capture:sha256:([a-f0-9]{64})$/u)?.[1];
  return expected !== undefined && createHash('sha256').update(asset.bytes).digest('hex') === expected;
}

/**
 * Resolve bytes at request time from the owner boundary. F311 stores neither a path nor a payload,
 * and only a capture declared by the current owner show state can be read.
 */
export async function resolveMicroduckShowMedia(
  options: MicroduckShowMediaResolverOptions,
  input: MicroduckProgramScope & { programSequence: number; sceneIndex: number },
): Promise<MicroduckShowMediaAsset | MicroduckBlocked> {
  const { owner } = options;
  if (
    !microduckScope(input) ||
    !Number.isInteger(input.programSequence) ||
    input.programSequence < 0 ||
    !Number.isInteger(input.sceneIndex) ||
    input.sceneIndex < 0 ||
    input.sceneIndex > 7 ||
    typeof owner.resolveShowMedia !== 'function'
  ) {
    return blocked('show_truth_incomplete');
  }
  const state = parsedOwnerResponse(
    microduckShowStateSchema,
    await owner.resolveShowState(input),
    'show_truth_incomplete',
  );
  let descriptor: MicroduckShowMediaDescriptor | undefined;
  if (state.status === 'blocked') {
    const observation = await options.observe(input);
    if (observation.status === 'blocked') return blocked('show_truth_incomplete');
    descriptor = validMicroduckObservationMedia(observation).find((media) => media.sceneIndex === input.sceneIndex);
  } else {
    if (!(await canonicalMicroduckShowTruthMatches(state, input, options))) return blocked('show_truth_incomplete');
    descriptor = validMicroduckSceneMedia(state).find((media) => media.sceneIndex === input.sceneIndex);
  }
  if (!descriptor) return blocked('show_truth_incomplete');
  const asset = parsedOwnerResponse(
    microduckShowMediaSchema,
    await owner.resolveShowMedia({ ...input, captureRef: descriptor.captureRef }),
    'show_truth_incomplete',
  );
  if (asset.status === 'blocked') return blocked('show_truth_incomplete');
  if (
    !sameRef(asset.captureRef, descriptor.captureRef) ||
    asset.kind !== descriptor.kind ||
    !contentTypeMatches(asset) ||
    !captureHashMatches(asset) ||
    asset.bytes.byteLength === 0 ||
    asset.bytes.byteLength > MICRODUCK_SHOW_MEDIA_MAX_BYTES
  ) {
    return blocked('show_truth_incomplete');
  }
  return { ...asset, captureRef: ownerRef(asset.captureRef) };
}
