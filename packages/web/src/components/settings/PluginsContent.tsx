'use client';

import { useState } from 'react';
import { HubIcon } from '../hub-icons';
import {
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { GithubConfigPanel } from './GithubConfigPanel';
import { SettingsBadge, SettingsText } from './primitives';

export function PluginsContent() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <article className={settingsResourceCardClass}>
        <button
          type="button"
          className={`${settingsResourceRowClass} w-full`}
          style={{ textAlign: 'left' }}
          onClick={() => setExpandedId(expandedId === 'github' ? null : 'github')}
        >
          <div className={settingsResourceAvatarClass} style={{ backgroundColor: '#24292e' }}>
            <span style={{ color: 'var(--cafe-surface)' }}>
              <HubIcon name="key" className="h-5 w-5" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-semibold">
              GitHub
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5">
              PR 追踪、Review 投递、CI/CD 监控与 Token 配置
            </SettingsText>
            <SettingsText as="p" tone="muted" className="mt-0.5">
              内置插件
            </SettingsText>
          </div>
          <SettingsBadge tone="emerald" className="shrink-0 font-bold">
            可配置
          </SettingsBadge>
        </button>
        {expandedId === 'github' && <GithubConfigPanel />}
      </article>
    </div>
  );
}
