/**
 * F252 Phase C — Birdseye View (swimlane + causal edges + milestones)
 *
 * Multi-thread swimlane visualization. Consumes FeatureStoryRenderingDTO
 * produced by the story rendering BFF.
 *
 * Extracted from FeatureStoryView to stay under the 350-line file limit.
 */

'use client';

import type { CausalEdgeDTO, FeatureStoryRenderingDTO, SwimlaneDTO, TimelineMilestoneDTO } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { KIND_VISUALS, TONE_CLASSES } from '@/components/workspace/trajectory/trajectory-kind-styles';

// ============================================================================
// Layout constants
// ============================================================================

const LANE_HEIGHT = 80;
const LANE_GAP = 4;
const HEADER_WIDTH = 180;
const TIMELINE_PADDING = 60;
const MARKER_SIZE = 20;
const MIN_TIMELINE_WIDTH = 600;

// ============================================================================
// Birdseye View
// ============================================================================

export function BirdseyeView({ data, onPlayFeature }: { data: FeatureStoryRenderingDTO; onPlayFeature?: () => void }) {
  const { lanes, edges, milestones, timeRange, title } = data;

  const duration = timeRange.end - timeRange.start;
  const timelineWidth = Math.max(MIN_TIMELINE_WIDTH, Math.min(1400, duration / 60000)); // rough scaling

  // Map time → x position
  const timeToX = useCallback(
    (t: number) => {
      if (duration === 0) return TIMELINE_PADDING;
      return TIMELINE_PADDING + ((t - timeRange.start) / duration) * (timelineWidth - 2 * TIMELINE_PADDING);
    },
    [duration, timeRange.start, timelineWidth],
  );

  // Map lane index → y position (center of lane)
  const laneY = (index: number) => index * (LANE_HEIGHT + LANE_GAP) + LANE_HEIGHT / 2;
  const laneMap = new Map(lanes.map((l, i) => [l.threadId, i]));

  const totalHeight = lanes.length * (LANE_HEIGHT + LANE_GAP);

  return (
    <div style={styles.container}>
      {/* Header bar */}
      <div style={styles.header}>
        <span style={{ fontSize: 'var(--console-font-sm)', fontWeight: 600 }}>🎬 {title}</span>
        <span style={{ opacity: 0.5, fontSize: 'var(--console-font-xs)' }}>
          {lanes.length} threads · {milestones.length} milestones · {edges.length} causal edges
        </span>
        {onPlayFeature && (
          <button type="button" onClick={onPlayFeature} style={styles.playButton} data-testid="play-feature-button">
            ▶ Play Feature
          </button>
        )}
      </div>

      {/* Swimlane viewport */}
      <div style={styles.viewportOuter}>
        <div style={{ display: 'flex', minWidth: HEADER_WIDTH + timelineWidth }}>
          {/* Lane headers (fixed left) */}
          <div style={{ width: HEADER_WIDTH, flexShrink: 0 }}>
            {lanes.map((lane, i) => (
              <LaneHeader key={lane.threadId} lane={lane} index={i} />
            ))}
          </div>

          {/* Timeline area (scrollable) */}
          <div style={{ position: 'relative', flex: 1, minHeight: totalHeight }}>
            {/* Lane background stripes */}
            {lanes.map((lane, i) => (
              <div
                key={`bg-${lane.threadId}`}
                style={{
                  position: 'absolute',
                  top: i * (LANE_HEIGHT + LANE_GAP),
                  left: 0,
                  right: 0,
                  height: LANE_HEIGHT,
                  background: i % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
                  borderBottom: '1px solid rgba(255,255,255,0.05)',
                }}
              />
            ))}

            <CausalEdgeOverlay edges={edges} laneMap={laneMap} timeToX={timeToX} laneY={laneY} />

            <MilestoneLines milestones={milestones} timeToX={timeToX} />

            {/* Trajectory markers */}
            {lanes.map((lane, laneIdx) =>
              lane.markers.map((marker) => {
                const x = timeToX(marker.at);
                const y = laneY(laneIdx);
                const visual = KIND_VISUALS[marker.kind];

                return (
                  <div
                    key={marker.entryId}
                    title={marker.label}
                    style={{
                      position: 'absolute',
                      left: x - MARKER_SIZE / 2,
                      top: y - MARKER_SIZE / 2,
                      width: MARKER_SIZE,
                      height: MARKER_SIZE,
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 'var(--console-font-xs)',
                      cursor: 'default',
                      zIndex: 10,
                      background: 'var(--color-surface-elevated, #1a1a2e)',
                      border: '2px solid rgba(168, 85, 247, 0.4)',
                    }}
                    className={TONE_CLASSES[visual.tone].dot}
                  >
                    {visual.icon}
                  </div>
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Causal Edge SVG Overlay
// ============================================================================

function CausalEdgeOverlay({
  edges,
  laneMap,
  timeToX,
  laneY,
}: {
  edges: CausalEdgeDTO[];
  laneMap: Map<string, number>;
  timeToX: (t: number) => number;
  laneY: (index: number) => number;
}) {
  const totalHeight = laneMap.size * (LANE_HEIGHT + LANE_GAP);

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: totalHeight,
        pointerEvents: 'none',
      }}
    >
      {edges.map((edge) => {
        const fromIdx = laneMap.get(edge.from.threadId);
        const toIdx = laneMap.get(edge.to.threadId);
        if (fromIdx === undefined || toIdx === undefined) return null;

        const x1 = timeToX(edge.from.time);
        const y1 = laneY(fromIdx);
        const x2 = timeToX(edge.to.time);
        const y2 = laneY(toIdx);

        const strokeStyle = edge.confidence === 'high' ? 'none' : edge.confidence === 'medium' ? '6,4' : '2,4';

        const edgeColor =
          edge.kind === 'thread_split'
            ? 'rgba(168, 85, 247, 0.6)' // purple
            : 'rgba(16, 185, 129, 0.6)'; // emerald

        return (
          <g key={edge.id}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={edgeColor}
              strokeWidth={2}
              strokeDasharray={strokeStyle}
              markerEnd="url(#arrowhead)"
            />
            <text
              x={(x1 + x2) / 2}
              y={(y1 + y2) / 2 - 8}
              fill="rgba(255,255,255,0.5)"
              fontSize="var(--console-font-micro)"
              textAnchor="middle"
            >
              {edge.label}
            </text>
          </g>
        );
      })}
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="rgba(168, 85, 247, 0.6)" />
        </marker>
      </defs>
    </svg>
  );
}

// ============================================================================
// Milestone Lines
// ============================================================================

function MilestoneLines({
  milestones,
  timeToX,
}: {
  milestones: TimelineMilestoneDTO[];
  timeToX: (t: number) => number;
}) {
  return (
    <>
      {milestones.map((ms) => {
        const x = timeToX(ms.at);
        return (
          <div
            key={ms.entryId}
            style={{
              position: 'absolute',
              left: x,
              top: 0,
              bottom: 0,
              width: 1,
              background: 'rgba(99, 102, 241, 0.3)',
              pointerEvents: 'none',
            }}
          >
            <div
              style={{
                position: 'absolute',
                top: -20,
                left: -40,
                width: 80,
                textAlign: 'center',
                fontSize: 'var(--console-font-micro)',
                color: 'rgba(165, 180, 252, 0.8)',
                whiteSpace: 'nowrap',
              }}
            >
              {ms.label}
            </div>
          </div>
        );
      })}
    </>
  );
}

// ============================================================================
// Lane Header
// ============================================================================

function LaneHeader({ lane, index }: { lane: SwimlaneDTO; index: number }) {
  return (
    <div
      style={{
        height: LANE_HEIGHT,
        marginBottom: LANE_GAP,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 12px',
        borderRight: '1px solid rgba(255,255,255,0.1)',
        background: index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent',
      }}
    >
      <div
        style={{
          fontSize: 'var(--console-font-compact)',
          fontWeight: 500,
          color: 'var(--color-text-primary, #e0e0e0)',
        }}
      >
        {lane.threadName}
      </div>
      {lane.participants.length > 0 && (
        <div style={{ fontSize: 'var(--console-font-label)', opacity: 0.5, marginTop: 2 }}>
          {lane.participants.join(', ')}
        </div>
      )}
      <div style={{ fontSize: 'var(--console-font-micro)', opacity: 0.3, marginTop: 2 }}>
        {lane.markers.length} events
      </div>
    </div>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: 'var(--color-surface, #0d0d1a)',
    color: 'var(--color-text-primary, #e0e0e0)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    borderBottom: '1px solid var(--color-border, #333)',
    background: 'var(--color-surface-elevated, #1a1a2e)',
  },
  viewportOuter: {
    flex: 1,
    overflow: 'auto',
    padding: '24px 0',
  },
  playButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 14px',
    borderRadius: '6px',
    border: '1px solid rgba(168, 85, 247, 0.4)',
    background: 'rgba(168, 85, 247, 0.15)',
    color: 'var(--color-text-primary, #e0e0e0)',
    fontSize: 'var(--console-font-compact, 13px)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 200ms ease',
  },
};
