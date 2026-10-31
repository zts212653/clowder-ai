import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/globals.css';
import { ContentModificationPanel } from '@/components/content-review/ContentModificationPanel';
import { apiFetch } from '@/utils/api-client';

function ComparisonHost() {
  const [view, setView] = useState<ContentModificationDetailView | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    const requestId = new URLSearchParams(location.search).get('request');
    void apiFetch(`/api/content-modifications/${encodeURIComponent(requestId ?? '')}`).then(async (response) => {
      if (!response.ok) throw new Error(`owner read ${response.status}`);
      setView(await response.json());
    });
  }, []);
  return (
    <main className="flex h-screen flex-col bg-cafe-surface p-4">
      <h1 className="mb-3 text-base">工作区版本对比 · 隔离验收</h1>
      {view && !closed ? (
        <ContentModificationPanel
          source={view.record.payload.source}
          ownerUserId="operator"
          title="真实媒体文件"
          initialRequest={view.record}
          onClose={() => setClosed(true)}
        />
      ) : null}
      {closed ? (
        <button type="button" onClick={() => setClosed(false)}>
          重新打开候选
        </button>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<ComparisonHost />);
