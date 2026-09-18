'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { LongFormReaderDialog } from '../content-overflow/LongFormReaderDialog';
import { artifactEvidenceUrl, EVIDENCE_FILE_LABELS, type EvalEvidenceTarget } from './eval-evidence-targets';

type ReaderState =
  | { status: 'idle' }
  | { status: 'loading'; label: string }
  | { status: 'open'; title: string; content: string; format: 'markdown' | 'plaintext' }
  | { status: 'error'; label: string; message: string };

interface ArtifactFileResponse {
  contentType: 'text/markdown' | 'application/json';
  content: string;
  truncated: boolean;
}

function readableContent(file: ArtifactFileResponse): { content: string; format: 'markdown' | 'plaintext' } {
  if (file.contentType === 'text/markdown') return { content: file.content, format: 'markdown' };
  if (file.truncated) return { content: file.content, format: 'plaintext' };
  try {
    return { content: JSON.stringify(JSON.parse(file.content), null, 2), format: 'plaintext' };
  } catch {
    return { content: file.content, format: 'plaintext' };
  }
}

type ArtifactTarget = Extract<EvalEvidenceTarget, { kind: 'artifact' }>;

async function fetchArtifactEvidence(target: ArtifactTarget, label: string) {
  const response = await apiFetch(artifactEvidenceUrl(target));
  if (!response.ok) {
    throw new Error(response.status === 404 ? '这份证据不存在或不属于当前用户' : `HTTP ${response.status}`);
  }
  const file = (await response.json()) as ArtifactFileResponse;
  return {
    title: `${label} · ${target.verdictId}${file.truncated ? '（内容过长，已截断）' : ''}`,
    ...readableContent(file),
  };
}

/**
 * Opens Eval Hub evidence wherever it lives: workspace files go to the workspace
 * panel as before, and runtime artifact files are fetched from the owner-scoped
 * artifact route and shown read-only in place.
 */
export function useEvalEvidenceReader(openWorkspaceFile: (path: string) => void) {
  const [reader, setReader] = useState<ReaderState>({ status: 'idle' });
  const latestRequest = useRef(0);

  const open = useCallback(
    async (target: EvalEvidenceTarget) => {
      if (target.kind === 'workspace') {
        openWorkspaceFile(target.path);
        return;
      }
      const request = ++latestRequest.current;
      const label = EVIDENCE_FILE_LABELS[target.fileKey];
      setReader({ status: 'loading', label });
      // A later request, or closing the reader, supersedes this one.
      const settle = (next: ReaderState) => {
        if (request === latestRequest.current) setReader(next);
      };
      try {
        settle({ status: 'open', ...(await fetchArtifactEvidence(target, label)) });
      } catch (error) {
        settle({ status: 'error', label, message: error instanceof Error ? error.message : String(error) });
      }
    },
    [openWorkspaceFile],
  );

  const close = useCallback(() => {
    latestRequest.current += 1;
    setReader({ status: 'idle' });
  }, []);

  return { reader, open, close };
}

export function EvalEvidenceReaderView({
  reader,
  onClose,
}: {
  reader: ReturnType<typeof useEvalEvidenceReader>['reader'];
  onClose: () => void;
}) {
  const dialogId = useId();
  if (reader.status === 'loading') {
    return (
      <p className="mt-2 text-xs text-cafe-muted" aria-live="polite">
        正在读取{reader.label}…
      </p>
    );
  }
  if (reader.status === 'error') {
    return (
      <p role="alert" className="mt-2 text-xs text-conn-red-text">
        {reader.label}读取失败：{reader.message}
      </p>
    );
  }
  if (reader.status === 'open') {
    return (
      <LongFormReaderDialog
        id={dialogId}
        title={reader.title}
        content={reader.content}
        format={reader.format}
        onClose={onClose}
      />
    );
  }
  return null;
}
