'use client';
import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { classifyArtifactView } from './artifact-view';
import { useNearWorkViewport } from './useNearWorkViewport';

const widths = ['88%', '70%', '80%', '58%', '76%', '52%'];
function Bars({ code = false, count = 6 }: { code?: boolean; count?: number }) {
  return (
    <>
      {widths.slice(0, count).map((width, index) => (
        <span
          key={width}
          className="work-cover-bar"
          style={{ width, ...(code ? { marginLeft: (index % 3) * 8 } : {}) }}
        />
      ))}
    </>
  );
}
function PaperContent({ artifact }: { artifact: ThreadArtifactDTO }) {
  const { ref, near } = useNearWorkViewport<HTMLSpanElement>();
  const kind = projectFileContent(artifact).kind;
  const text =
    kind === 'markdown' || kind === 'text' || (artifact.type === 'code' && classifyArtifactView(artifact) === 'text');
  const body = useArtifactContent(artifact, null, near && text && !!artifact.url);
  const lines = body.content?.trim().split('\n');
  const plain = (line: string) => (artifact.type === 'code' ? line : line.replace(/^#+\s*/, ''));
  const pr = artifact.type === 'pr' ? /^([^/]+\/[^#]+)#(\d+)$/.exec(artifact.ref?.trim() ?? '') : null;
  return (
    <span ref={ref} className="work-cover-paper-text">
      {pr ? (
        <>
          <strong className="work-cover-pr-number">#{pr[2]}</strong>
          <span className="work-cover-pr-repo">{pr[1]}</span>
          <Bars count={3} />
        </>
      ) : lines?.length ? (
        <>
          <strong>{plain(lines[0] ?? '')}</strong>
          <span className="work-cover-excerpt">{lines.slice(1, 9).map(plain).join('\n')}</span>
        </>
      ) : (
        <>
          <span className="work-cover-bar work-cover-heading" />
          <Bars code={artifact.type === 'code'} />
        </>
      )}
    </span>
  );
}

export function WorkPaperPreview({ artifact, kind }: { artifact: ThreadArtifactDTO; kind: string }) {
  const layout = kind === 'layout' || kind === 'slide';
  return (
    <>
      {kind === 'document' && <span className="work-cover-paper work-cover-paper-back" aria-hidden="true" />}
      <span className={`work-cover-paper ${kind === 'slide' ? 'work-cover-slide-paper' : ''}`}>
        {layout ? (
          <>
            <span className="work-cover-bar work-cover-heading" />
            <span className="work-cover-panels">
              <i />
              <i />
              {kind === 'layout' && <i />}
            </span>
            {kind === 'layout' && <Bars count={3} />}
          </>
        ) : (
          <PaperContent artifact={artifact} />
        )}
      </span>
    </>
  );
}
