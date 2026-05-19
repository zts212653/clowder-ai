'use client';
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

export function MemoryHub({ activeTab = 'feed', initialQuery, initialReferrerThread = null }: MemoryHubProps) {
  return (
    <div className="flex h-full flex-col bg-cafe-surface" data-testid="memory-hub">
      <header className="flex items-start gap-3 border-b border-cafe px-4 py-3">
        <MemoryNav active={activeTab} initialReferrerThread={initialReferrerThread} />
      </header>

      <main className="flex-1 overflow-y-auto p-4">
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
          <div data-testid="memory-tab-status">
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
      </main>
    </div>
  );
}
