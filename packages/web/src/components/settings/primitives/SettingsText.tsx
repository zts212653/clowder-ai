import type { CSSProperties, ElementType, ReactNode } from 'react';

type TextVariant = 'base' | 'sm' | 'xs' | 'micro';
type TextTone = 'default' | 'secondary' | 'muted' | 'emerald' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

const variantMap: Record<TextVariant, string> = {
  base: 'text-base',
  sm: 'text-sm',
  xs: 'text-xs',
  micro: 'text-[10px]',
};

const toneMap: Record<TextTone, string> = {
  default: 'text-cafe',
  secondary: 'text-cafe-secondary',
  muted: 'text-cafe-muted',
  emerald: 'text-conn-emerald-text',
  green: 'text-conn-green-text',
  amber: 'text-conn-amber-text',
  red: 'text-conn-red-text',
  blue: 'text-conn-blue-text',
  purple: 'text-conn-purple-text',
};

interface SettingsTextProps {
  as?: ElementType;
  variant?: TextVariant;
  tone?: TextTone;
  className?: string;
  title?: string;
  style?: CSSProperties;
  children: ReactNode;
}

export function SettingsText({
  as: Tag = 'span',
  variant = 'xs',
  tone = 'muted',
  className,
  title,
  style,
  children,
}: SettingsTextProps) {
  return (
    <Tag
      className={`${variantMap[variant]} ${toneMap[tone]}${className ? ` ${className}` : ''}`}
      title={title}
      style={style}
    >
      {children}
    </Tag>
  );
}
