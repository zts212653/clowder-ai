import type { CatData } from '@/hooks/useCatData';
import { initialState } from '../hub-cat-editor.model';
import { templateForm } from '../settings/members/member-editor-state';
import type { RuntimeChoice } from '../settings/members/member-runtime-draft';
import type { TemplateCard } from './TemplateStep';

const templatesByClient: Record<string, string> = {
  anthropic: 'ragdoll',
  openai: 'maine-coon',
  kimi: 'turkish-van',
  opencode: 'golden-chinchilla',
};

/** Tool identities are independent of the model/provider chosen in that tool. */
export function nativePartnerIdentity(runtime: RuntimeChoice, templates: TemplateCard[], cats: CatData[]) {
  const templateId =
    runtime.id === 'pi'
      ? 'golden-chinchilla'
      : runtime.id === 'dsh'
        ? 'turkish-van'
        : templatesByClient[runtime.clientId];
  const template = templates.find((item) => item.id === templateId);
  const form = template
    ? templateForm(template, cats, initialState())
    : {
        ...initialState(),
        name: `${runtime.label} 伙伴`,
        displayName: `${runtime.label} 伙伴`,
        nickname: runtime.label,
        avatar: '/avatars/default.png',
        roleDescription: '一起分析问题、完成任务',
        personality: '认真务实，先确认目标，完成后说明结果',
        teamStrengths: '任务拆解、实现与验证',
      };
  if (runtime.clientId === 'opencode') {
    form.roleDescription = '负责编码实现和工具协作，模型跟随 OpenCode 配置';
    form.personality = '沉稳务实，先确认目标，再逐步实现并回报结果';
    form.teamStrengths = '编码实现、工具协作、结果验证';
  }
  // Kimi discovery may come back without a usable template asset (for
  // example, an older packaged template catalog). Keep the detected partner
  // visually identifiable instead of falling back to the generic placeholder.
  if (runtime.clientId === 'kimi' && (!template || !form.avatar?.trim())) {
    form.avatar = '/avatars/family/kimi.png';
  }
  if (runtime.id === 'pi' || runtime.label === 'Pi') {
    form.name = form.displayName = 'Pi 伙伴';
    form.nickname = '派派';
    form.avatar = template?.avatar || '/avatars/family/opencode.png';
    form.roleDescription = '轻量编码伙伴，负责拆解小任务、实现和验证';
    form.personality = '敏捷克制，先给最小可用实现，再补验证细节';
    form.teamStrengths = '任务拆解、编码实现、测试验证';
  }
  if (runtime.id === 'dsh') {
    form.name = form.displayName = 'DSH 伙伴';
    form.nickname = '深深';
    form.avatar = template?.avatar || '/avatars/family/kimi.png';
    form.roleDescription = '共创与推理伙伴，负责分析问题、编码实现和交叉验证';
    form.personality = '细心务实，先理清问题，再用可验证的结果交付';
    form.teamStrengths = '问题分析、编码、交叉验证';
  }
  return form;
}
