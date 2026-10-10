import type { ConnectorIconSpec } from '@cat-cafe/shared';
import type { ComponentType } from 'react';
import {
  AuthKeyIcon,
  ConnectorImage,
  GitHubIcon,
  HoldBallIcon,
  ReturnArrowIcon,
  RobotIcon,
  SchedulerIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from './ConnectorIcons';
import { BallotIcon } from './VoteIcons';

const SVG_ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  ballot: BallotIcon,
  users: UsersIcon,
  scheduler: SchedulerIcon,
  settings: SettingsIcon,
  'hold-ball': HoldBallIcon,
  'auth-key': AuthKeyIcon,
  search: SearchIcon,
  robot: RobotIcon,
  'return-arrow': ReturnArrowIcon,
};

/** One registry icon renderer for body, Queue and reference surfaces. */
export function ConnectorIcon({
  iconSpec,
  fallbackIcon,
  className = 'w-4 h-4',
}: {
  iconSpec?: ConnectorIconSpec;
  fallbackIcon?: string;
  className?: string;
}) {
  if (iconSpec && 'src' in iconSpec && iconSpec.src) {
    return <ConnectorImage src={iconSpec.src} alt="connector" className={className} />;
  }
  if (iconSpec?.type === 'svg') {
    const Icon = SVG_ICON_MAP[iconSpec.iconId];
    if (Icon) return <Icon className={className} />;
  }
  if (fallbackIcon?.startsWith('/') || fallbackIcon?.startsWith('http')) {
    return <ConnectorImage src={fallbackIcon} alt="connector" className={className} />;
  }
  if (fallbackIcon) return <span className={className}>{fallbackIcon}</span>;
  return <RobotIcon className={className} />;
}
