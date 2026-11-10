import type { PluginIconSpec } from '@cat-cafe/shared';
import { HubIcon } from './hub-icons';

/** Plugin recipient glyph; deliberately distinct from a member avatar. */
export function PluginTargetIcon({ icon = 'blocks', size = 16 }: { icon?: PluginIconSpec; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center overflow-hidden bg-cafe-surface-sunken text-cafe-secondary"
      style={{ width: size, height: size, borderRadius: size > 20 ? 6 : 4 }}
    >
      {typeof icon === 'string' ? (
        <HubIcon name={icon} className="h-3/4 w-3/4" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon.src} alt="" className="h-full w-full object-cover" />
      )}
    </span>
  );
}
