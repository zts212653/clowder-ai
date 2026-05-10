'use client';

import { HubIcon } from '../hub-icons';

interface SettingsPlaceholderProps {
  section: string;
  description: string;
}

export function SettingsPlaceholder({ section, description }: SettingsPlaceholderProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span className="text-cafe-muted mb-3">
        <HubIcon name="settings" className="w-10 h-10" />
      </span>
      <h3 className="text-base font-medium text-cafe mb-1">{section}</h3>
      <p className="text-sm text-cafe-muted max-w-sm">{description}</p>
      <p className="text-xs text-cafe-muted mt-3">Phase 1 — 框架就绪，功能开发中</p>
    </div>
  );
}
