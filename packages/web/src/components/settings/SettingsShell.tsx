'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { SettingsContent } from './SettingsContent';
import { SettingsNav } from './SettingsNav';
import { DEFAULT_SECTION, SETTINGS_SECTIONS } from './settings-nav-config';

function SettingsShellInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection = searchParams.get('s') ?? DEFAULT_SECTION;

  const handleSelect = useCallback(
    (sectionId: string) => {
      router.replace(`/settings?s=${sectionId}`, { scroll: false });
    },
    [router],
  );

  const sectionMeta = SETTINGS_SECTIONS.find((s) => s.id === activeSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="console-shell flex h-full min-h-0 overflow-hidden bg-[var(--console-shell-bg)]">
      <aside
        className="flex w-[220px] flex-shrink-0 flex-col overflow-hidden bg-[var(--console-panel-bg)]"
        data-console-panel="settings-nav"
      >
        <div className="px-4 pt-4 pb-2">
          <h1 className="text-lg font-bold text-cafe">设置</h1>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <SettingsNav activeSection={activeSection} onSelect={handleSelect} />
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="space-y-5 px-8 py-7">
          <div>
            <h2 className="text-xl font-bold text-cafe">{sectionMeta.label}</h2>
            <p className="mt-1 text-[13px] text-cafe-secondary">{sectionMeta.description}</p>
          </div>
          <SettingsContent section={activeSection} />
        </div>
      </div>
    </div>
  );
}

export function SettingsShell() {
  return (
    <Suspense>
      <SettingsShellInner />
    </Suspense>
  );
}
