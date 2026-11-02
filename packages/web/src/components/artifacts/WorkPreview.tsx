'use client';
import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import type { WorkCardDescription } from './useWorkCardDescription';
import { WorkAudioPreview } from './WorkAudioPreview';
import { WorkCoverIcon } from './WorkCoverIcon';
import { WorkPaperPreview } from './WorkPaperPreview';
import { WorkVideoPreview } from './WorkVideoPreview';
import { worksPanelCopy } from './works-panel.shell-copy';
import './work-cover.css';

type CoverKind = 'document' | 'layout' | 'slide' | 'code' | 'pr';
const office: Record<string, { label: string; letter: string }> = {
  pdf: { label: 'PDF', letter: 'PDF' },
  ppt: { label: 'PPT', letter: 'P' },
  pptx: { label: 'PPT', letter: 'P' },
  doc: { label: 'Word', letter: 'W' },
  docx: { label: 'Word', letter: 'W' },
  xls: { label: 'Excel', letter: 'X' },
  xlsx: { label: 'Excel', letter: 'X' },
};
function coverKind(type: ThreadArtifactDTO['type'], extension: string): CoverKind {
  if (type === 'pr' || type === 'code') return type;
  if (/^pptx?$/.test(extension)) return 'slide';
  if (type === 'widget' || /^html?$/.test(extension)) return 'layout';
  return 'document';
}
export function WorkPreview({
  artifact,
  description,
  pending,
  title,
  compact = false,
}: {
  artifact: ThreadArtifactDTO;
  description?: WorkCardDescription | null;
  pending?: boolean;
  title?: string;
  compact?: boolean;
}) {
  const t = useShellCopy(worksPanelCopy);
  const { kind: contentKind } = projectFileContent(artifact);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = artifact.url ? resolveAssetUrl(artifact.url, API_URL) : null;
  if (contentKind === 'image' && !compact && url && failedUrl !== url)
    // biome-ignore lint/performance/noImgElement: preserve the original authenticated publication URL.
    return <img src={url} alt={title ?? artifact.name} onError={() => setFailedUrl(url)} />;
  if (contentKind === 'image')
    return (
      <span className="work-gallery-kind">
        <ShellGlyph name="filePen" className="h-7 w-7" />
        <span>{failedUrl === url ? t.imageUnavailable : t.filters.image}</span>
      </span>
    );
  if (contentKind === 'video')
    return <WorkVideoPreview artifact={artifact} description={description} pending={pending} />;
  if (contentKind === 'audio') return <WorkAudioPreview artifact={artifact} />;
  return <TypedCover artifact={artifact} />;
}
function TypedCover({ artifact }: { artifact: ThreadArtifactDTO }) {
  const t = useShellCopy(worksPanelCopy);
  const extension = (artifact.ref ?? artifact.name).split('.').pop()?.toLowerCase() ?? '';
  const mark = office[extension];
  const kind = coverKind(artifact.type, extension);
  const labels: Record<CoverKind, string> = {
    pr: 'PR',
    code: t.coverCode,
    layout: t.filters.widget,
    slide: 'PPT',
    document: t.filters.file,
  };
  return (
    <span className={`work-cover work-cover-${kind}`}>
      <WorkPaperPreview artifact={artifact} kind={kind} />
      <span className="work-cover-badge">
        {mark ? (
          <b className={`work-cover-office work-cover-office-${mark.label.toLowerCase()}`}>{mark.letter}</b>
        ) : (
          <WorkCoverIcon kind={kind} />
        )}
        {mark?.label ?? labels[kind]}
      </span>
    </span>
  );
}
