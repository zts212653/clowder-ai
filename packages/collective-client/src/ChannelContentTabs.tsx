export type ChannelContent = 'conversation' | 'roadmap';

export function ChannelContentTabs({
  content,
  hasRoadmap,
  onSelect,
}: {
  readonly content: ChannelContent;
  readonly hasRoadmap: boolean;
  readonly onSelect: (content: ChannelContent) => void;
}) {
  return (
    <nav className="scene-tabs" aria-label="频道内容">
      <button
        type="button"
        className={content === 'conversation' ? 'scene-tab-active' : undefined}
        aria-current={content === 'conversation' ? 'page' : undefined}
        onClick={() => onSelect('conversation')}
      >
        对话
      </button>
      {hasRoadmap && (
        <button
          type="button"
          className={content === 'roadmap' ? 'scene-tab-active' : undefined}
          aria-current={content === 'roadmap' ? 'page' : undefined}
          onClick={() => onSelect('roadmap')}
        >
          Roadmap
        </button>
      )}
    </nav>
  );
}
