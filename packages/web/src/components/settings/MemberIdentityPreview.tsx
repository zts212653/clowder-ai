import type { resolveMemberIdentity } from '@cat-cafe/shared';

const labels: Record<string, string> = {
  name: '姓名',
  displayName: '显示名称',
  nickname: '昵称',
  roleDescription: '角色',
  personality: '性格',
  teamStrengths: '团队定位',
  caution: '协作提醒',
  restrictions: '角色限制',
  variant: '成员配置',
  breed: '品种继承',
  default_variant: '默认成员继承',
  template: '模板兼容',
  l0SelfDescription: '档案自述',
  l0RosterSummary: '档案团队定位',
  l0RoutingNote: '档案路由提醒',
};

export function MemberIdentityPreview({ value }: { value: ReturnType<typeof resolveMemberIdentity> }) {
  return (
    <details className="mb-3 text-xs text-cafe-muted">
      <summary className="cursor-pointer">身份来源与生效时机</summary>
      <p className="my-2">后续调用使用当前配置；已开始的回合保留其准入时的身份。</p>
      <dl className="space-y-1">
        <div>
          <dt className="inline">角色：</dt>
          <dd className="inline">{value.roleDescription || '（空）'}</dd>
        </div>
        <div>
          <dt className="inline">性格：</dt>
          <dd className="inline">{value.personality || '（空）'}</dd>
        </div>
        <div>
          <dt className="inline">团队定位：</dt>
          <dd className="inline">{value.rosterDescription || '（空）'}</dd>
        </div>
      </dl>
      <p className="my-2">
        {value.sources.selfDescription === 'dossier' ? '自身自述：历史档案兼容' : '自身自述：当前成员配置'}
      </p>
      {typeof value.sources.fields === 'object' && (
        <p>
          {Object.entries(value.sources.fields)
            .map(([field, source]) => `${labels[field] ?? field}：${labels[source] ?? source}`)
            .join('；')}
        </p>
      )}
      {value.suppressedDossierFields.length > 0 && (
        <p className="mt-2">
          已停用可能覆盖当前身份的内容：
          {value.suppressedDossierFields.map((field) => labels[field] ?? field).join('、')}。
        </p>
      )}
    </details>
  );
}
