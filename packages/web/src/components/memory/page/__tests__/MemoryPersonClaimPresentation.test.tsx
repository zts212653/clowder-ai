import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryPersonClaim } from '../MemoryPersonClaim';
import type { PersonOwnerCommand } from '../people-types';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const payload = {
  kind: 'reported_fact' as const,
  predicate: 'birth_date',
  value: { year: 1999, month: 5 },
  assertedBy: 'owner' as const,
};
const claim = {
  claimId: 'person_claim_display',
  revision: 'claim-revision',
  payload,
  status: 'current',
  recordedAt: 100,
  sourceCount: 1,
};
let host: HTMLDivElement;
let root: Root;
const submit = vi.fn<(input: PersonOwnerCommand) => void>();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'ready',
      sources: [{ kind: 'owner_action', canOpen: false, label: '你在记忆页修改', occurredAt: 100 }],
    }),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function render(value: Parameters<typeof MemoryPersonClaim>[0]['claim']) {
  await act(async () =>
    root.render(
      <MemoryPersonClaim key={value.revision} personId="person_display" claim={value} busy={false} submit={submit} />,
    ),
  );
}
const heading = () => host.querySelector('article > p')?.textContent;

it('shows the approved sentence and keeps original storage in closed technical details', async () => {
  await render({ ...claim, approvedText: '1999 年 5 月出生' });
  expect(heading()).toBe('1999 年 5 月出生');
  const details = host.querySelector('details');
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('技术详情');
  await act(async () => details?.querySelector('summary')?.click());
  expect(details?.open).toBe(true);
  expect(details?.querySelector('pre')?.textContent).toBe(JSON.stringify(payload, null, 2));
});

it('places technical details after judgment metadata and source, before owner actions', async () => {
  await render({ ...claim, approvedText: '1999 年 5 月出生' });
  const text = host.querySelector('article')?.textContent ?? '';
  const positions = ['1999 年 5 月出生', '你说的事实', '你在记忆页修改', '技术详情', '编辑'].map((label) =>
    text.indexOf(label),
  );
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

it('turns old structured content into ordered values and omits English predicate keys', async () => {
  await render({ ...claim, payload: { ...payload, predicate: 'travel_base', value: { city: '成都', since: 2020 } } });
  expect(heading()).toBe('成都，2020');
  await render({ ...claim, payload: { ...payload, predicate: 'department_scope', value: '增长组' } });
  expect(heading()).toBe('增长组');
  await render({ ...claim, payload: { ...payload, predicate: '老家', value: '成都' } });
  expect(heading()).toBe('老家：成都');
});

it('preserves the assessment sentence and never revives redacted approval text', async () => {
  await render({
    ...claim,
    payload: { kind: 'user_assessment', statement: '愿意听取意见', stance: 'endorsed', assertedBy: 'owner' },
  });
  expect(heading()).toBe('愿意听取意见');
  await render({ ...claim, status: 'redacted', payload: { kind: 'redacted' }, approvedText: '不应重新出现的原句' });
  expect(heading()).toBe('这条内容已遗忘');
  expect(host.querySelector('details')).toBeNull();
  expect(host.textContent).not.toContain('不应重新出现的原句');
});

it('keeps the editor populated with the original predicate and raw structured value', async () => {
  await render({ ...claim, approvedText: '1999 年 5 月出生' });
  const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === '编辑');
  expect(edit?.disabled).toBe(false);
  await act(async () => edit?.click());
  expect(host.querySelector<HTMLInputElement>('input[aria-label="事实名称"]')?.value).toBe('birth_date');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="判断内容"]')?.value).toBe(
    JSON.stringify(payload.value),
  );
  expect(submit).not.toHaveBeenCalled();
});

async function editFactAndReadBack(edited: string, expectedHeading: string) {
  await render({ ...claim, approvedText: '1999 年 5 月出生' });
  const edit = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '编辑');
  await act(async () => edit()?.click());
  const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="判断内容"]');
  expect(editor?.value).toBe(JSON.stringify(payload.value));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, edited);
    editor?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(submit).toHaveBeenCalledTimes(1);
  const command = submit.mock.calls[0][0];
  expect(command.action).toBe('correct_claim');
  if (command.action !== 'correct_claim') throw new Error('Expected the existing owner correction action');
  if (command.payload.kind !== 'reported_fact') throw new Error('Expected a correction to the reported fact');
  expect(command.payload.value).toBe(edited);
  expect(typeof command.payload.value).toBe('string');

  // The native owner correction stores this payload unchanged, and the parent keys by revision.
  await render({ ...claim, revision: 'owner-corrected', payload: command.payload });
  expect(heading()).toBe(expectedHeading);
  expect(host.querySelector('details')?.open).toBe(false);
  expect(host.querySelector('pre')?.textContent).toBe(JSON.stringify(command.payload, null, 2));
  await act(async () => edit()?.click());
  expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="判断内容"]')?.value).toBe(edited);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="事实名称"]')?.value).toBe('birth_date');
}

it('keeps a structured fact readable after editing, saving and reading the owner correction', async () => {
  await editFactAndReadBack('{"year":2000,"month":5}', 'birth date：year 2000，month 5');
});

it.each(['[]', '{}'])('keeps an empty collection readable after editing and saving %s', async (edited) => {
  await editFactAndReadBack(edited, '内容为空');
});

it('keeps the predicate context and original editor text after saving a date string', async () => {
  await editFactAndReadBack('1988-02-03', 'birth date：1988-02-03');
});

it('renders serialized structured arrays while preserving ordinary or incomplete text', async () => {
  await render({ ...claim, payload: { ...payload, value: '["成都",{"since":2020}]' } });
  expect(heading()).toBe('成都，2020');
  await render({ ...claim, payload: { ...payload, value: '[待确认] 成都' } });
  expect(heading()).toBe('[待确认] 成都');
  await render({ ...claim, payload: { ...payload, value: '他说过“成都”' } });
  expect(heading()).toBe('他说过“成都”');
});
