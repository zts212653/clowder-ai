'use client';
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

const CONTENT_SURFACE_CLASS =
  'rounded-2xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.06)]';

export function MemoryHub({ activeTab = 'feed', initialQuery, initialReferrerThread = null }: MemoryHubProps) {
  return (
    <div className="flex h-full flex-col bg-[var(--console-shell-bg)]" data-testid="memory-hub">
      <main className="flex-1 overflow-y-auto p-5">
        <div className={CONTENT_SURFACE_CLASS} data-testid="memory-content-surface">
          <div className="mb-4">
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
              <ServiceStatusPanel filterFeatures={['memory-semantic-search']} title="语义搜索服务" />
              <IndexStatus />
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
