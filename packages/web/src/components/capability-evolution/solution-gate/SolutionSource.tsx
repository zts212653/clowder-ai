import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface Source {
  title: string;
  path: string;
  sha256: string;
  content: string;
  imageUrl?: string;
}
export function SolutionSource({
  sourceId,
  unavailable,
  onClose,
}: {
  sourceId: string;
  unavailable: boolean;
  onClose(): void;
}) {
  const [value, setValue] = useState<Source | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setValue(null);
    setError('');
    if (unavailable) {
      setError('参考原件读取失败；所选方案与实验仍保留。');
      return;
    }
    void apiFetch(`/api/design/f311-solution/source/${sourceId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('source unavailable');
        const body: Source = await response.json();
        if (!controller.signal.aborted) setValue(body);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('参考原件读取失败；所选方案与实验仍保留。');
      });
    return () => controller.abort();
  }, [sourceId, unavailable, attempt]);
  return (
    <section className="solution-source" aria-label="原件阅读">
      <button className="solution-link" type="button" onClick={onClose}>
        ← 返回所选实验
      </button>
      <p className="solution-tag">真实参考归档 · 不是示例实验的证据</p>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => setAttempt((v) => v + 1)}>
            重试原件
          </button>
        </>
      ) : !value ? (
        <p role="status">正在读取原件…</p>
      ) : (
        <>
          <h2>{value.title}</h2>
          {value.imageUrl && (
            <img
              src={value.imageUrl}
              alt="v8 右侧更宽场景，真实归档 20 秒帧；不代表示例 S2 的效果"
              onError={() => setError('参考图片读取失败；所选方案与实验仍保留。')}
            />
          )}
          {!value.imageUrl && <pre className="solution-source-content">{value.content}</pre>}
          <details>
            <summary>Raw · 路径与内容哈希</summary>
            <p>{value.path}</p>
            <code>sha256:{value.sha256}</code>
          </details>
        </>
      )}
    </section>
  );
}
