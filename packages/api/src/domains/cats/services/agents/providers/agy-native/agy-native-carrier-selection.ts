import type { AgyProfileConfig, CatId } from '@cat-cafe/shared';
import type { AgentService } from '../../../types.js';
import { GeminiAgentService } from '../GeminiAgentService.js';
import { AgyNativeAgentService } from './AgyNativeAgentService.js';

/** One selected carrier per AGY profile; no runtime fallback on native failure. */
export function createGoogleAgentService(catId: CatId, profile?: AgyProfileConfig): AgentService {
  return profile?.carrier === 'native'
    ? new AgyNativeAgentService({ catId, profile })
    : new GeminiAgentService({ catId, agyProfile: profile });
}
