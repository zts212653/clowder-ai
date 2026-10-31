'use client';

import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { SettingsPageHeader } from './SettingsPageHeader';

export function MarketplaceContent() {
  return (
    <div className="space-y-5">
      <SettingsPageHeader title="能力市场" subtitle="搜索和安装 MCP、Skill、插件等能力包" />
      <MarketplacePanel />
    </div>
  );
}
