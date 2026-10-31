// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { localDateTimeToInstant, projectLatestDeadline, workTimePresentation } from '../project-time.js';
import { WorkTimePanel } from '../WorkTimePanel.js';
import { work } from './collaboration-cards.fixture.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});
const actor = { kind: 'human' as const, humanId: 'human_aaaaaaaa', displayName: '吴浪' };
const fact = {
  value: '2026-10-30T15:59:59Z',
  timeZone: 'Asia/Shanghai',
  actor,
  at: '2026-10-26T08:00:00Z',
  sourceRef: 'event:evt_aaaaaaaa',
};
const task = {
  ...work,
  lifecycle: 'committed' as const,
  status: 'ready' as const,
  accountableHumanId: actor.humanId,
  time: { businessDeadline: fact, estimatedCompletion: { ...fact, value: '2026-11-04T16:00:00Z' } },
};

it('uses one relevant date, keeps overdue stable and derives project deadlines independently of targets', () => {
  expect(workTimePresentation(task, 'zh', Date.parse('2026-10-29T00:00:00Z'))).toMatchObject({
    field: 'businessDeadline',
    label: '截止',
  });
  expect(workTimePresentation(task, 'en', Date.parse('2026-11-02T15:59:59Z'))).toMatchObject({
    tone: 'overdue',
    label: '3 days overdue',
  });
  expect(projectLatestDeadline([task])?.value).toBe(fact.value);
  expect(
    workTimePresentation({ ...task, time: { estimatedCompletion: task.time.estimatedCompletion } }, 'zh'),
  ).toMatchObject({ field: 'estimatedCompletion' });
  expect(localDateTimeToInstant('2026-10-30T23:59', 'Asia/Shanghai')).toBe('2026-10-30T15:59:00.000Z');
  expect(localDateTimeToInstant('2026-11-04T17:00', 'America/Los_Angeles')).toBe('2026-11-05T01:00:00.000Z');
  expect(() => localDateTimeToInstant('2026-03-08T02:30', 'America/Los_Angeles')).toThrow();
});

it('requires an explicit occurrence for a repeated daylight-saving wall clock and preserves the chosen instant', () => {
  expect(() => localDateTimeToInstant('2026-11-01T01:30', 'America/Los_Angeles')).toThrow(/重复|twice/);
  expect(localDateTimeToInstant('2026-11-01T01:30', 'America/Los_Angeles', '2026-11-01T08:30:00.000Z')).toBe(
    '2026-11-01T08:30:00.000Z',
  );
  expect(localDateTimeToInstant('2026-11-01T01:30', 'America/Los_Angeles', '2026-11-01T09:30:00.000Z')).toBe(
    '2026-11-01T09:30:00.000Z',
  );
});

it('lets another member suggest a date without exposing owner confirmation controls', async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(<WorkTimePanel work={task} currentHumanId="human_bbbbbbbb" onChange={onChange} />),
  );
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '建议日期…');
  expect(button).toBeTruthy();
  expect(host.textContent).toContain('按 Asia/Shanghai');
  await act(async () => button!.click());
  expect(host.querySelector('form')).toBeTruthy();
  expect([...host.querySelectorAll('option')].map((item) => item.textContent)).not.toContain('实际开始');
  expect(host.textContent).toContain('建议不会改动当前日期');
  expect(onChange).not.toHaveBeenCalled();
});

it('shows the owner’s explicit accept or keep choices and preserves the suggestion source', async () => {
  const onChange = vi.fn().mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const suggestion = {
    suggestionId: 'time_suggestion',
    field: 'businessDeadline' as const,
    time: { value: '2026-11-06T16:00:00Z', timeZone: 'Asia/Shanghai' },
    reason: 'Waiting for a prerequisite',
    actor: { ...actor, humanId: 'human_bbbbbbbb', displayName: 'You' },
    at: fact.at,
    sourceRef: 'event:evt_aaaaaaaa',
    status: 'pending' as const,
  };
  await act(async () =>
    root!.render(
      <WorkTimePanel
        work={{ ...task, timeSuggestions: [suggestion] }}
        currentHumanId={actor.humanId}
        onChange={onChange}
      />,
    ),
  );
  expect(host.textContent).toContain(suggestion.reason);
  const accept = [...host.querySelectorAll('button')].find((item) => item.textContent?.startsWith('采用'));
  await act(async () => accept!.click());
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ workId: task.workId }), {
    action: 'respond',
    suggestionId: suggestion.suggestionId,
    decision: 'accept',
  });
});
