// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveClientRequestError } from '../client-request.js';
import { LeaveCollectiveDialog } from '../LeaveCollectiveDialog.js';
import type {
  LeaveReadinessArtifact,
  LeaveReadinessProject,
  LeaveReadinessWork,
  MembershipLeaveReadiness,
} from '../leave-readiness.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const source = { eventId: 'evt_leave_source', location: { channelId: '产品方向' } };
const project: LeaveReadinessProject = {
  roadmapId: 'roadmap_leave_project',
  title: '插件市场上线',
  source,
};
const work: LeaveReadinessWork = {
  workId: 'work_leave_task',
  title: '补齐接入指南',
  lifecycle: 'committed',
  status: 'blocked',
  source,
  projects: [project],
};
const artifact: Extract<LeaveReadinessArtifact, { kind: 'artifact' }> = {
  kind: 'artifact',
  artifactId: 'artifact_leave_guide',
  title: '插件接入指南',
  mediaType: 'text/markdown',
  ownerRevision: 3,
  source,
  workId: work.workId,
};

function readiness(values: Partial<MembershipLeaveReadiness> = {}): MembershipLeaveReadiness {
  return {
    serviceInstanceId: 'svc_leave',
    collectiveId: 'col_leave',
    role: 'member',
    membershipRevision: 4,
    governanceHandoffRequired: false,
    canLeave: true,
    responsibilities: { works: [], roadmaps: [], artifacts: { items: [], inaccessibleCount: 0 } },
    ...values,
  };
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

function renderDialog(input: {
  collectiveName?: string;
  read: () => Promise<MembershipLeaveReadiness>;
  leave?: () => Promise<void>;
  onClose?: () => void;
  onOpenWork?: (value: LeaveReadinessWork) => void;
  onOpenProject?: (value: LeaveReadinessProject) => void;
  onOpenArtifact?: (value: Extract<LeaveReadinessArtifact, { kind: 'artifact' }>) => void;
  onOpenMembers?: () => void;
}) {
  root.render(
    <LeaveCollectiveDialog
      collectiveName={input.collectiveName ?? '真实共同体'}
      read={input.read}
      leave={input.leave ?? vi.fn(async () => undefined)}
      onClose={input.onClose ?? vi.fn()}
      onOpenWork={input.onOpenWork ?? vi.fn()}
      onOpenProject={input.onOpenProject ?? vi.fn()}
      onOpenArtifact={input.onOpenArtifact ?? vi.fn()}
      onOpenMembers={input.onOpenMembers ?? vi.fn()}
    />,
  );
}

it('loads once, shows every blocker without a leave action, and keeps exact return coordinates', async () => {
  let finish: (value: MembershipLeaveReadiness) => void = () => undefined;
  const read = vi.fn(
    () =>
      new Promise<MembershipLeaveReadiness>((resolve) => {
        finish = resolve;
      }),
  );
  const onOpenWork = vi.fn();
  const onOpenProject = vi.fn();
  const onOpenArtifact = vi.fn();
  const onOpenMembers = vi.fn();

  await act(async () => renderDialog({ read, onOpenWork, onOpenProject, onOpenArtifact, onOpenMembers }));
  expect(container.textContent).toContain('正在看还有哪些事没处理…');
  expect(container.textContent).toContain('离开真实共同体');
  expect([...container.querySelectorAll('button')].some((item) => item.textContent === '离开共同体')).toBe(false);

  await act(async () =>
    finish(
      readiness({
        role: 'steward',
        governanceHandoffRequired: true,
        canLeave: false,
        responsibilities: {
          works: [work],
          roadmaps: [project],
          artifacts: {
            items: [
              artifact,
              {
                kind: 'publication',
                publicationId: 'publication_pending',
                title: '正在生成的演示片',
                source,
              },
            ],
            inaccessibleCount: 2,
          },
        },
      }),
    ),
  );

  expect(container.textContent).toContain('你是这个共同体的管理员');
  expect(container.textContent).toContain('你负责的任务 1');
  expect(container.textContent).toContain('插件市场上线 · # 产品方向 · 等待前置任务');
  expect(container.textContent).toContain('你负责的项目 1');
  expect(container.textContent).toContain('插件接入指南 · 第 3 版');
  expect(container.textContent).toContain('《正在生成的演示片》正在发布');
  expect(container.textContent).toContain('还有 2 件你现在打不开');
  expect(container.textContent).not.toContain('离开共同体</button>');

  await act(async () => button('去处理 ›').click());
  await act(async () => button('去项目 ›').click());
  await act(async () => button('去作品 ›').click());
  await act(async () => button('查看管理员').click());
  expect(onOpenWork).toHaveBeenCalledWith(work);
  expect(onOpenProject).toHaveBeenCalledWith(project);
  expect(onOpenArtifact).toHaveBeenCalledWith(artifact);
  expect(onOpenMembers).toHaveBeenCalledOnce();
});

it('never treats a failed read as empty and can recover into the confirmation state', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(readiness());
  const leave = vi.fn(async () => undefined);
  const onClose = vi.fn();
  await act(async () => {
    renderDialog({ read, leave, onClose });
    await Promise.resolve();
  });

  expect(container.textContent).toContain('没能检查还有哪些事没处理');
  expect([...container.querySelectorAll('button')].some((item) => item.textContent === '离开共同体')).toBe(false);
  await act(async () => {
    button('重试').click();
    await Promise.resolve();
  });
  expect(container.textContent).toContain('离开以后，你的 Café 马上停止在这里读取和发送');
  await act(async () => button('离开共同体').click());
  expect(leave).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it('turns a transactional 409 into a fresh blocked list instead of exposing the raw error', async () => {
  const blocked = readiness({
    canLeave: false,
    responsibilities: { works: [work], roadmaps: [], artifacts: { items: [], inaccessibleCount: 0 } },
  });
  const read = vi.fn().mockResolvedValueOnce(readiness()).mockResolvedValueOnce(blocked);
  const leave = vi.fn(async () => {
    throw new CollectiveClientRequestError(409, 'MEMBERSHIP_RESPONSIBILITY_REQUIRED');
  });
  await act(async () => {
    renderDialog({ read, leave });
    await Promise.resolve();
  });

  await act(async () => button('离开共同体').click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('补齐接入指南');
  expect(container.textContent).not.toContain('MEMBERSHIP_RESPONSIBILITY_REQUIRED');
  expect([...container.querySelectorAll('button')].some((item) => item.textContent === '离开共同体')).toBe(false);
});

it('keeps an ordinary leave failure in the dialog with a retry action', async () => {
  const read = vi.fn(async () => readiness());
  const leave = vi.fn(async () => {
    throw new Error('transport internals');
  });
  await act(async () => {
    renderDialog({ read, leave });
    await Promise.resolve();
  });

  await act(async () => button('离开共同体').click());
  expect(container.textContent).toContain('没能离开');
  expect(container.textContent).toContain('暂时没能离开');
  expect(container.textContent).not.toContain('transport internals');
  expect(button('重试').disabled).toBe(false);
});

it('fails closed on a contradictory nonempty response and spaces an English collective name', async () => {
  await act(async () => {
    renderDialog({
      collectiveName: 'Participation',
      read: async () =>
        readiness({
          canLeave: true,
          responsibilities: { works: [work], roadmaps: [], artifacts: { items: [], inaccessibleCount: 0 } },
        }),
    });
    await Promise.resolve();
  });

  expect(container.textContent).toContain('离开 Participation');
  expect(container.textContent).toContain(work.title);
  expect([...container.querySelectorAll('button')].some((item) => item.textContent === '离开共同体')).toBe(false);
});
