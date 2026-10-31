import { describe, expect, it } from 'vitest';
import { initialState } from '../../hub-cat-editor.model';
import type { RuntimeChoice } from '../../settings/members/member-runtime-draft';
import { withLegacyNativeIdentityRepair } from '../native-identity-repair';

const kimiRuntime = {
  id: 'kimi',
  label: 'Kimi',
  clientId: 'kimi',
  installed: true,
  models: [],
} as RuntimeChoice;

const dshRuntime = {
  id: 'dsh',
  label: 'DSH',
  clientId: 'acp',
  installed: true,
  models: [],
  acp: { command: 'dsh', startupArgs: [] },
} as RuntimeChoice;

const piRuntime = {
  id: 'pi',
  label: 'Pi',
  clientId: 'acp',
  installed: true,
  models: [],
  acp: { command: 'node', startupArgs: ['pi-acp-bridge.js'] },
} as RuntimeChoice;

const form = (values: Partial<ReturnType<typeof initialState>>) => ({ ...initialState(), ...values });

describe('legacy native identity repair', () => {
  it('renames a legacy DSH member while keeping its role text', () => {
    const current = form({
      name: 'DSH 伙伴',
      displayName: 'DSH 伙伴',
      nickname: '深深',
      avatar: '/avatars/family/kimi.png',
      roleDescription: '共创与推理伙伴，负责分析问题、编码实现和交叉验证',
      personality: '细心务实，先理清问题，再用可验证的结果交付',
      teamStrengths: '问题分析、编码、交叉验证',
    });
    const recommended = form({
      name: '小鲸鱼',
      displayName: '小鲸鱼',
      nickname: '鲸鲸',
      avatar: '/avatars/family/dsh.png',
      roleDescription: current.roleDescription,
      personality: current.personality,
      teamStrengths: current.teamStrengths,
    });
    expect(withLegacyNativeIdentityRepair(current, recommended, dshRuntime)).toMatchObject({
      name: '小鲸鱼',
      displayName: '小鲸鱼',
      nickname: '鲸鲸',
      avatar: '/avatars/family/dsh.png',
      roleDescription: current.roleDescription,
    });
  });

  it('does not overwrite a user who already customized the member', () => {
    const customized = form({
      name: '我的鲸鱼',
      displayName: '我的鲸鱼',
      nickname: '小鱼',
      avatar: '/custom.png',
      roleDescription: '我设定的分工',
      personality: '我设定的性格',
      teamStrengths: '我设定的能力',
    });
    const recommended = form({
      name: '小鲸鱼',
      displayName: '小鲸鱼',
      nickname: '鲸鲸',
      avatar: '/avatars/family/dsh.png',
    });
    expect(withLegacyNativeIdentityRepair(customized, recommended, dshRuntime)).toBe(customized);
  });

  it('gives Kimi a family avatar and the real cat role when the old default is present', () => {
    const current = form({
      name: 'Kimi 伙伴',
      displayName: 'Kimi 伙伴',
      nickname: 'Kimi',
      avatar: '',
      roleDescription: '一起分析问题、完成任务',
      personality: '认真务实，先确认目标，完成后说明结果',
      teamStrengths: '任务拆解、实现与验证',
    });
    const recommended = form({
      name: '梵花猫',
      displayName: '梵花猫',
      nickname: '墨墨',
      avatar: '/avatars/family/kimi.png',
      roleDescription: '共创伙伴，擅长编码、文档与任务验收',
      personality: '细心务实，保留自己的判断，愿意把事情接住做完',
      teamStrengths: '编码、文档、验收',
    });
    expect(withLegacyNativeIdentityRepair(current, recommended, kimiRuntime)).toMatchObject({
      name: '梵花猫',
      displayName: '梵花猫',
      nickname: '墨墨',
      avatar: '/avatars/family/kimi.png',
      roleDescription: '共创伙伴，擅长编码、文档与任务验收',
    });
  });

  it('renames Pi but preserves a role the user edited', () => {
    const current = form({
      name: 'Pi 伙伴',
      displayName: 'Pi 伙伴',
      nickname: '派派',
      avatar: '/avatars/family/opencode.png',
      roleDescription: '我自己的轻量助手',
      personality: '敏捷克制，先给最小可用实现，再补验证细节',
      teamStrengths: '任务拆解、编码实现、测试验证',
    });
    const recommended = form({
      name: '金渐层',
      displayName: '金渐层',
      nickname: '金哥',
      avatar: '/avatars/family/opencode.png',
      roleDescription: '轻量编码伙伴，负责拆解小任务、实现和验证',
      personality: '敏捷克制，先给最小可用实现，再补验证细节',
      teamStrengths: '任务拆解、编码实现、测试验证',
    });
    expect(withLegacyNativeIdentityRepair(current, recommended, piRuntime)).toMatchObject({
      name: '金渐层',
      displayName: '金渐层',
      nickname: '金哥',
      roleDescription: '我自己的轻量助手',
    });
  });
});
