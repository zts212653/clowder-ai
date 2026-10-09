'use client';

import { useCallback, useId, useState } from 'react';
import { CloudConversationLinkView, type FocusRequest } from './CloudConversationLinkView';
import { useAuthorizedConversations } from './useAuthorizedConversations';
import { useCopyChatLink } from './useCopyChatLink';
import { useThreadCloudRoute } from './useThreadCloudRoute';

/**
 * The thread's ChatGPT conversation in the thread panel, changed in place (F202 h3c-1): connect one of
 * the conversations the extension may use, change to another, or disconnect.
 */
export function CloudConversationLink({ threadId }: { threadId: string }) {
  // Every thread starts afresh: nothing a request for the previous thread brings back can reach it.
  return <ThreadCloudConversation key={threadId} threadId={threadId} />;
}

function ThreadCloudConversation({ threadId }: { threadId: string }) {
  const radioName = `cloud-thread-route-${useId()}`;
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const requestFocus = useCallback(
    (target: FocusRequest['target']) => setFocusRequest((current) => ({ target, nonce: (current?.nonce ?? 0) + 1 })),
    [],
  );
  const authorized = useAuthorizedConversations();
  const route = useThreadCloudRoute(threadId, (action) => {
    setChoosing(false);
    setSelected(null);
    // A new conversation folds the card back to it; after disconnecting, choosing is what is left.
    requestFocus(action === 'disconnect' ? 'chooser' : 'change');
  });
  const { read } = route;
  const binding = read.kind === 'ready' && read.binding !== 'invalid' ? read.binding : null;
  const copy = useCopyChatLink(binding?.chatUrl ?? null);

  if (read.kind === 'no-cloud-cat') return null;
  const candidates = authorized.read.kind === 'ready' ? authorized.read.candidates : [];
  return (
    <CloudConversationLinkView
      catLabel={read.kind === 'ready' ? `@${read.catId}` : ''}
      radioName={radioName}
      route={read.kind === 'ready' ? { kind: 'ready', binding: read.binding } : read}
      authorized={authorized.read}
      choosing={choosing}
      selectedConversationId={selected}
      busy={route.busy}
      operation={route.operation}
      copyState={copy.state}
      focusRequest={focusRequest}
      onCopy={copy.copy}
      onToggleChoosing={() => {
        route.dismissOutcome();
        setSelected(null);
        setChoosing(!choosing);
        requestFocus(choosing ? 'change' : 'chooser');
      }}
      onSelect={(conversationId) => {
        route.dismissOutcome();
        setSelected(conversationId);
      }}
      onConfirm={() => {
        const target = candidates.find((candidate) => candidate.conversationId === selected);
        if (target) route.write(binding ? 'change' : 'connect', target);
      }}
      onDisconnect={() => route.write('disconnect', null)}
      onReread={route.reread}
      onRetryList={authorized.reread}
    />
  );
}
