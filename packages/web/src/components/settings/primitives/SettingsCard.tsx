import type { CSSProperties, DragEvent, KeyboardEvent, ReactNode } from 'react';

type CardVariant = 'default' | 'highlight';

interface SettingsCardProps {
  variant?: CardVariant;
  as?: 'div' | 'section';
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
  style?: CSSProperties;
  'data-testid'?: string;
  'data-guide-id'?: string;
  'data-bootcamp-step'?: string;
  children: ReactNode;
  className?: string;
}

const variantStyles: Record<CardVariant, string> = {
  default: 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)]',
  highlight: 'border-cafe-accent/30 bg-cafe-accent/5',
};

export function SettingsCard({
  variant = 'default',
  as: Tag = 'div',
  onClick,
  onKeyDown,
  draggable,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  style,
  children,
  className,
  ...rest
}: SettingsCardProps) {
  return (
    <Tag
      className={`rounded-xl border p-4 transition ${variantStyles[variant]} ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${isDragging ? 'opacity-40' : ''} ${className ?? ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={style}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}
