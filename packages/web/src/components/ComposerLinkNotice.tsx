'use client';

import { chatComposerCopy } from './chat-composer.shell-copy';
import { useShellCopy } from './shell/shell-copy';

export function ComposerLinkNotice({ targets }: { targets: readonly string[] }) {
  const copy = useShellCopy(chatComposerCopy);
  return (
    <div data-testid="composer-link-notice" className="px-1 pb-1 text-xs text-[var(--shell-muted)]">
      <output className="block">{copy.unmarkedLinks}</output>
      <details className="mt-1">
        <summary className="cursor-pointer">{copy.viewLinkTargets}</summary>
        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto text-[var(--shell-ink)]">
          {targets.map((href, index) => (
            <li key={`${index}:${href}`}>
              <code className="break-all select-text">{href}</code>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
