import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { explorationFixture, source } from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { ExplorationCaseList } from '../exploration/ExplorationCaseList';
import { ExplorationComparison } from '../exploration/ExplorationComparison';
import { ExplorationMedia } from '../exploration/ExplorationMedia';

const collaboration = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/components/workbench/evolution-media-navigation', () => ({ openEvolutionMedia: collaboration.open }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  collaboration.open.mockReset();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
function fixture() {
  const data = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
  if (data.status !== 'resolved' || data.details[0]?.status !== 'resolved') throw new Error('invalid test publication');
  return {
    programId: data.programRef.ownerStateRef,
    experiment: data.experiments[0]!,
    record: data.details[0].records[0]!,
  };
}
it('opens each comparison side using its own experiment, record and media rather than the globally selected run', async () => {
  const { programId, record } = fixture();
  const media = {
    mediaRef: source('left-image', 'a'.repeat(64)),
    kind: 'image' as const,
    contentType: 'image/png' as const,
    label: '左原件',
    provenance: 'original' as const,
    sourceRecordRef: record.evidenceRef,
  };
  const left = { ...record, experimentRef: source('older-run'), media: [media] };
  await act(async () =>
    root.render(<ExplorationMedia programId={programId} record={left} sideLabel="之前" onRetry={() => {}} />),
  );
  // F311 reading enlarges the image in place; it never opens collaboration by itself.
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="放大"]')!.click());
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toContain('左原件');
  expect(collaboration.open).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="打开并讨论"]')!.click());
  expect(collaboration.open).toHaveBeenLastCalledWith(
    { programId, experimentRef: left.experimentRef, recordRef: left.recordRef, mediaRef: media.mediaRef },
    expect.stringContaining('左原件'),
  );
  const right = {
    ...record,
    recordRef: source('new-record'),
    experimentRef: source('newer-run'),
    media: [{ ...media, kind: 'video' as const, contentType: 'video/webm' as const, label: '右回放' }],
  };
  await act(async () =>
    root.render(<ExplorationMedia key="right" programId={programId} record={right} onRetry={() => {}} />),
  );
  const opened = collaboration.open.mock.calls.length;
  // F311 reads the replay in place; only the explicit discussion action opens the shared landing.
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '在原地打开回放')!.click(),
  );
  expect(host.querySelector('video')?.getAttribute('aria-label')).toContain('右回放');
  expect(collaboration.open).toHaveBeenCalledTimes(opened);
  await act(async () =>
    [...host.querySelectorAll('button')].find((button) => button.textContent === '打开并讨论')!.click(),
  );
  expect(host.querySelector('video')).not.toBeNull();
  expect(collaboration.open).toHaveBeenLastCalledWith(
    { programId, experimentRef: right.experimentRef, recordRef: right.recordRef, mediaRef: media.mediaRef },
    expect.stringContaining('右回放'),
  );
});
it('withdrawal preserves the chosen media identity until the reader explicitly selects another original', async () => {
  const { programId, record } = fixture();
  record.media = ['a', 'b'].map((id) => ({
    mediaRef: source(`image-${id}`, id.repeat(64)),
    kind: 'image',
    contentType: 'image/png',
    label: `原件 ${id}`,
    provenance: 'original',
    sourceRecordRef: record.evidenceRef,
  }));
  const retry = vi.fn();
  await act(async () => root.render(<ExplorationMedia programId={programId} record={record} onRetry={retry} />));
  await act(async () => [...host.querySelectorAll('button')].find((entry) => entry.textContent === '原件 b')!.click());
  expect(host.querySelector('img')?.src).toContain('b'.repeat(64));
  const withdrawn = { ...record, media: [record.media[0]!] };
  await act(async () => root.render(<ExplorationMedia programId={programId} record={withdrawn} onRetry={retry} />));
  expect(host.textContent).toContain('所看的原件已不在');
  expect(host.querySelector('img')).toBeNull();
  await act(async () => [...host.querySelectorAll('button')].find((entry) => entry.textContent === '原件 a')!.click());
  expect(host.querySelector('img')?.src).toContain('a'.repeat(64));
});
it('a failed media index exposes recovery while its numerical record remains available', async () => {
  const { programId, record } = fixture();
  record.mediaStatus = { status: 'invalid', reason: '原件来源未通过完整性核验' };
  const retry = vi.fn();
  await act(async () => root.render(<ExplorationMedia programId={programId} record={record} onRetry={retry} />));
  expect(host.textContent).toContain('未通过完整性核验');
  expect(host.textContent).not.toContain('没有可用图片');
  await act(async () =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent === '重新核对原件')!.click(),
  );
  expect(retry).toHaveBeenCalledTimes(1);
});
it('keeps an earlier satisfied case visible when its new result is unknown, with both actual labels', async () => {
  const { programId, experiment, record } = fixture();
  const nextRun = { ...experiment, experimentRef: source('later-run') };
  const nextRecord = {
    ...record,
    experimentRef: nextRun.experimentRef,
    label: '新版观测未完整',
    result: { status: 'unknown' as const, label: '观察尚不完整' },
  };
  await act(async () =>
    root.render(
      <ExplorationComparison
        programId={programId}
        left={{ experiment, records: [record] }}
        right={{ experiment: nextRun, records: [nextRecord] }}
        scope="full"
        onScope={() => undefined}
        onSelectCase={() => undefined}
        onRetry={() => undefined}
      />,
    ),
  );
  const list = host.querySelector('[aria-label="原有达标尚待确认"]');
  expect(list).not.toBeNull();
  expect(list?.textContent).toContain(record.label);
  expect(list?.textContent).toContain(nextRecord.label);
});
it('exposes repeated evidence without treating two records as two independent samples', async () => {
  const { record } = fixture();
  await act(async () =>
    root.render(
      <ExplorationCaseList
        records={[record, { ...record, caseId: 'repeat', recordRef: source('repeat-row') }]}
        onSelect={() => undefined}
      />,
    ),
  );
  expect(host.textContent).toContain('重复');
  expect(host.textContent).toContain('独立');
});
