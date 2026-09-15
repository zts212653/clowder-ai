import type { EvolutionResolvedExplorationReviewV1 } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';

const labels: Record<string, string> = {
  owner_version_review_unavailable: '本项目的正式版本暂不可读，公开归档不能代替它。',
  owner_version_review_failed: '本项目的版本来源读取失败，公开归档仍可单独查看。',
  owner_version_review_invalid: '本项目的版本来源未通过契约核验，尚无法确认正式版本。',
  owner_version_review_identity_mismatch: '版本来源与本项目不一致，已停止使用该来源的版本。',
  owner_public_archive_invalid: '公开归档未通过完整性核验，已停止使用；请核对来源后重新读取。',
  owner_public_archive_unavailable: '公开归档来源当前无法读取，恢复后可重试。',
  owner_exploration_lineage_withheld:
    '部分版本的谱系关系不完整，已停止展示这些版本及其后代；其余记录仍可阅读，请核对版本来源。',
  owner_exploration_projection_invalid: '版本与实验的阅读关系未通过核验，已停止使用；请核对来源后重新读取。',
  target_drift: '版本来源的目标已变化，需要重新核对。',
  baseline_robustness_evaluation_missing: '正式基线尚缺稳健性评估。',
  sealed_holdout_not_published: '尚未发布独立留出评估；公开记录不能代替独立验收。',
  public_candidate_catalog_unavailable: '公开候选来源暂不可读；本项目版本仍可单独查看。',
};
export function ExplorationSourceStatus({
  blockers = [],
  retry,
}: {
  blockers?: EvolutionResolvedExplorationReviewV1['blockers'];
  retry(): void;
}) {
  // The archive/adoption boundary already has a permanent caption; actionable source failures remain visible here.
  const failures = blockers.filter((entry) => entry.code !== 'public_archive_not_program_adoption');
  if (!failures.length) return null;
  return (
    <aside className="exploration-notice" aria-label="探索来源待确认" role="status">
      <p>
        <strong>仍有来源待确认 · </strong>
        {labels[failures[0]!.code] ?? '此来源仍有尚未确认的事项，不能据此声称已验证或采用。'}
      </p>
      <details>
        <summary>查看全部 {failures.length} 项来源与恢复入口</summary>
        <ul>
          {failures.map((entry, index) => (
            <li key={`${entry.code}:${index}`}>
              {labels[entry.code] ?? '此来源仍有尚未确认的事项，不能据此声称已验证或采用。'}
              <details>
                <summary>查看具体来源</summary>
                <p>{entry.code}</p>
                <EvolutionSource label="来源记录" source={entry.ownerRef} />
              </details>
            </li>
          ))}
        </ul>
        <button type="button" onClick={retry}>
          重新核对来源
        </button>
      </details>
    </aside>
  );
}
