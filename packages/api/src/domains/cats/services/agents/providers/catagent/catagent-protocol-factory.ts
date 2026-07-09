/**
 * CatAgent Protocol Factory — F159 Phase G Slice G1
 *
 * Single entry point for service to obtain a configured
 * {@link CatAgentProtocolAdapter}. G1 currently only knows about
 * `AnthropicMessagesAdapter`; G2 (KD-16) will extend this with
 * `OpenAIChatAdapter`, gated on `CatConfig.catAgentProtocol` (selection
 * strategy A from the spec's Slice G2 options).
 *
 * Service code never instantiates adapters directly — it calls this factory.
 * AC-G12 grep verifier asserts service contains no `new
 * AnthropicMessagesAdapter` (or any other adapter constructor).
 */

import type { CatConfig } from '@cat-cafe/shared';
import { AnthropicMessagesAdapter } from './anthropic-messages-adapter.js';
import type { CatAgentProtocolAdapter } from './catagent-protocol-adapter.js';

/**
 * Select and instantiate the protocol adapter for a CatAgent member.
 *
 * G1: always returns `AnthropicMessagesAdapter`. The `catConfig` parameter
 * is reserved for G2 — `catConfig.catAgentProtocol === 'openai-chat'` will
 * dispatch to `OpenAIChatAdapter` (and pick `clientFamily='openai'` for
 * account resolution downstream).
 */
export function createCatAgentProtocolAdapter(_catConfig: CatConfig | null): CatAgentProtocolAdapter {
  return new AnthropicMessagesAdapter();
}
