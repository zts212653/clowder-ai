import type { ScheduleMutationProposal } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { apiFetch } from '@/utils/api-client';
import { ApprovalMember } from './ApprovalMember';
import { scheduleObject, scheduleTask } from './read-schedule-approval';
import { scheduleApprovalCopy } from './schedule-approval.shell-copy';

type Copy = typeof scheduleApprovalCopy.zh;
export function formatScheduleDuration(ms: number, t: Copy): string {
  for (const [unit, size] of [
    [t.days, 86400000],
    [t.hours, 3600000],
    [t.minutes, 60000],
    [t.seconds, 1000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size} ${unit}`;
  }
  return `${ms / 1000} ${t.seconds}`;
}
export function formatScheduleTime(p: ScheduleMutationProposal, language: 'zh' | 'en'): string {
  const t = scheduleApprovalCopy[language],
    trigger = scheduleTask(p).trigger;
  if (p.mutation.kind === 'create' && p.mutation.relativeOnceDelayMs !== undefined)
    return `${t.afterApproval} ${formatScheduleDuration(p.mutation.relativeOnceDelayMs, t)} ${t.later}`;
  if (trigger.type === 'interval') return `${t.every} ${formatScheduleDuration(trigger.ms, t)}`;
  if (trigger.type === 'once')
    return `${t.at} ${new Date(trigger.fireAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}`;
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(trigger.expression);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return t.customCron;
  const day = match[3] === '*' ? t.daily : `${t.weekday} ${t.weekdays[match[3] as keyof typeof t.weekdays]}`;
  return `${day} ${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')} · ${trigger.timezone ?? t.localTimezone}`;
}
function ScheduleThreadName({ id }: { id: string }) {
  const { currentThread } = useThreadDisplayInfo(id);
  const t = useShellCopy(scheduleApprovalCopy);
  return <>{currentThread?.title || t.unavailableThread}</>;
}

/** Template labels are display metadata, never pending membership or write permission. */
function useScheduleTemplate(templateId: string) {
  const [template, setTemplate] = useState<{ id: string; label: string; schema: Record<string, unknown> } | null>(null);
  useEffect(() => {
    let current = true;
    void apiFetch('/api/schedule/templates')
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : null;
        const matches =
          scheduleObject(body) && Array.isArray(body.templates)
            ? body.templates.filter((v) => scheduleObject(v) && v.templateId === templateId)
            : [];
        const found = matches.length === 1 ? matches[0] : null;
        if (
          current &&
          scheduleObject(found) &&
          typeof found.label === 'string' &&
          found.label &&
          scheduleObject(found.paramSchema)
        )
          setTemplate({ id: templateId, label: found.label, schema: found.paramSchema });
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [templateId]);
  return template?.id === templateId ? template : null;
}
function ScheduleValue({ name, value, owner }: { name: string; value: unknown; owner: string }) {
  const language = useShellLanguage();
  if (name === 'targetCatId' && typeof value === 'string') return <ApprovalMember catId={value} />;
  if (name === 'triggerUserId')
    return (
      <>
        {value === owner
          ? language === 'en'
            ? 'You'
            : '你'
          : language === 'en'
            ? 'Requester unavailable'
            : '发起人暂不可核对'}
      </>
    );
  if (name === 'threadId' && typeof value === 'string') return <ScheduleThreadName id={value} />;
  if (typeof value === 'string' || typeof value === 'number')
    return <p className="whitespace-pre-wrap break-words">{value}</p>;
  if (Array.isArray(value))
    return (
      <ul>
        {value.map((entry, i) => (
          <li key={i}>
            <ScheduleValue name={name} value={entry} owner={owner} />
          </li>
        ))}
      </ul>
    );
  if (scheduleObject(value))
    return (
      <dl>
        {Object.entries(value).map(([key, entry]) => (
          <div key={key}>
            <ScheduleValue name={key} value={entry} owner={owner} />
          </div>
        ))}
      </dl>
    );
  return <>{value === true ? '✓' : '—'}</>;
}
export function ScheduleApprovalContent({ proposal }: { proposal: ScheduleMutationProposal }) {
  const t = useShellCopy(scheduleApprovalCopy),
    language = useShellLanguage(),
    task = scheduleTask(proposal);
  const template = useScheduleTemplate(task.templateId);
  return (
    <>
      <p className="font-medium">
        {proposal.mutation.kind === 'create' ? t.create : t.delete}: {task.display.label}
      </p>
      {proposal.status === 'pending' ? (
        <p>{proposal.mutation.kind === 'create' ? t.createReason : t.deleteReason}</p>
      ) : null}
      <dl className="space-y-2">
        <div>
          <dt className="inline text-cafe-muted">{t.time}: </dt>
          <dd className="inline m-0">{formatScheduleTime(proposal, language)}</dd>
        </div>
        <div>
          <dt className="inline text-cafe-muted">{t.destination}: </dt>
          <dd className="inline m-0">
            {task.deliveryThreadId ? <ScheduleThreadName id={task.deliveryThreadId} /> : t.noDestination}
          </dd>
        </div>
        <div>
          <dt className="inline text-cafe-muted">{t.template}: </dt>
          <dd className="inline m-0">{template?.label ?? t.unavailableTemplate}</dd>
        </div>
        {proposal.mutation.kind === 'create' ? (
          <div>
            <dt className="inline text-cafe-muted">{t.state}: </dt>
            <dd className="inline m-0">{task.enabled ? t.enabled : t.paused}</dd>
          </div>
        ) : null}
      </dl>
      <details className="rounded-lg border border-[var(--shell-hairline)] px-3 py-2">
        <summary className="shell-focusable cursor-pointer font-medium">{t.details}</summary>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: bounded original task supports keyboard scrolling */}
        <section aria-label={t.details} className="mt-2 max-h-64 overflow-auto break-words space-y-3" tabIndex={0}>
          {task.display.description ? <p className="whitespace-pre-wrap">{task.display.description}</p> : null}
          {task.trigger.type === 'cron' ? (
            <p>
              {t.cron}: {task.trigger.expression} · {task.trigger.timezone ?? t.localTimezone}
            </p>
          ) : null}
          {Object.entries(task.params).map(([name, value], i) => {
            const field = template?.schema[name],
              label =
                scheduleObject(field) && typeof field.description === 'string'
                  ? field.description
                  : `${t.params} ${i + 1}`;
            return (
              <div key={name}>
                <p className="text-cafe-muted">{label}</p>
                <ScheduleValue name={name} value={value} owner={proposal.ownerUserId} />
              </div>
            );
          })}
        </section>
      </details>
    </>
  );
}
