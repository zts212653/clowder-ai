'use client';

import { useShellPresentation } from '@/components/shell/shell-presentation';
import { ChatVoiceFeatureControlsClassic } from './ChatVoiceFeatureControlsClassic';
import { ChatVoiceFeatureControlsV2 } from './ChatVoiceFeatureControlsV2';

interface ChatVoiceFeatureControlsProps {
  threadId?: string;
  defaultCatId: string;
  disabled?: boolean;
}

export function ChatVoiceFeatureControls(props: ChatVoiceFeatureControlsProps) {
  const presentation = useShellPresentation();
  return presentation === 'v2' ? (
    <ChatVoiceFeatureControlsV2 {...props} />
  ) : (
    <ChatVoiceFeatureControlsClassic {...props} />
  );
}
