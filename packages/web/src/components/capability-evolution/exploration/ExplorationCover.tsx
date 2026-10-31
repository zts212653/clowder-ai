import type { EvolutionExplorationNodeV1 } from '@cat-cafe/shared';
import { useState } from 'react';
import { explorationMediaUrl } from './ExplorationMedia';

export function ExplorationCover({ programId, node }: { programId: string; node: EvolutionExplorationNodeV1 }) {
  const [failed, setFailed] = useState(false);
  if (!node.preview) return null;
  if (failed) return <p className="exploration-caption">封面暂时无法读取，版本与记录仍保留。</p>;
  return (
    // biome-ignore lint/performance/noImgElement: the image is authenticated exact owner evidence, never an optimizer input.
    <img
      className="exploration-version-cover"
      src={explorationMediaUrl(programId, node.preview, node.preview.media)}
      alt={`${node.title} · ${node.preview.media.label}`}
      onError={() => setFailed(true)}
    />
  );
}
