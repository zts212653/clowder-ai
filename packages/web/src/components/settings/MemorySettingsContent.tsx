'use client';

import { useCallback, useState } from 'react';
import { IndexStatus } from '../memory/IndexStatus';
import { MemoryFlagPanel } from '../memory/MemoryFlagPanel';
import { ToolUsageMetricsPanel } from '../memory/ToolUsageMetricsPanel';
import { MemoryCurationSettings } from './MemoryCurationSettings';
import { MemoryRecallDiagnostics } from './MemoryRecallDiagnostics';
import { ServiceStatusPanel } from './ServiceStatusPanel';

const MEMORY_FEATURES = ['memory-semantic-search'] as const;

/** Existing Settings home for the original index/config/service writers. */
export function MemorySettingsContent() {
  const [refreshToken, setRefreshToken] = useState(0);
  const [flagRevision, setFlagRevision] = useState(0);
  const serviceChanged = useCallback(() => setRefreshToken((value) => value + 1), []);
  const configChanged = useCallback(() => setFlagRevision((value) => value + 1), []);
  return (
    <section data-testid="memory-settings" aria-label="索引与召回" className="min-w-0 space-y-6">
      <header className="space-y-2">
        <h2 className="text-display-sm">索引与召回</h2>
        <p className="text-sm text-cafe-secondary">维护猫的检索能力：索引、嵌入服务、功能开关，以及工具使用的观测。</p>
        <a href="/memory?tab=library" className="text-compact text-cafe-accent underline">
          返回资料库 ↗
        </a>
      </header>
      <MemoryCurationSettings />
      <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
        <section aria-label="索引与服务" className="min-w-0 space-y-4">
          <h3 className="text-base font-medium">索引与服务</h3>
          <ServiceStatusPanel
            filterFeatures={MEMORY_FEATURES}
            title="语义搜索服务"
            anchorId="embedding-service-controls"
            onStateChange={serviceChanged}
            showReadState
          />
          <IndexStatus refreshToken={refreshToken} onConfigChange={configChanged} />
        </section>
        <div className="min-w-0 space-y-6">
          <MemoryFlagPanel key={flagRevision} />
          <ToolUsageMetricsPanel />
        </div>
      </div>
      <MemoryRecallDiagnostics />
    </section>
  );
}
