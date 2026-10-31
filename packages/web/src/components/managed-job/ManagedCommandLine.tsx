'use client';

import { AppTooltip } from '../AppTooltip';

/** The same exact command is recoverable by pointer and keyboard when its inline label is truncated. */
export function ManagedCommandLine({ command }: { command: string }) {
  return (
    <AppTooltip label={command} side="top" multiline intent="content" onlyWhenTruncated>
      <code
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus reveals the full truncated command through the shared tooltip.
        tabIndex={0}
        data-testid="execution-command"
        className="shell-focusable block truncate font-mono text-xs text-cafe-secondary"
      >
        {command}
      </code>
    </AppTooltip>
  );
}
