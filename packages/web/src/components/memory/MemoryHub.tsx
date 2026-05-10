'use client';

import React from 'react';
import { ServiceStatusPanel } from '../settings/ServiceStatusPanel';
import { KnowledgeFeed } from '../workspace/KnowledgeFeed';
import { EvidenceSearch } from './EvidenceSearch';
import { IndexStatus } from './IndexStatus';
import { MemoryNav, type MemoryTab } from './MemoryNav';

interface MemoryHubProps {
  readonly activeTab?: MemoryTab;
  readonly initialQuery?: string;
  readonly initialReferrerThread?: string | null;
}

function RecallPreview() {
  return (
    <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <p className="text-[13px] leading-[1.4] text-cafe">
        猫猫调用 search_evidence 时，这里展示 query、命中证据和引用状态。
      </p>
      <div className="rounded-[10px] bg-[var(--console-card-soft-bg)] p-4">
        <code className="text-xs text-cafe">—</code>
      </div>
    </div>
  );
}

export function MemoryHub({ activeTab = 'feed', initialQuery, initialReferrerThread = null }: MemoryHubProps) {
  const isFeed = activeTab === 'feed';
  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]" data-testid="memory-hub">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 gap-[18px] px-9 py-8">
        <header className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold text-cafe">记忆</h1>
            <p className="mt-1 text-[13px] text-cafe-secondary">查看知识涌现、检索证据和索引健康状态</p>
          </div>
        </header>

        <div className="flex items-center gap-2 h-10">
          <MemoryNav active={activeTab} initialReferrerThread={initialReferrerThread} />
        </div>

        <main className={`flex-1 ${isFeed ? 'flex min-h-0 gap-[18px]' : 'overflow-y-auto'}`}>
          {isFeed && (
            <>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto" data-testid="memory-tab-feed">
                <KnowledgeFeed />
              </div>
              <RecallPreview />
            </>
          )}
          {activeTab === 'search' && (
            <div data-testid="memory-tab-search">
              <EvidenceSearch initialQuery={initialQuery} />
            </div>
          )}
          {activeTab === 'status' && (
            <div className="space-y-6" data-testid="memory-tab-status">
              <ServiceStatusPanel filterFeatures={['memory-semantic-search']} title="语义搜索服务" />
              <IndexStatus />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
