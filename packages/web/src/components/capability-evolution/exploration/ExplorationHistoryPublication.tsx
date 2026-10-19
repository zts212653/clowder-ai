import { refIdentity } from '@cat-cafe/shared';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import type { useExplorationWorkspace } from './use-exploration-workspace';

type Workspace = ReturnType<typeof useExplorationWorkspace>;

export function ExplorationHistoryRecovery({ message, onOpen }: { message?: string; onOpen: () => void }) {
  return (
    <section className="exploration-history-recovery" aria-label="最新历史可读">
      <strong>最新历史已经发布，可以直接阅读</strong>
      <p>{message ?? '上次阅读位置属于较早的内容版本，原选择仍会保留。'}</p>
      <button type="button" className="exploration-link" onClick={onOpen}>
        打开最新历史
      </button>
    </section>
  );
}

export function ExplorationHistoryPublicationNotice({ workspace }: { workspace: Workspace }) {
  const catName = useCatNameResolver();
  const publication = workspace.catalog?.publication;
  if (!publication) return null;
  const update = publication.selectionUpdate;
  const available = refIdentity(publication.current.ref) !== refIdentity(publication.selected.ref);
  const latestAttempt = publication.attempts.at(-1);
  const next = update?.nextSelection;
  return (
    <>
      {available && (
        <div className="exploration-notice" role="status" aria-label="历史内容更新">
          <p>
            {update?.kind === 'removed'
              ? '这一步或案例已从新版撤下，当前旧稿保留。'
              : update?.kind === 'moved'
                ? '这道错题已移到新的步骤，当前阅读位置保留。'
                : '历史内容已有更新，当前阅读内容保留。'}
          </p>
          {publication.current.reason && <p>{publication.current.reason}</p>}
          {publication.current.actorRef && (
            <p className="exploration-caption">
              {catName(publication.current.actorRef.replace(/^cat:/, ''))}
              {publication.current.occurredAt && ` · ${new Date(publication.current.occurredAt).toLocaleString()}`}
            </p>
          )}
          <button
            type="button"
            className="exploration-link"
            onClick={() => void workspace.adoptPublication(next ?? { selectedSourceRef: publication.current.ref })}
          >
            {next ? '查看新版' : '打开最新历史'}
          </button>
        </div>
      )}
      {latestAttempt?.status === 'failed' && (
        <p className="exploration-notice" role="status">
          最近一次内容发布未成功，仍保留上一份完整稿。原因见历史发布记录。
        </p>
      )}
      {workspace.publicationError && <p role="alert">{workspace.publicationError}</p>}
    </>
  );
}

export function ExplorationHistoryPublicationRecords({ workspace }: { workspace: Workspace }) {
  const catName = useCatNameResolver();
  const publication = workspace.catalog?.publication;
  if (!publication) return null;
  return (
    <section aria-label="历史发布与来源">
      <h4>历史发布与来源</h4>
      <p>
        正在阅读：{publication.selected.bundled ? '随应用提供的历史稿' : `第 ${publication.selected.revision} 次发布`}
      </p>
      <p>
        最新历史：{publication.current.bundled ? '随应用提供的历史稿' : `第 ${publication.current.revision} 次发布`}
      </p>
      <ol>
        {[...publication.attempts].reverse().map((attempt) => (
          <li key={attempt.revision}>
            <p>
              {catName(attempt.actorRef.replace(/^cat:/, ''))} · {new Date(attempt.occurredAt).toLocaleString()} ·{' '}
              {attempt.status === 'failed' ? '发布失败' : attempt.action === 'restore' ? '恢复旧稿' : '已发布'}
            </p>
            <p>{attempt.reason}</p>
            {attempt.failureCode && <p>来源状态：{failureLabel(attempt.failureCode)}</p>}
          </li>
        ))}
      </ol>
      {publication.hasMore && <p>这里只显示最近 50 次尝试；完整历史记录仍保留。</p>}
    </section>
  );
}
function failureLabel(code: string) {
  return (
    (
      {
        source_unavailable: '暂时无法读取',
        source_not_on_main: '内容尚未合入',
        invalid_history: '内容未通过完整性核验',
        unsupported_history_schema: '当前应用尚不支持这份稿的格式',
        restore_not_found: '未找到可恢复的历史稿',
      } as Record<string, string>
    )[code] ?? '来源校验未通过'
  );
}
