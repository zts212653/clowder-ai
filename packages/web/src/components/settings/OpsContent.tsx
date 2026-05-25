'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { HubAgentSessionsTab } from '../HubAgentSessionsTab';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubObservabilityTab } from '../HubObservabilityTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { DEFAULT_OPS_SUBSECTION, OPS_SUBSECTIONS } from './ops-nav-config';

const OPS_TABS = OPS_SUBSECTIONS.map((s) => ({ key: s.id, label: s.label }));

export function OpsContent() {
  const searchParams = useSearchParams();
  const opsParam = searchParams.get('ops');
  const obsRaw = searchParams.get('obs');
  const OBS_VALID: ReadonlySet<string> = new Set(['overview', 'traces', 'health', 'callback-auth', 'eval']);
  const obsParam =
    obsRaw && OBS_VALID.has(obsRaw) ? (obsRaw as 'overview' | 'traces' | 'health' | 'callback-auth' | 'eval') : null;
  const validOpsParam = useMemo(
    () => (opsParam && OPS_SUBSECTIONS.some((s) => s.id === opsParam) ? opsParam : null),
    [opsParam],
  );
  const [activeTab, setActiveTab] = useState(validOpsParam ?? DEFAULT_OPS_SUBSECTION);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (validOpsParam) {
      setActiveTab(validOpsParam);
      setNonce((n) => n + 1);
    }
  }, [validOpsParam]);

  return (
    <div>
      <nav className="flex console-divider-b mb-5">
        {OPS_TABS.map((tab) => {
          const isActive = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center px-5 py-2.5 text-sm font-semibold transition-colors ${
                isActive
                  ? 'border-b-2 border-[var(--console-button-emphasis)] text-[var(--console-button-emphasis)]'
                  : 'text-cafe-muted hover:text-cafe-secondary'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <OpsSubsectionContent subsection={activeTab} obsSubTab={obsParam} nonce={nonce} />
    </div>
  );
}

function OpsSubsectionContent({
  subsection,
  obsSubTab,
  nonce,
}: {
  subsection: string;
  obsSubTab?: 'overview' | 'traces' | 'health' | 'callback-auth' | 'eval' | null;
  nonce: number;
}) {
  switch (subsection) {
    case 'usage':
      return (
        <div className="space-y-6">
          <HubRoutingPolicyTab />
          <HubToolUsageTab />
        </div>
      );
    case 'leaderboard':
      return <HubLeaderboardTab />;
    case 'observability':
      return <HubObservabilityTab initialSubTab={obsSubTab ?? undefined} subTabNonce={nonce} />;
    case 'agent-sessions':
      return <HubAgentSessionsTab />;
    case 'health':
      return (
        <div className="space-y-6">
          <HubGovernanceTab />
          <BrakeSettingsPanel />
        </div>
      );
    case 'commands':
      return <HubCommandsTab />;
    case 'rescue':
      return <HubClaudeRescueSection />;
    default:
      return null;
  }
}
