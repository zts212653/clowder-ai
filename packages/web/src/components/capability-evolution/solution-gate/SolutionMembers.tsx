import { changedMembers, type Experiment, type Role, type Scheme, schemeById } from './solution-example';

export function SolutionMembers({
  scheme,
  experiment,
  role,
  onRole,
  onSource,
}: {
  scheme: Scheme;
  experiment: Experiment;
  role: Role;
  onRole(value: Role): void;
  onSource(id: string): void;
}) {
  const changed = changedMembers(scheme);
  const members = scheme.members.filter(
    (member) =>
      role === 'all' ||
      (role === 'changed' ? changed.includes(member.id) : (experiment.roles[member.id] ?? []).includes(role)),
  );
  return (
    <section className="solution-members" aria-label="方案成员与差异">
      <div className="solution-filter" role="group" aria-label="成员用途">
        {(
          [
            ['all', '全部组成'],
            ['changed', '只看改动'],
            ['observation', '本次观测'],
            ['rubric', '本次规约'],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={role === value} onClick={() => onRole(value)}>
            {label}
          </button>
        ))}
      </div>
      <p className="solution-muted">
        {experiment.id} 的{experiment.state === 'unrun' ? '计划用途' : '实验用途'}
        ；仍是这份组成中的成员。下列版本号为设计示意，素材来源不等于本组合已运行。
      </p>
      {members.length === 0 && <p role="status">基线没有父方案；没有可列出的相对改动。</p>}
      {members.map((member) => {
        const previous = scheme.parent
          ? schemeById(scheme.parent).members.find((item) => item.id === member.id)
          : undefined;
        return (
          <article key={member.id} data-member={member.id} className="solution-member">
            <div>
              <span className="solution-category">{member.category}</span>
              <h3>{member.name}</h3>
              <p>{member.detail}</p>
            </div>
            <div className="solution-member-revision">
              <strong>
                {changed.includes(member.id) ? `${previous?.revision} → ${member.revision}` : member.revision}
              </strong>
              <span>{changed.includes(member.id) ? '相对父方案改变' : '保持不变'}</span>
            </div>
            <details>
              <summary>版本与来源</summary>
              <p>
                本例成员身份：{member.id}；用途：
                {(experiment.roles[member.id] ?? [])
                  .map((r) => (r === 'observation' ? '观测' : r === 'rubric' ? '规约' : r))
                  .join('、')}
                。
              </p>
              <p>内容、写权和历史继续由原对象 owner 持有。此稿没有登记 owner 资产，也没有取得修改权限。</p>
              <p>
                参考字段：<code>{member.sourceField}</code>。参考归档为 2026-09-09 v8，不能证明示例 {member.revision}{' '}
                的实际加载。
              </p>
              <button type="button" className="solution-link" onClick={() => onSource('archive-index')}>
                阅读参考索引原件
              </button>
            </details>
          </article>
        );
      })}
    </section>
  );
}
