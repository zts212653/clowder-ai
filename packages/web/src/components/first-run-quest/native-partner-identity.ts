import { type NativeToolIdentity, nativeToolIdentityFor } from '@cat-cafe/shared';
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

function identityForm(identity: NativeToolIdentity) {
  return {
    ...initialState(),
    name: identity.name,
    displayName: identity.name,
    nickname: identity.nickname,
    avatar: identity.avatar,
    colorPrimary: identity.color.primary,
    colorSecondary: identity.color.secondary,
    roleDescription: identity.roleDescription,
    personality: identity.personality,
    teamStrengths: identity.teamStrengths,
    mentionPatterns: `@${identity.nickname || identity.name}`,
  };
}

/** Tool identities are independent of the model/provider chosen in that tool. */
export function nativePartnerIdentity(runtime: RuntimeChoice, templates: TemplateCard[], cats: CatData[]) {
  const identity = nativeToolIdentityFor({
    clientId: runtime.clientId,
    catId: runtime.id,
    acp: runtime.acp,
  });
  const templateId = runtime.roleTemplateId ?? identity?.templateId ?? templatesByClient[runtime.clientId];
  const template = templates.find((item) => item.id === templateId);
  const form = template
    ? templateForm(template, cats, initialState())
    : identity
      ? identityForm(identity)
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
  if (identity) {
    // The template owns the visual identity when it is present (that lets a
    // future template rename land here without a code change). The shared
    // identity owns the tool's role semantics because tools like Pi reuse a
    // template whose prose describes a different product.
    if (!template) {
      form.name = form.displayName = identity.name;
      form.nickname = identity.nickname;
      form.avatar = identity.avatar;
      form.colorPrimary = identity.color.primary;
      form.colorSecondary = identity.color.secondary;
    }
    form.roleDescription = identity.roleDescription;
    form.personality = identity.personality;
    form.teamStrengths = identity.teamStrengths;
  }
  if (runtime.clientId === 'opencode') {
    form.roleDescription = '负责编码实现和工具协作，模型跟随 OpenCode 配置';
    form.personality = '沉稳务实，先确认目标，再逐步实现并回报结果';
    form.teamStrengths = '编码实现、工具协作、结果验证';
  }
  // A detected partner must never render the anonymous placeholder. The shared
  // identity already supplies a family avatar; keep this guard for a template
  // that ships with an empty asset.
  if (!form.avatar?.trim()) {
    form.avatar = identity?.avatar ?? '/avatars/default.png';
  }
  return form;
}
