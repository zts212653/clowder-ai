import { Fragment } from 'react';
import { pluginSetupStep } from './plugin-manager-copy';

/** Only explicit inline-code spans are formatted; plugin text never becomes HTML or executable markup. */
export function PluginManagerSetupStep({ pluginId, step }: { pluginId: string; step: string }) {
  const translated = pluginSetupStep(pluginId, step);
  const matches = [...translated.matchAll(/`([^`]+)`/g)];
  let end = 0;
  return (
    <>
      {matches.map((match) => {
        const start = match.index;
        const plain = translated.slice(end, start);
        end = start + match[0].length;
        return (
          <Fragment key={start}>
            {plain}
            <code className="break-all rounded bg-cafe-surface-sunken px-1 font-mono text-xs">{match[1]}</code>
          </Fragment>
        );
      })}
      {translated.slice(end)}
    </>
  );
}
