'use client';
import { useEffect, useRef, useState } from 'react';
import { createVideoProjectSurface } from '../video-project-surface';
import type { WorkspaceSurfaceDescriptor } from '../workbench-contract';
import { listProjects, type ProjectSnapshot, projectRequest } from './api';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';

/** The ordinary Workspace entry reads the F138 directory, including legitimately imported projects. */
export function VideoProjectList({ onOpen }: { onOpen: (surface: WorkspaceSurfaceDescriptor) => void }) {
  const t = useScreeningCopy();
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0),
    [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh re-reads the owner directory after a formal import or retry.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listProjects(controller.signal)
      .then(
        (items) => {
          if (!controller.signal.aborted) setProjects(items);
        },
        (failure: unknown) => {
          if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '目录暂时不可读');
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  const importFile = async (source: File) => {
    setImporting(true);
    setError(null);
    try {
      if (source.size > 16 * 1024 * 1024) throw new Error('项目文件超过 16 MB。');
      await projectRequest('/api/video-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: crypto.randomUUID(), document: JSON.parse(await source.text()) }),
      });
      setRefresh((value) => value + 1);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '项目导入失败，请重试。');
    } finally {
      setImporting(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <section
      className="home-card mx-auto my-3 w-full max-w-4xl rounded-xl border border-cafe-subtle bg-cafe-surface p-4"
      aria-label={t.films}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-cafe-primary">{t.films}</h2>
        <button
          type="button"
          disabled={importing}
          className="text-xs text-cafe-accent"
          onClick={() => file.current?.click()}
        >
          {importing ? t.importing : t.import}
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label={t.projectFile}
          onChange={(event) => {
            const source = event.target.files?.[0];
            if (source) void importFile(source);
          }}
        />
      </div>
      {loading ? (
        <output className="mt-3 text-xs text-cafe-muted">{t.readingFilms}</output>
      ) : error ? (
        <div role="alert" className="mt-3 text-xs text-cafe-secondary">
          {error}{' '}
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            {t.retry}
          </button>
        </div>
      ) : projects.length ? (
        <ul className="mt-3 space-y-1">
          {projects.map((project) => (
            <li key={project.contentRef}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left hover:bg-cafe-surface-sunken"
                onClick={() =>
                  onOpen(
                    createVideoProjectSurface({
                      contentRef: project.contentRef,
                      title: project.document.title,
                      screeningId: project.document.screenings?.at(-1)?.id,
                    }),
                  )
                }
              >
                <span className="text-sm font-medium text-cafe-primary">{project.document.title}</span>
                <span className="text-xs text-cafe-muted">
                  {t.shotsCount(project.document.timeline.segments.length)} ·{' '}
                  {project.document.screenings?.length ? `${t.review} →` : t.needsFilm}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-cafe-muted">{t.noProjects}</p>
      )}
    </section>
  );
}
