'use client';

import { ChatBackgroundPicker } from '../chat-background/ChatBackgroundPicker';
import type { CoCreatorConfig } from '../config-viewer-types';
import { useShellCopy } from '../shell/shell-copy';
import { YouProfileCard } from './YouProfileCard';
import { youSettingsCopy } from './you-settings-copy';

export function YouSettingsPage({
  coCreator,
  loadError,
  reload,
}: {
  coCreator: CoCreatorConfig | null;
  loadError: boolean;
  reload(): Promise<void>;
}) {
  const copy = useShellCopy(youSettingsCopy);
  return (
    <div className="you-settings-page" data-testid="you-settings-page">
      <h1>{copy.you}</h1>
      <YouProfileCard coCreator={coCreator} loadError={loadError} reload={reload} />
      <section className="you-settings-card" aria-label={copy.background}>
        <div className="you-settings-card-heading">
          <h2>{copy.background}</h2>
          <span>{copy.global}</span>
        </div>
        <ChatBackgroundPicker />
      </section>
    </div>
  );
}
