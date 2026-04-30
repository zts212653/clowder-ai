interface ClassicThreadPageProps {
  params: {
    threadId: string;
  };
}

/** Classic thread page — ChatContainer is rendered by the classic layout. */
export default function ClassicThreadPage({ params }: ClassicThreadPageProps) {
  return <span hidden aria-hidden="true" data-thread-route={params.threadId} />;
}
