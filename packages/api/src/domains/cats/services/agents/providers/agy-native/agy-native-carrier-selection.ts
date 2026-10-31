import type { AgyProfileConfig, CatId } from '@cat-cafe/shared';
import type { AgentService } from '../../../types.js';
import { AgentServiceUnavailableError } from '../../registry/AgentServiceUnavailableError.js';
import { AgyNativeAgentService } from './AgyNativeAgentService.js';

/** F325: the only AGY execution path. Historical members/config stay readable. */
export function createGoogleAgentService(catId: CatId, profile?: AgyProfileConfig): AgentService {
  if (profile?.carrier !== 'native' || !profile.enabled || !profile.model?.trim()) {
    throw new AgentServiceUnavailableError(catId, {
      code: 'AGY_NATIVE_SETUP_REQUIRED',
      message:
        '旧 Gemini CLI / AGY 执行入口已退役。请在成员设置保存已登录的 AGY Native Profile、模型和权限；历史会话仍可查看。',
    });
  }
  return new AgyNativeAgentService({ catId, profile });
}
