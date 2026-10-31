'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, TranscriptLine } from './audio-transcript-contract';

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

export function FloatingTranscriptLines({
  lines,
  recording,
  participants,
  onCorrect,
}: {
  lines: TranscriptLine[];
  recording: boolean;
  participants?: Participant[];
  onCorrect?: (chunkNum: number, speakerId: string, speakerLabel: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const [correctingChunk, setCorrectingChunk] = useState<number | null>(null);

  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
  }, []);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
      {lines.length === 0 && (
        <p className="mt-8 text-center text-cafe-text-muted">
          {recording ? 'Waiting for first transcript chunk...' : 'No transcript data.'}
        </p>
      )}
      {lines.map((line, index) => (
        <div key={line.chunk_num ?? index} className="mb-1 flex gap-2">
          <span className="shrink-0 text-cafe-text-muted">[{formatTime(line.ts)}]</span>
          {line.speaker_label && (
            <span className="relative shrink-0">
              <button
                type="button"
                className="font-medium text-cafe-accent-primary hover:underline"
                onClick={() =>
                  participants?.length && onCorrect
                    ? setCorrectingChunk(correctingChunk === line.chunk_num ? null : line.chunk_num)
                    : undefined
                }
                title={participants?.length ? 'Click to correct speaker' : undefined}
              >
                {line.speaker_label}:
              </button>
              {correctingChunk === line.chunk_num && participants && onCorrect && (
                <div className="absolute left-0 top-full z-10 mt-1 rounded border border-cafe-border bg-cafe-surface-primary py-1 shadow-lg">
                  {participants.map((participant) => (
                    <button
                      key={participant.id}
                      type="button"
                      className="block w-full whitespace-nowrap px-3 py-1 text-left text-xs text-cafe-text-primary hover:bg-cafe-surface-secondary"
                      onClick={() => {
                        onCorrect(line.chunk_num, participant.id, participant.name);
                        setCorrectingChunk(null);
                      }}
                    >
                      {participant.name}
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          {line.input_label && (
            <span className="shrink-0 rounded bg-cafe-surface-secondary px-1 text-cafe-text-muted">
              {line.input_label}
            </span>
          )}
          <span className="text-cafe-text-primary">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
