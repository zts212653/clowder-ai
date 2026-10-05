import { issueRootConnectionProof } from '../../src/domains/workspace/roots/workspace-root-proof.js';

/** Unit fixtures model a previously verified explicit directory selection. Journey tests consume the real resolver. */
export function withRootProof<T extends { root: string; expectedUserId: string; expectedEpoch: number }>(payload: T) {
  return {
    ...payload,
    connectionProof: issueRootConnectionProof({
      userId: payload.expectedUserId,
      root: payload.root,
      expectedEpoch: payload.expectedEpoch,
      source: { kind: 'directory-selection' },
    }),
  };
}
