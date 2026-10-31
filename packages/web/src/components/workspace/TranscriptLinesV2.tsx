'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { Participant, TranscriptLine } from './audio-transcript-contract';
import { voiceMeetingCopy } from './voice-meeting.shell-copy';

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * The v2 transcript body shared by the docked panel and the floating window (§1.14 语音 3/语音 5): each entry has a
 * header line — time, speaker, the input it came from, 更正说话人 on the right — with the text on the next line.
 * Speaker names and input labels are service data and render as-is; only the chrome words come from the dictionary.
 */
export function TranscriptLinesV2({
  lines,
  waiting,
  emptyText,
  waitingText,
  participants,
  onCorrect,
}: {
  lines: TranscriptLine[];
  /** True while capturing with nothing transcribed yet. */
  waiting: boolean;
  emptyText: string;
  waitingText: string;
  participants?: Participant[];
  onCorrect?: (chunkNum: number, speakerId: string, speakerLabel: string) => void;
}) {
  const t = useShellCopy(voiceMeetingCopy);
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

  const canCorrect = Boolean(participants?.length && onCorrect);

  return (
    <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 text-xs">
      {lines.length === 0 && (
        <p className="mt-8 text-center text-cafe-text-muted">{waiting ? waitingText : emptyText}</p>
      )}
      {lines.map((line, index) => (
        <div key={line.chunk_num ?? index} className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
          <span className="shrink-0 font-mono text-micro text-cafe-text-muted">{formatTime(line.ts)}</span>
          {line.speaker_label && (
            <span className="relative shrink-0">
              <button
                type="button"
                className={`font-medium text-cafe-accent-primary ${canCorrect ? 'hover:underline' : 'cursor-default'}`}
                onClick={() =>
                  canCorrect
                    ? setCorrectingChunk(correctingChunk === line.chunk_num ? null : line.chunk_num)
                    : undefined
                }
                title={canCorrect ? t.capture.correctSpeaker : undefined}
              >
                {line.speaker_label}
              </button>
              {correctingChunk === line.chunk_num && participants && onCorrect && (
                <div className="absolute left-0 top-full z-10 mt-1 min-w-28 rounded-lg border border-cafe-border bg-cafe-surface-primary py-1 shadow-lg">
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
            <span className="shrink-0 rounded bg-cafe-surface-secondary px-1.5 py-px text-micro text-cafe-text-muted">
              {line.input_label}
            </span>
          )}
          {canCorrect && line.speaker_label && (
            <button
              type="button"
              className="ml-auto shrink-0 text-micro text-cafe-text-muted hover:text-cafe-accent-primary"
              onClick={() => setCorrectingChunk(correctingChunk === line.chunk_num ? null : line.chunk_num)}
            >
              {t.capture.correctSpeaker}
            </button>
          )}
          <span className="min-w-0 basis-full text-cafe-text-primary">{line.text}</span>
        </div>
      ))}
    </div>
  );
}
