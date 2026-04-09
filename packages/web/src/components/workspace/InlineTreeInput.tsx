import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { DirIcon, FileIcon } from './FileIcons';

interface InlineTreeInputProps {
  depth: number;
  kind: 'file' | 'directory' | 'rename';
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InlineTreeInput({ depth, kind, defaultValue = '', onConfirm, onCancel }: InlineTreeInputProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();

  useEffect(() => {
    // Auto-focus and select filename (not extension) on mount
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (defaultValue) {
      const dot = defaultValue.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : defaultValue.length);
    }
  }, [defaultValue]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (ime.isComposing()) return;
      if (e.key === 'Enter' && value.trim()) {
        e.preventDefault();
        onConfirm(value.trim());
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ime.isComposing() reads a live ref; adding ime would cause unnecessary re-renders
    [value, onConfirm, onCancel],
  );

  return (
    <div className="flex items-center py-0.5" style={{ paddingLeft: `${depth * 16 + 8}px` }}>
      <span className="w-3 flex-shrink-0" />
      {kind === 'directory' ? <DirIcon expanded={false} /> : <FileIcon name={value || 'untitled'} />}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
        onBlur={() => {
          if (value.trim()) onConfirm(value.trim());
          else onCancel();
        }}
        className="flex-1 ml-1.5 text-xs bg-cocreator-light/40 border border-cocreator-primary/40 rounded px-1 py-0.5 outline-none focus:border-cocreator-primary"
        placeholder={kind === 'directory' ? '目录名...' : '文件名...'}
      />
    </div>
  );
}
