import type { PluginIconSpec } from '@cat-cafe/shared';
import { HubIcon } from '../../hub-icons';
import { GitHubIcon } from '../../icons/ConnectorIcons';
import { settingsResourceAvatarClass } from '../../SettingsResourceCard';

export function PluginVisual({
  icon,
  iconBg,
  name,
  size = 'small',
  className = '',
  variant = 'avatar',
}: {
  icon: PluginIconSpec;
  iconBg?: string;
  name: string;
  size?: 'small' | 'large';
  className?: string;
  variant?: 'avatar' | 'rail';
}) {
  const rail = variant === 'rail';
  const glyphClassName = rail || size === 'large' ? 'h-5 w-5' : 'h-4.5 w-4.5';
  const imageIcon = typeof icon !== 'string';
  const foreground = rail ? 'inherit' : iconBg ? 'var(--cafe-image-foreground)' : 'var(--cafe-text-secondary)';
  return (
    <span
      data-plugin-icon={typeof icon === 'string' ? icon : icon.src}
      className={`${rail ? 'flex h-9 w-9 items-center justify-center' : settingsResourceAvatarClass} ${imageIcon ? 'overflow-hidden' : ''} ${className}`}
      style={{ backgroundColor: rail ? 'transparent' : (iconBg ?? 'var(--conn-gray-bg)'), color: foreground }}
    >
      {typeof icon === 'string' ? (
        icon === 'github' ? (
          <GitHubIcon className={glyphClassName} color={foreground} />
        ) : (
          <HubIcon name={icon} className={glyphClassName} />
        )
      ) : rail && icon.type === 'svg' ? (
        <span
          aria-hidden="true"
          className={glyphClassName}
          style={{
            backgroundColor: 'currentColor',
            mask: `url(${JSON.stringify(icon.src)}) center / contain no-repeat`,
          }}
        />
      ) : (
        // Package-relative paths are rewritten to a Host-owned URL before reaching the Console.
        // eslint-disable-next-line @next/next/no-img-element
        // biome-ignore lint/performance/noImgElement: package assets are runtime URLs, not build-time imports.
        <img src={icon.src} alt="" className={rail ? 'h-5 w-5 object-contain' : 'h-full w-full object-cover'} />
      )}
      <span className="sr-only">{name}</span>
    </span>
  );
}
