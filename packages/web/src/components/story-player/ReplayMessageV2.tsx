'use client';

import { CatNameplate } from '@/components/CatNameplate';
import { CollapsibleMarkdown } from '@/components/CollapsibleMarkdown';
import { CliOutputBlock } from '@/components/cli-output/CliOutputBlock';
import { ThinkingContent } from '@/components/ThinkingContent';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';
import { catPersonaStyle, toCliEvents, toCliStatus } from './ReplayMessageList';

export function ReplayMessageV2({
  message,
  mode,
  current,
}: {
  message: ReplayChatMessage;
  mode: 'cinematic' | 'faithful';
  current: boolean;
}) {
  const { getCatById } = useCatData();
  const cat = message.catId ? getCatById(message.catId) : undefined;
  const faithful = mode === 'faithful';
  if (message.type === 'system') {
    return <p className="replay-v2-system">{message.content || '系统记录'}</p>;
  }
  if (message.type === 'user') {
    return (
      <div className="replay-v2-user">
        <CollapsibleMarkdown content={message.content} />
      </div>
    );
  }
  if (message.thinking && !message.content && !message.cliStdout && !message.toolEvents?.length && !faithful) {
    return null;
  }
  return (
    <article
      className="replay-v2-message cat-persona-derived"
      data-current={current}
      style={catPersonaStyle(cat?.color?.primary)}
    >
      {message.catId ? (
        <CatNameplate catId={message.catId} name={cat ? formatCatName(cat) : message.catId} />
      ) : (
        <span className="replay-v2-muted">来源未知</span>
      )}
      <div className="replay-v2-message-body">
        {faithful && message.thinking && <ThinkingContent content={message.thinking} defaultExpanded={false} />}
        {message.content && <CollapsibleMarkdown content={message.content} />}
        {message.toolEvents?.length || message.cliStdout ? (
          <CliOutputBlock
            events={toCliEvents(message.toolEvents, message.cliStdout)}
            status={toCliStatus(message.toolEvents)}
            defaultExpanded={false}
          />
        ) : null}
      </div>
    </article>
  );
}
