import { useEffect, useState } from 'react';
import type { RestrictedCollectiveScope } from './client-types.js';
import { recoverOwnScopeDrafts } from './collective-scope-recovery.js';

const recoveryCopy = {
  checking: ['正在核对访问权限', '刚才打开的作品和讨论已经关闭，正在重新核对你的访问权限。'],
  membership_lost: ['你已无法访问这个共同体', '你已不在这个共同体的成员名单中。刚才打开的作品、讨论和引用已经关闭。'],
  unavailable: ['暂时无法打开这个共同体', '暂时无法确认你对这个共同体的访问权限。恢复后可以重新检查。'],
  session_expired: ['登录已失效', '请重新登录，再确认是否仍有权访问刚才打开的作品和讨论。'],
} as const;

export function CollectiveScopeRecovery({
  scope,
  onRetry,
  onAuthenticate,
}: {
  readonly scope: RestrictedCollectiveScope;
  readonly onRetry: () => Promise<void>;
  readonly onAuthenticate: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<ReturnType<typeof recoverOwnScopeDrafts>>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const { serviceInstanceId, collectiveId, humanId } = scope;
  useEffect(() => {
    try {
      setDrafts(recoverOwnScopeDrafts({ serviceInstanceId, collectiveId, humanId, reason: 'checking' }));
    } catch {
      setError('浏览器暂时无法读取本机草稿，请保留当前页面后重试。');
    }
  }, [serviceInstanceId, collectiveId, humanId]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const [title, description] = recoveryCopy[scope.reason];
  return (
    <div className="scope-recovery">
      <section className="scope-recovery-card" aria-label="访问恢复">
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="entry-action">
          <button
            type="button"
            disabled={busy || scope.reason === 'checking'}
            onClick={() => void run(scope.reason === 'session_expired' ? onAuthenticate : onRetry)}
          >
            {scope.reason === 'session_expired' ? '重新登录' : '重新检查访问'}
          </button>
        </div>
        {drafts.map((draft, index) => (
          <section className="scope-recovery-draft" key={draft.key} aria-label={`未发送的草稿 ${index + 1}`}>
            <header>
              <strong>你还没发出的话</strong>
              <button
                type="button"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(draft.body);
                    setNotice('已复制你的文字');
                  })
                }
              >
                复制文字
              </button>
            </header>
            <textarea aria-label={`未发送的文字 ${index + 1}`} readOnly value={draft.body} />
            <small>仅保留你自己写下的文字；引用原文、收件人与回复目标已移除。</small>
          </section>
        ))}
        {notice && <output>{notice}</output>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
