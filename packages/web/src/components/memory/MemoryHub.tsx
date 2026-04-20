'use client';

import React from 'react';
import { KnowledgeFeed } from '../workspace/KnowledgeFeed';
import { EvidenceSearch } from './EvidenceSearch';
import { HealthReport } from './HealthReport';
import { IndexStatus } from './IndexStatus';
import { MemoryNav, type MemoryTab } from './MemoryNav';

interface MemoryHubProps {
  readonly activeTab?: MemoryTab;
  readonly initialQuery?: string;
}

export function MemoryHub({ activeTab = 'feed', initialQuery }: MemoryHubProps) {
  return (
    <div className="flex h-full flex-col bg-cafe-surface" data-testid="memory-hub">
      <header className="flex items-center gap-3 border-b border-cafe px-4 py-3">
        <MemoryNav active={activeTab} />
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
          <div data-testid="memory-tab-health">
            <HealthReport />
          </div>
        )}
      </main>
    </div>
  );
}
