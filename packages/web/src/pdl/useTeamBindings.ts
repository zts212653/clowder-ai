'use client';
import type {
  RoutingPreferenceRetireCommandV1,
  RoutingSignalCloseCommandV1,
  RoutingSignalMarkCommandV1,
  RoutingSubjectRefV1,
} from '@cat-cafe/shared';
import { useMemo, useRef } from 'react';
import {
  closeRoutingSignal,
  markRoutingSignal,
  retireRoutingPreference,
} from '@/components/routing-context/routing-context-client';
import {
  buildSignalMarkCommand,
  newRoutingCommandId,
  preferenceHeads,
} from '@/components/routing-context/routing-context-commands';
import { useRoutingContext } from '@/components/routing-context/useRoutingContext';
export function useTeamBindings(needed: boolean | number = false) {
  const query = useRoutingContext(needed);
  const commands = useRef(
    new Map<string, RoutingSignalMarkCommandV1 | RoutingSignalCloseCommandV1 | RoutingPreferenceRetireCommandV1>(),
  );
  const subject = (key: string): RoutingSubjectRefV1 =>
    key.startsWith('provider:') ? { type: 'provider', providerId: key.slice(9) } : { type: 'cat', catId: key.slice(4) };
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'teamBrowse') {
      return true;
    }
    if (name === 'refresh' && ['team', 'ledger'].includes(args.k)) {
      if (!(await query.refresh())) throw new Error('团队读取失败');
      return true;
    }
    if (!['routingSignalMark', 'routingSignalClose', 'routingPreferenceRetire'].includes(name)) return false;
    if (!query.data) throw new Error('团队 owner 尚未读取');
    const key = JSON.stringify([name, args]);
    let command = commands.current.get(key);
    if (!command) {
      const commandId = newRoutingCommandId(name);
      if (name === 'routingSignalMark')
        command = buildSignalMarkCommand({
          commandId,
          subjectRef: subject(args.subject),
          state: args.state as RoutingSignalMarkCommandV1['state'],
          reasonCode: args.reason,
          note: args.note,
          observedAt: Date.now(),
          durationMs: Number(args.duration),
        });
      if (name === 'routingSignalClose') {
        const event = query.data.signalEvents.find((e) => e.eventId === args.id);
        if (!event || event.eventType !== 'asserted') throw new Error('路由信号已变化');
        command = {
          v: 1,
          commandId,
          reasonCode: args.op === 'recover' ? 'owner-confirmed-recovery' : 'owner-retracted-assertion',
        };
      }
      if (name === 'routingPreferenceRetire') {
        const head = preferenceHeads(query.data.preferenceRevisions).find((p) => p.preferenceId === args.id);
        if (!head || head.lifecycle !== 'active') throw new Error('路由偏好版本已变化');
        command = {
          v: 1,
          commandId,
          baseRevisionId: head.revisionId,
          baseVersion: head.version,
          retirementReason: args.reason,
        };
      }
      commands.current.set(key, command!);
    }
    if (name === 'routingSignalMark') await markRoutingSignal(command as RoutingSignalMarkCommandV1);
    if (name === 'routingSignalClose')
      await closeRoutingSignal(args.id, args.op as 'recover' | 'retract', command as RoutingSignalCloseCommandV1);
    if (name === 'routingPreferenceRetire')
      await retireRoutingPreference(args.id, command as RoutingPreferenceRetireCommandV1);
    if (!(await query.refresh())) throw new Error('写入已回执，团队状态尚未回读，请重试读取');
    commands.current.delete(key);
    return true;
  };
  const rawData = useMemo(
    () => ({ value: query.data, loading: query.loading, error: query.error }),
    [query.data, query.loading, query.error],
  );
  return { action, data: rawData };
}
