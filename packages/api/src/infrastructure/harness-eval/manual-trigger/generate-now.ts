import type { HandlerError, ManualTriggerDeps } from './types.js';

/**
 * Compatibility shape for the retired manual endpoint. Its former implementation
 * wrote verdict evidence directly into the product checkout, which violated the
 * runtime-data boundary and caused execution data to enter Git. Callers must use
 * `cat_cafe_publish_verdict`, backed by ArtifactPublisher, instead.
 */
export interface GenerateNowInput {
  domainId: string;
  userId: string;
  verdictId?: string;
  snapshotName?: string;
  attributionName?: string;
}

/** The retired endpoint has no success response. Kept for import compatibility. */
export type GenerateNowSuccess = never;

/**
 * F192/F257 sunset: fail closed before reading evidence or touching the checkout.
 * The stable 410 response keeps old clients diagnosable without preserving the
 * unsafe product-worktree writer.
 */
export function handleGenerateNow(
  _deps: Pick<ManualTriggerDeps, 'harnessFeedbackRoot'>,
  _input: GenerateNowInput,
): Promise<HandlerError> {
  return Promise.resolve({
    status: 410,
    error: 'generate_now_sunset',
    detail:
      'The legacy generate-now endpoint was retired because it wrote runtime verdict evidence into the product Git checkout. Use cat_cafe_publish_verdict; it publishes to the durable artifact store and does not create Git commits, branches, or PRs.',
  });
}
