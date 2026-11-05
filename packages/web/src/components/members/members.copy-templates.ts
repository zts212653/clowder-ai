export const templates = {
  zh: {
    deletePrompt: (name: string) => `确认删除成员「${name}」吗？此操作不可撤销。`,
    aliasTaken: (name: string) => `@ 名字“${name}”已被其他成员使用`,
    protectedIdentityDrift: (fields: string[]) =>
      `以下配置与内置云端身份不一致：${fields.join('、')}。普通保存不会恢复这些配置；请使用“恢复云端身份配置”恢复内置设置。`,
    accountLabel: (name: string, kind: 'builtin' | 'oauth' | 'api_key') =>
      `${name} · ${kind === 'builtin' ? '内置' : kind === 'oauth' ? '账号登录（OAuth）' : 'API 密钥账号'}`,
    preference: (prefer: string, over: string, intent: string) =>
      `${intent === 'review' ? '审查：' : intent === 'architecture' ? '架构：' : ''}${prefer} 优先于 ${over}`,
    eligibility: (names: string) => `适用条件：${names} 均有可用成员`,
    poolName: (id: string) => `额度池 ${id}`,
    changes: (count: number) => `${count} 处修改未保存`,
    requiredFields: (fields: string[]) => `还差 ${fields.length} 项才能添加：${fields.join('、')}。`,
    filterCount: (label: string, count: number) => `${label} ${count}`,
    aliasCount: (handle: string, count: number) => (count > 1 ? `${handle} +${count - 1}` : handle),
    until: (time: number) => `至 ${new Date(time).toLocaleString('zh-CN')}`,
    sortLabel: (name: string) => `排序${name}`,
    upLabel: (name: string) => `上移${name}`,
    downLabel: (name: string) => `下移${name}`,
    enableLabel: (name: string) => `启用${name}`,
    avatarLabel: (name: string) => `选择${name}头像`,
  },
  en: {
    deletePrompt: (name: string) => `Delete member “${name}”? This cannot be undone.`,
    aliasTaken: (name: string) => `Mention name “${name}” is already used by another member`,
    protectedIdentityDrift: (fields: string[]) =>
      `These settings don’t match the built-in cloud identity: ${fields.join(', ')}. Saving won’t restore them. Choose “Restore cloud identity settings” to restore the built-in settings.`,
    accountLabel: (name: string, kind: 'builtin' | 'oauth' | 'api_key') =>
      `${name} · ${kind === 'builtin' ? 'Built-in' : kind === 'oauth' ? 'Account sign-in (OAuth)' : 'API key account'}`,
    preference: (prefer: string, over: string, intent: string) =>
      `${intent === 'review' ? 'Review: ' : intent === 'architecture' ? 'Architecture: ' : ''}Prefer ${prefer} over ${over}.`,
    eligibility: (names: string) => `Applies when an available member matches each of: ${names}.`,
    poolName: (id: string) => `Quota pool ${id}`,
    changes: (count: number) => `${count} unsaved ${count === 1 ? 'change' : 'changes'}`,
    requiredFields: (fields: string[]) => {
      const n = fields.length;
      const list = fields.join(', ');
      return `${n} more ${n === 1 ? 'field' : 'fields'} needed to add: ${list}.`;
    },
    filterCount: (label: string, count: number) => `${label} ${count}`,
    aliasCount: (handle: string, count: number) => (count > 1 ? `${handle} +${count - 1}` : handle),
    until: (time: number) => `Until ${new Date(time).toLocaleString('en-US')}`,
    sortLabel: (name: string) => `Reorder ${name}`,
    upLabel: (name: string) => `Move ${name} up`,
    downLabel: (name: string) => `Move ${name} down`,
    enableLabel: (name: string) => `Enable ${name}`,
    avatarLabel: (name: string) => `Select ${name} avatar`,
  },
};
