import { expect, it, vi } from 'vitest';
import type { ClientRequest } from '../client-request.js';
import { readMembershipLeaveReadiness } from '../leave-readiness.js';

const response = {
  serviceInstanceId: 'svc_leave',
  collectiveId: 'col_leave',
  role: 'member',
  membershipRevision: 2,
  governanceHandoffRequired: false,
  canLeave: false,
  responsibilities: {
    works: [
      {
        workId: 'work_leave',
        title: '处理未结任务',
        lifecycle: 'committed',
        status: 'blocked',
        source: { eventId: 'evt_leave', location: { channelId: '产品方向' } },
        projects: [
          {
            roadmapId: 'roadmap_leave',
            title: '交付共同体',
            source: { eventId: 'evt_project', location: { channelId: '产品方向' } },
          },
        ],
      },
    ],
    roadmaps: [],
    artifacts: { items: [], inaccessibleCount: 0 },
  },
} as const;

it('reads and validates the complete leave-readiness projection at the authenticated endpoint', async () => {
  const called = vi.fn();
  const request: ClientRequest = async <Result>(path: string) => {
    called(path);
    return response as unknown as Result;
  };

  await expect(readMembershipLeaveReadiness(request, 'col /leave')).resolves.toEqual(response);
  expect(called).toHaveBeenCalledWith('/api/memberships/self-leave/readiness?collectiveId=col%20%2Fleave');
});

it('fails closed when an older or partial service response omits required display coordinates', async () => {
  const partial = {
    ...response,
    responsibilities: {
      ...response.responsibilities,
      works: response.responsibilities.works.map(({ status: _status, ...work }) => work),
    },
  };
  const request: ClientRequest = async <Result>() => partial as unknown as Result;

  await expect(readMembershipLeaveReadiness(request, response.collectiveId)).rejects.toThrow();
});
