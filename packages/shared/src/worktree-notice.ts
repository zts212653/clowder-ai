/** Display facts for the existing Host worktree message; never cleanup authority or live status. */
import { z } from 'zod';

export const WORKTREE_NOTICE_KINDS = [
  'retention-expired',
  'retention-invalid',
  'retention-head-changed',
  'merged-unfinished',
  'merged-removed',
  'merged-removal-interrupted',
  'merged-retirement-blocked',
] as const;
export const worktreeNoticeSchema = z.object({
  version: z.literal(1),
  kind: z.enum(WORKTREE_NOTICE_KINDS),
  owner: z.string().min(1).max(2000),
  path: z.string().min(1).max(4096),
  sourceRef: z.string().max(2000),
  until: z.string().max(2000).optional(),
  archivePath: z.string().max(4096).optional(),
  restore: z.string().max(32000).optional(),
  reason: z.string().max(32000).optional(),
  ownerAction: z.enum(['queued', 'unavailable']).optional(),
});
export type WorktreeNotice = z.infer<typeof worktreeNoticeSchema>;
type NoticeCopy = { title: string; description: string; status: string };
type Kind = WorktreeNotice['kind'];

type NoticeDictionary = Record<Kind, NoticeCopy> & { interrupted: NoticeCopy };
export const WORKTREE_NOTICE_COPY: { zh: NoticeDictionary; en: NoticeDictionary } = {
  zh: {
    'retention-head-changed': {
      title: '保留登记需要更新',
      description: '工位代码已更新，原保留登记对应较早版本，需要负责人核实当前用途。',
      status: '需确认',
    },
    'retention-expired': {
      title: '工位保留期已结束',
      description: '保留期限已到，需要负责人完成收尾或说明仍在使用的具体用途。',
      status: '已到期',
    },
    'retention-invalid': {
      title: '工位保留登记不完整',
      description: '保留信息不完整，需要负责人核实当前用途并完成收尾。',
      status: '需确认',
    },
    'merged-unfinished': {
      title: '已合入工位需要核对收尾',
      description: '代码已合入，自动清理遇到阻碍，需要负责人核对原因并完成收尾。',
      status: '待核对',
    },
    'merged-removed': {
      title: '工位已回收',
      description: '源码分支和本地原件已保留，依赖和构建产物可重新生成。',
      status: '已回收',
    },
    'merged-removal-interrupted': {
      title: '工位回收结果已核对',
      description: '清理时记录中断，现已核验目录移除及恢复归档。这是补记的核对结果。',
      status: '已回收',
    },
    'merged-retirement-blocked': {
      title: '工位自动清理已暂停',
      description: '工位仍完整，需要原负责人排除阻碍并完成收尾。',
      status: '待处理',
    },
    interrupted: {
      title: '工位清理中断，需要核验恢复',
      description: '工位可能已被部分移除；请保留恢复归档，由原负责人核验并完成收尾。',
      status: '待恢复核验',
    },
  },
  en: {
    'retention-head-changed': {
      title: 'Retention needs updating',
      description:
        'The checkout was updated after its retention was recorded. Its owner needs to verify the current use.',
      status: 'Needs confirmation',
    },
    'retention-expired': {
      title: 'Worktree retention expired',
      description: 'The retention deadline passed. Its owner needs to finish the checkout or state its continuing use.',
      status: 'Expired',
    },
    'retention-invalid': {
      title: 'Retention details are incomplete',
      description: 'Retention details are incomplete. Its owner needs to verify current use and finish the checkout.',
      status: 'Needs confirmation',
    },
    'merged-unfinished': {
      title: 'Merged worktree needs a check',
      description:
        'The code was merged, but automatic cleanup encountered an obstacle. Its owner needs to check the reason and finish it.',
      status: 'Needs a check',
    },
    'merged-removed': {
      title: 'Worktree reclaimed',
      description:
        'The source branch and local originals were preserved. Dependencies and build output can be regenerated.',
      status: 'Reclaimed',
    },
    'merged-removal-interrupted': {
      title: 'Worktree cleanup verified',
      description:
        'The cleanup record was interrupted. Removal and the recovery archive have now been verified; this is a reconciliation result.',
      status: 'Reclaimed',
    },
    'merged-retirement-blocked': {
      title: 'Automatic cleanup paused',
      description: 'The checkout is intact. Its owner needs to resolve the obstacle and finish cleanup.',
      status: 'Needs action',
    },
    interrupted: {
      title: 'Cleanup interrupted; recovery needs checking',
      description:
        'The checkout may be partially removed. Keep the recovery archive; its owner needs to verify recovery and finish cleanup.',
      status: 'Needs recovery check',
    },
  },
};

