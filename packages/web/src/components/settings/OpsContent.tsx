'use client';

import { useState } from 'react';
import { BrakeSettingsPanel } from '../BrakeSettingsPanel';
import { HubClaudeRescueSection } from '../HubClaudeRescueSection';
import { HubCommandsTab } from '../HubCommandsTab';
import { HubGovernanceTab } from '../HubGovernanceTab';
import { HubLeaderboardTab } from '../HubLeaderboardTab';
import { HubObservabilityTab } from '../HubObservabilityTab';
import { HubRoutingPolicyTab } from '../HubRoutingPolicyTab';
import { HubToolUsageTab } from '../HubToolUsageTab';
import { DEFAULT_OPS_SUBSECTION, OPS_SUBSECTIONS } from './ops-nav-config';

export function OpsContent() {
  const [activeTab, setActiveTab] = useState(DEFAULT_OPS_SUBSECTION);

  return (
    <div>
      <div className="flex gap-1.5 mb-5 flex-wrap">
        {OPS_SUBSECTIONS.map((sub) => (
          <button
            key={sub.id}
            type="button"
            onClick={() => setActiveTab(sub.id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-full transition-colors ${
              activeTab === sub.id
                ? 'bg-cafe-accent text-[var(--cafe-surface)]'
                : 'console-pill text-cafe-secondary hover:text-cafe'
            }`}
          >
            {sub.label}
          </button>
        ))}
      </div>
      <OpsSubsectionContent subsection={activeTab} />
    </div>
  );
}

function OpsSubsectionContent({ subsection }: { subsection: string }) {
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
      return <HubObservabilityTab />;
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
