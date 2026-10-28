import type { ReactNode, RefObject } from 'react';
import type { FileActionSource } from './file-action-client';
import type { useArtworkViewport } from './useArtworkViewport';

export type FileActionsProps = {
  src?: string | null;
  mediaType?: 'image' | 'video';
  source: FileActionSource;
  filename: string;
  mime?: string;
  byteLength?: number;
  width?: number;
  height?: number;
  root?: RefObject<HTMLElement>;
  contextRef?: RefObject<HTMLElement | null>;
  target?: HTMLElement | null;
  visible?: boolean;
  text?: string;
  copyName?: boolean;
  showDownload?: boolean;
  initiallyOpen?: boolean;
  hideTrigger?: boolean;
  onOpenChange?: (open: boolean) => void;
  appearance?: 'menu' | 'classic' | 'copy';
  viewport?: Pick<ReturnType<typeof useArtworkViewport>, 'renderedScale' | 'fit' | 'actual'>;
  wholeWorkAction?: ReactNode;
  onHistory?: (() => void) | null;
  workMode?: { run: () => void; busy: boolean } | null;
};
