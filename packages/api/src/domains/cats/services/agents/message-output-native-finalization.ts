import type { AgentMessage } from '../types.js';

// Enumerable symbols survive the provider/sanitizer's object spreads, but never
// JSON/wire serialization. Only the producer that actually removed the suffix
// may assert this fact; a signature-shaped piece of user text is not evidence.
const removedOwnSignature = Symbol('removed_own_native_signature');
type FinalizedMessage = AgentMessage & { [removedOwnSignature]?: string };

export function withNativeSignatureRemoval(message: AgentMessage, suffix: string): AgentMessage {
  return Object.assign({}, message, { [removedOwnSignature]: suffix });
}

export function nativeSignatureRemoval(message: AgentMessage): string | undefined {
  return (message as FinalizedMessage)[removedOwnSignature];
}
