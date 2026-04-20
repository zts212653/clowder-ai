interface ThreadPageProps {
  params: {
    threadId: string;
  };
}

/**
 * Thread page — ChatContainer is rendered by the (chat) layout.
 *
 * Keep a tiny route marker in the page tree so App Router treats thread-id
 * changes as a real navigation instead of a no-op against an identical tree.
 */
export default function ThreadPage({ params }: ThreadPageProps) {
  return <span hidden aria-hidden="true" data-thread-route={params.threadId} />;
}
