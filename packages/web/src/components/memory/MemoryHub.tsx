'use client';
import { useCallback, useState } from 'react';
import { ServiceStatusPanel } from '../settings/ServiceStatusPanel';
import { KnowledgeFeed } from '../workspace/KnowledgeFeed';
import { CollectionCatalog } from './CollectionCatalog';
import { CollectionGraph } from './CollectionGraph';
import { EvidenceSearch } from './EvidenceSearch';
import { HealthReport } from './HealthReport';
import { IndexStatus } from './IndexStatus';
import { MemoryFlagPanel } from './MemoryFlagPanel';
import { MemoryNav, type MemoryTab } from './MemoryNav';
import { ToolUsageMetricsPanel } from './ToolUsageMetricsPanel';

interface MemoryHubProps {
  readonly activeTab?: MemoryTab;
  readonly initialQuery?: string;
  readonly initialReferrerThread?: string | null;
}

const MEMORY_SEMANTIC_SERVICE_FEATURES = ['memory-semantic-search'] as const;

export function MemoryHub({ activeTab = 'feed', initialQuery, initialReferrerThread = null }: MemoryHubProps) {
  const [indexRefreshToken, setIndexRefreshToken] = useState(0);
  const handleServiceStateChange = useCallback(() => {
    setIndexRefreshToken((token) => token + 1);
  }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]" data-testid="memory-hub">
      <main className="flex-1 overflow-y-auto">
        <div
          className="m-3 flex flex-col gap-[18px] rounded-[18px] bg-[var(--console-shell-bg)] px-9 py-8 shadow-[var(--console-shadow-soft)]"
          data-testid="memory-content-surface"
        >
          <header className="flex items-center gap-4">
            <div>
              <h1 className="text-xl font-bold text-cafe">记忆</h1>
              <p className="mt-1 text-compact text-cafe-secondary">查看知识涌现、检索证据和索引健康状态</p>
            </div>
          </header>
          <div>
            <MemoryNav active={activeTab} initialReferrerThread={initialReferrerThread} />
          </div>
          {activeTab === 'feed' && (
            <div data-testid="memory-tab-feed">
              <KnowledgeFeed />
            </div>
          )}
          {activeTab === 'search' && (
            <div data-testid="memory-tab-search">
              <EvidenceSearch initialQuery={initialQuery} />
            </div>
          )}
          {activeTab === 'status' && (
            <div className="space-y-4" data-testid="memory-tab-status">
              <ServiceStatusPanel
                filterFeatures={MEMORY_SEMANTIC_SERVICE_FEATURES}
                title="语义搜索服务"
                anchorId="embedding-service-controls"
                onStateChange={handleServiceStateChange}
              />
              <IndexStatus refreshToken={indexRefreshToken} />
            </div>
          )}
          {activeTab === 'health' && (
            <div className="space-y-4" data-testid="memory-tab-health">
              <MemoryFlagPanel />
              <HealthReport />
              <ToolUsageMetricsPanel />
            </div>
          )}
          {activeTab === 'catalog' && (
            <div data-testid="memory-tab-catalog">
              <CollectionCatalog />
            </div>
          )}
          {activeTab === 'graph' && (
            <div data-testid="memory-tab-graph">
              <CollectionGraph />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
