// Icons and spatial roles come from the accepted Collective prototype's navigation/message controls.
export function CollectiveIcon({
  kind,
}: {
  readonly kind: 'search' | 'home' | 'members' | 'reaction' | 'reply' | 'more' | 'send' | 'cat';
}) {
  const path = {
    search: 'm20 20-4.4-4.4m2-5.1a7.1 7.1 0 1 1-14.2 0 7.1 7.1 0 0 1 14.2 0Z',
    home: 'M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z',
    members:
      'M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20c.2-4.2 2.1-6.2 5.5-6.2S13.8 15.8 14 20H3Zm11.3 0c-.1-2-.6-3.6-1.5-4.8.8-.5 1.7-.8 2.7-.8 3 0 4.8 1.9 5 5.6h-6.2Z',
    reaction:
      'M7.5 13.5c1.4 1.4 2.9 2.1 4.5 2.1s3.1-.7 4.5-2.1M8.5 9h.01M15.5 9h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    reply: 'M9 8 4 12l5 4v-3h4.5c3 0 5.2 1.2 6.5 3.8-.4-5.1-2.8-7.8-7.1-7.8H9V8Z',
    more: 'M6 12h.01M12 12h.01M18 12h.01',
    send: 'M12 19V5m-6 6 6-6 6 6',
    cat: 'M5 9 4 3l6 3h4l6-3-1 6a8 8 0 1 1-14 0Zm3 4h.01M16 13h.01m-6 3 2 1 2-1M2 14l4 1m12 0 4-1',
  } as const;
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d={path[kind]} />
    </svg>
  );
}
