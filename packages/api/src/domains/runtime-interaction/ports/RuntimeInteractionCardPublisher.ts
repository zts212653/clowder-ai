import type { RuntimeInteractionCardRef, RuntimeInteractionRequest } from '@cat-cafe/shared';

export interface RuntimeInteractionCardPublisher {
  prepare(request: RuntimeInteractionRequest): Promise<RuntimeInteractionCardRef>;
  publish(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<void>;
  isLive(request: RuntimeInteractionRequest, cardRef: RuntimeInteractionCardRef): Promise<boolean>;
}
