import type {
  MicroduckBlocked,
  MicroduckObservation,
  MicroduckOwnerPort,
  MicroduckProgramScope,
} from './microduck-owner-contract.js';
import { microduckObservationSchema } from './microduck-owner-schemas.js';
import {
  blocked,
  exactRef,
  isMicroduckDeployableRef,
  isMicroduckHashRef,
  isMicroduckTargetRef,
  microduckScope,
  ownerBlock,
  ownerRef,
  parsedOwnerResponse,
  sameAddress,
} from './microduck-owner-validation.js';
import { validMicroduckObservationMedia } from './microduck-show-manifest.js';

function validObservationEvidence(result: MicroduckObservation): boolean {
  const sceneMedia = validMicroduckObservationMedia(result);
  return (
    isMicroduckTargetRef(result.targetVersionRef) &&
    isMicroduckDeployableRef(result.baselineVersionRef) &&
    result.observationRefs.every((ref) => isMicroduckHashRef(ref, 'capture')) &&
    (result.sceneMedia?.length ?? 0) === sceneMedia.length
  );
}

/** Normalize one owner observation without granting any mutation or credential authority. */
export function createMicroduckObservationResolver(owner: Pick<MicroduckOwnerPort, 'observe'>) {
  return async (input: MicroduckProgramScope): Promise<MicroduckObservation | MicroduckBlocked> => {
    if (!microduckScope(input)) return blocked('owner_route_unavailable');
    const result = parsedOwnerResponse(
      microduckObservationSchema,
      await owner.observe(input),
      'owner_route_unavailable',
    );
    if (result.status === 'blocked') return ownerBlock(result, 'owner_route_unavailable');
    if (!sameAddress(result.targetVersionRef, input.objectRef) || !isMicroduckTargetRef(result.targetVersionRef)) {
      return blocked('target_drift');
    }
    if (!validObservationEvidence(result)) return blocked('owner_route_unavailable');
    const sceneMedia = validMicroduckObservationMedia(result);
    return {
      status: 'observed',
      targetVersionRef: exactRef(result.targetVersionRef),
      baselineVersionRef: exactRef(result.baselineVersionRef),
      observationRefs: result.observationRefs.map(ownerRef),
      ...(result.baselineArtifactSha256 === undefined ? {} : { baselineArtifactSha256: result.baselineArtifactSha256 }),
      ...(result.sceneMedia ? { sceneMedia } : {}),
    };
  };
}