export function worktreeNoticePresentation(notice: WorktreeNotice, copy: NoticeDictionary): NoticeCopy {
  return notice.kind === 'merged-retirement-blocked' && notice.archivePath ? copy.interrupted : copy[notice.kind];
}

export const worktreeNoticeName = (path: string): string =>
  path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? path;

/** A readable text fallback also preserves exact coordinates for the original owner/model. */
export function formatWorktreeNotice(notice: WorktreeNotice): string {
  const copy = worktreeNoticePresentation(notice, WORKTREE_NOTICE_COPY.zh);
  return [
    `**${copy.title}**`,
    copy.description,
    `工位：${worktreeNoticeName(notice.path)}`,
    `负责人：${notice.owner}`,
    ...(notice.ownerAction === 'queued' ? ['处理：已排入原负责人待办；排队不代表工位已收尾。'] : []),
    ...(notice.ownerAction === 'unavailable'
      ? ['处理：未排入负责人待办，负责人当前不接自动跟进；需要维护核对，未标记完成。']
      : []),
    ...(notice.until ? [`保留期限：${notice.until}`] : []),
    `工位路径：${notice.path}`,
    `来源：${notice.sourceRef}`,
    ...(notice.archivePath ? [`恢复归档：${notice.archivePath}`] : []),
    ...(notice.restore ? [`恢复命令：${notice.restore}`] : []),
    ...(notice.reason ? [`核对原因：${notice.reason}`] : []),
  ].join('\n\n');
}

function legacyFields(content: string): Record<string, unknown> | null {
  const fields: Record<string, unknown> = {};
  for (const line of content.split('\n').slice(1)) {
    const match = /^(owner|path|source|until|archive|reason)=(.*)$/.exec(line);
    if (match) {
      try {
        fields[match[1]] = JSON.parse(match[2]);
      } catch {
        return null;
      }
    } else if (line.startsWith('restore=')) fields.restore = line.slice('restore='.length);
  }
  return fields;
}

/** Read-only compatibility for old persisted debug-text notices. Unknown content remains untouched. */
export function readWorktreeNotice(metadata: unknown, content: string): WorktreeNotice | null {
  const current = worktreeNoticeSchema.safeParse(metadata);
  if (current.success) return current.data;
  const firstLine = content.split('\n', 1)[0];
  let kind = WORKTREE_NOTICE_KINDS.find((value) => firstLine === `工位需要原负责人核对收尾：${value}`);
  if (firstLine === '已合入工位已自动回收：released/removed') kind = 'merged-removed';
  if (firstLine.startsWith('自动回收已移除工位，完成回执曾被中断')) kind = 'merged-removal-interrupted';
  if (firstLine.startsWith('自动回收已暂停，需原负责人核对')) kind = 'merged-retirement-blocked';
  if (!kind) return null;
  const fields = legacyFields(content);
  if (!fields) return null;
  const parsed = worktreeNoticeSchema.safeParse({
    version: 1,
    kind,
    owner: fields.owner,
    path: fields.path,
    sourceRef: fields.source,
    until: fields.until ?? undefined,
    archivePath: fields.archive ?? undefined,
    restore: fields.restore,
    reason: fields.reason ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}
