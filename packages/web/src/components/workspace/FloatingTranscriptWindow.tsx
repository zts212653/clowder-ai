'use client';

import { useShellPresentation } from '@/components/shell/shell-presentation';
import { FloatingTranscriptWindowClassic, type FloatingTranscriptWindowProps } from './FloatingTranscriptWindowClassic';
import { FloatingTranscriptWindowV2 } from './FloatingTranscriptWindowV2';

export type { FloatingTranscriptWindowProps };

export function FloatingTranscriptWindow(props: FloatingTranscriptWindowProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? (
    <FloatingTranscriptWindowV2 {...props} />
  ) : (
    <FloatingTranscriptWindowClassic {...props} />
  );
}
