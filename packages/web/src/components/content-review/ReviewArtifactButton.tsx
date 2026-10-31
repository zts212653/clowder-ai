'use client';
import type { ArtifactReviewView, EntrustedWorkOwnerReadV1, PreparedMediaReviewContext } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export function ReviewArtifactButton({
  ownerRead,
  onPrepared,
}: {
  ownerRead: EntrustedWorkOwnerReadV1;
  onPrepared: (view: ArtifactReviewView) => void;
}) {
  const artifact = ownerRead.preparedArtifact;
  if (!artifact || !/^(?:content:|\/uploads\/.*\.(?:png|mp4)$)/i.test(artifact.artifactRef)) return null;
  return (
    <PrepareReviewButton
      context={{
        taskId: ownerRead.envelope.subjectRef.replace(/^task:work:/, ''),
        title: '',
        expectedTaskRevision: ownerRead.envelope.revision,
        artifactRef: artifact.artifactRef,
        expectedArtifactRevision: artifact.artifactRevision,
      }}
      onPrepared={onPrepared}
    />
  );
}

function PrepareReviewButton({
  context,
  onPrepared,
}: {
  context: PreparedMediaReviewContext;
  onPrepared: (view: ArtifactReviewView) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch('/api/artifact-reviews/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          taskId: context.taskId,
          expectedTaskRevision: context.expectedTaskRevision,
          artifactRef: context.artifactRef,
          expectedArtifactRevision: context.expectedArtifactRevision,
          operationId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) {
        if ([401, 403, 404, 409, 410].includes(response.status)) {
          // Prepare has no review identity on failure; each retained reader must recheck its own authority.
          window.dispatchEvent(new Event('cat-cafe:artifact-review-changed'));
          window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
        }
        throw new Error(
          response.status === 409 ? '原任务或产物已变化，请刷新后再打开。' : '暂时无法打开审阅，请稍后重试。',
        );
      }
      onPrepared((await response.json()) as ArtifactReviewView);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={busy}
        onClick={() => void prepare()}
        data-testid="open-artifact-review"
        className="rounded-lg border border-cafe-accent/30 bg-cafe-accent/10 px-3 py-2 text-xs font-semibold text-cafe-accent disabled:opacity-50"
      >
        {busy ? '正在打开…' : '审阅产物'}
      </button>
      {error ? (
        <p role="alert" className="mt-1 max-w-64 text-xs text-cafe-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function ArtifactReviewEntry({
  artifactRef,
  threadId,
  onPrepared,
}: {
  artifactRef: string;
  threadId: string;
  onPrepared: (view: ArtifactReviewView) => void;
}) {
  const [contexts, setContexts] = useState<PreparedMediaReviewContext[]>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setContexts([]);
    setSelected('');
    const query = new URLSearchParams({ artifactRef, threadId });
    void apiFetch(`/api/artifact-reviews/context?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { contexts: PreparedMediaReviewContext[] };
        if (!controller.signal.aborted) {
          setContexts(body.contexts);
          if (body.contexts.length === 1) setSelected(body.contexts[0]?.taskId ?? '');
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [artifactRef, threadId]);
  if (!contexts.length) return null;
  const current = contexts.find((item) => item.taskId === selected);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {contexts.length > 1 ? (
        <select
          aria-label="选择审阅对应的原任务"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="max-w-48 rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-xs"
        >
          <option value="">选择原任务</option>
          {contexts.map((item) => (
            <option key={item.taskId} value={item.taskId}>
              {item.title}
            </option>
          ))}
        </select>
      ) : null}
      {current ? <PrepareReviewButton context={current} onPrepared={onPrepared} /> : null}
    </div>
  );
}
