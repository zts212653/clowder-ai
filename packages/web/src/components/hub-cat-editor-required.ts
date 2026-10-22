import type { ProfileItem } from './hub-accounts.types';
import {
  type HubCatEditorFormState,
  splitMentionPatterns,
  withDefaultModelMentionPattern,
} from './hub-cat-editor.model';

export function requiredHubCatFields(
  form: HubCatEditorFormState,
  selectedProfile: ProfileItem | null,
  detailed = false,
) {
  const errors: Record<string, boolean> = {};
  const errorMessages: string[] = [];
  if (
    detailed &&
    form.configurationSource !== 'native_tool' &&
    form.clientId !== 'antigravity' &&
    (!form.accountRef.trim() || !selectedProfile)
  ) {
    errors.account = true;
    errors.Account = true;
    errorMessages.push('账号');
  }
  if (!form.name.trim()) {
    errors.identity = true;
    if (detailed) errors.Name = true;
    errorMessages.push('名称');
  }
  if (!form.roleDescription.trim()) {
    errors.identity = true;
    errorMessages.push('角色描述');
    if (detailed) errors.Description = true;
  }
  if (!form.defaultModel.trim() && selectedProfile?.authType === 'api_key') {
    errors.account = true;
    errorMessages.push('Model');
    if (detailed) errors.Model = true;
  } else if (
    form.clientId === 'opencode' &&
    selectedProfile?.authType === 'api_key' &&
    !form.provider.trim() &&
    (() => {
      const m = form.defaultModel.trim();
      const si = m.indexOf('/');
      const looksLike = si > 0 && si < m.length - 1;
      if (!looksLike) return true; // bare model, need provider
      // Known provider prefix → canonical (synced with BUILTIN_OPENCODE_PROVIDERS)
      const known = new Set(['anthropic', 'openai', 'openrouter', 'google']);
      if (known.has(m.slice(0, si))) return false;
      // Non-builtin: "x/y" in account list + bare "y" absent → namespace
      const acm = selectedProfile?.models ?? [];
      const bare = m.slice(si + 1);
      return acm.includes(m) && !acm.includes(bare);
    })()
  ) {
    errors.account = true;
    errorMessages.push('请使用 provider/model 格式（如 minimax/MiniMax-M2.7），或填写 Provider 名称');
    if (detailed) errors['OC Provider Name'] = true;
  }
  const effectiveCreateForm = selectedProfile?.authType === 'api_key' ? withDefaultModelMentionPattern(form) : form;
  if (splitMentionPatterns(effectiveCreateForm.mentionPatterns).length === 0) {
    errors.routing = true;
    if (detailed) errors.Aliases = true;
    errorMessages.push('别名');
  }

  return { errors, errorMessages };
}
