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
import { SettingsFilterTabs } from './primitives';

const OPS_TABS = OPS_SUBSECTIONS.map((s) => ({ key: s.id, label: s.label }));

export function OpsContent() {
  const searchParams = useSearchParams();
  const opsParam = searchParams.get('ops');
  const obsRaw = searchParams.get('obs');
  const OBS_VALID: ReadonlySet<string> = new Set(['overview', 'traces', 'health', 'callback-auth']);
  const obsParam =
    obsRaw && OBS_VALID.has(obsRaw) ? (obsRaw as 'overview' | 'traces' | 'health' | 'callback-auth') : null;
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
      <div className="mb-5">
        <SettingsFilterTabs tabs={OPS_TABS} activeKey={activeTab} onTabChange={setActiveTab} />
      </div>
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
  obsSubTab?: 'overview' | 'traces' | 'health' | 'callback-auth' | null;
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
