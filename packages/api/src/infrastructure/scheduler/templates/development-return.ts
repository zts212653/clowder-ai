import { DEVELOPMENT_RETURN_TEMPLATE_ID } from '@cat-cafe/shared';
import type { DevelopmentReturnService } from '../development-return/DevelopmentReturnService.js';
import type { TaskTemplate } from './types.js';

export function createDevelopmentReturnTemplate(service: DevelopmentReturnService): TaskTemplate {
  return {
    templateId: DEVELOPMENT_RETURN_TEMPLATE_ID,
    label: '开发结果回流',
    category: 'system',
    subjectKind: 'none',
    description: '由原 Task owner 注册的最终回报与有界复核连接',
    defaultTrigger: { type: 'once', fireAt: 0 },
    paramSchema: {},
    createSpec(id, params) {
      const state = service.read(id);
      if (!state) throw new Error('Development return requires its private owner registration');
      return {
        id,
        profile: 'awareness',
        trigger:
          state.status === 'ready' || state.status === 'delivering'
            ? { type: 'once', fireAt: service.now() }
            : params.trigger,
        onceLifecycle: {
          recoverMissed: true,
          retire: () => service.retireUndelivered(id),
          retryUntil: state.slaUntil + 5 * 60_000,
        },
        admission: {
          async gate() {
            const current = service.read(id);
            if (!current || current.status === 'delivered' || current.status === 'retired')
              return { run: false, reason: 'return retired' };
            if (current.status === 'waiting' && service.now() < current.slaUntil)
              return { run: false, reason: 'waiting for terminal report' };
            return { run: true, workItems: [{ signal: id, subjectKey: id, dedupeKey: id }] };
          },
        },
        run: {
          overlap: 'skip',
          timeoutMs: 30_000,
          execute: async (_signal, _subject, ctx) => service.execute(id, ctx),
        },
        state: { runLedger: 'sqlite' },
        outcome: { whenNoSignal: 'record' },
        enabled: () => service.deps.definitions.getById(id)?.enabled === true,
        display: { label: '等待开发结果回流', category: 'system', subjectKind: 'none' },
      };
    },
  };
}
