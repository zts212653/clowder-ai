import type { InvocationPromptInputProjection } from '@cat-cafe/shared';
import { HubIcon } from '../../hub-icons';
import { SemanticBadge, SemanticFrame } from './trajectory-semantic-cards';

function absentPromptLabel(status: 'deleted' | 'invisible' | 'missing'): string {
  if (status === 'deleted') return '原消息已删除';
  if (status === 'invisible') return '原消息不可见';
  return '原消息缺失';
}

export function PromptInputCard({
  promptInput,
  onOpenMessage,
}: {
  promptInput: InvocationPromptInputProjection | undefined;
  onOpenMessage: (messageId: string) => void;
}) {
  const semanticRole =
    promptInput?.status === 'available'
      ? (promptInput.messages.find((message) => message.status === 'available')?.author ?? 'user')
      : 'user';
  return (
    <SemanticFrame semanticRole={semanticRole}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-cafe">触发输入</span>
        <SemanticBadge semanticRole={semanticRole} />
      </div>
      {!promptInput || promptInput.status === 'unavailable' ? (
        <p className="mt-2 text-xs text-cafe-muted">canonical promptMessageIds 不可用</p>
      ) : (
        <div className="mt-2 space-y-2">
          {promptInput.messages.map((message) =>
            message.status === 'available' ? (
              <div key={message.messageId} className="rounded-lg bg-cafe-surface/60 p-2">
                <p className="whitespace-pre-wrap text-xs text-cafe-secondary">{message.excerpt}</p>
                <button
                  type="button"
                  data-message-id={message.messageId}
                  onClick={() => onOpenMessage(message.messageId)}
                  className="mt-1 inline-flex items-center gap-1 text-micro font-semibold text-conn-blue-text hover:underline"
                >
                  回到原消息
                  <span aria-hidden="true">
                    <HubIcon name="external-link" className="h-3 w-3" />
                  </span>
                </button>
              </div>
            ) : (
              <p key={message.messageId} className="text-xs text-cafe-muted">
                {absentPromptLabel(message.status)}
              </p>
            ),
          )}
        </div>
      )}
    </SemanticFrame>
  );
}
