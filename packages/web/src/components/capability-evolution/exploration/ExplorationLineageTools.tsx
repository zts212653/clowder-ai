import type { ReactNode } from 'react';
import { ExplorationIcon } from './ExplorationIcon';

interface ExplorationLineageToolsProps {
  historical: boolean;
  minimumZoom: number;
  zoom: number;
  toolbarEnd?: ReactNode;
  fit(): void;
  locate(): void;
  changeZoom(delta: number): void;
}

export function ExplorationLineageTools(props: ExplorationLineageToolsProps) {
  const zoomTools = (
    <>
      <button
        type="button"
        aria-label="缩小谱系"
        disabled={props.zoom <= props.minimumZoom}
        onClick={() => props.changeZoom(-0.15)}
      >
        <ExplorationIcon kind="minus" />
      </button>
      <output aria-label="谱系缩放">{Math.round(props.zoom * 1000) / 10}%</output>
      <button type="button" aria-label="放大谱系" disabled={props.zoom >= 2.5} onClick={() => props.changeZoom(0.15)}>
        <ExplorationIcon kind="plus" />
      </button>
    </>
  );
  const locate = (
    <button type="button" onClick={props.locate} aria-label="定位阅读版">
      <ExplorationIcon kind="focus" />
      定位
    </button>
  );
  return (
    <div className="exploration-section-heading">
      <div className="exploration-canvas-tools" role="toolbar" aria-label="谱系导航">
        {props.historical ? (
          <>
            <button type="button" onClick={props.fit}>
              看全图
            </button>
            <details className="exploration-more-tools">
              <summary>更多</summary>
              <div className="exploration-more-tools-panel">
                {zoomTools}
                {locate}
                {props.toolbarEnd}
              </div>
            </details>
          </>
        ) : (
          <>
            {zoomTools}
            <button type="button" onClick={props.fit}>
              看全图
            </button>
            {locate}
            {props.toolbarEnd}
          </>
        )}
      </div>
    </div>
  );
}
