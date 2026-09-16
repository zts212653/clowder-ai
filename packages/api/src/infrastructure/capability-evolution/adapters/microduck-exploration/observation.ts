import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import type { EvolutionExplorationRecordV1 } from '@cat-cafe/shared';
import {
  ArchiveIntegrityError,
  type ArchiveReader,
  archiveDigest,
  archiveRef,
  digestBytes,
  type FootballArchiveRun,
} from './archive-reader.js';
import {
  type FootballCapture,
  type FootballCase,
  type FootballEpisode,
  footballCaptureSchema,
} from './archive-schema.js';
import { projectFootballTrace } from './trace.js';

const unzip = promisify(gunzip);
export const MEASUREMENT_DEFINITION =
  'public-football-observation-v1: first kick_trigger; contacts through original horizon; fall/incomplete/pre-kick-contact/no-kick/intended-ankle/other-body/no-contact precedence. Motion is XY sample travel and continuously unwrapped yaw range from trigger to kick or horizon, including gait sway. No football utility or adoption verdict.';
export const measurementRef = archiveRef('public-measurement', archiveDigest(MEASUREMENT_DEFINITION));
export const comparisonPlanRef = archiveRef(
  'public-comparison-method',
  archiveDigest(
    'Descriptive matched-input comparison only; exact environment, measurement, ground truth and observation window. Unequal input sets require explicit declared intersection with excluded inputs disclosed. Rows and repeated captures are not independent validation.',
  ),
);
export const inputIdentity = (entry: FootballCase, run: FootballArchiveRun) =>
  archiveRef(
    'scenario',
    archiveDigest({
      ballXY: entry.ballXY,
      behavior: entry.behavior,
      approach: entry.approach ?? false,
      kickSeconds: entry.kickSeconds,
      triggerSeconds: run.index.plan.triggerSeconds,
      targetDirectionXY: run.index.plan.targetDirectionXY,
    }),
  );
export const windowIdentity = (run: FootballArchiveRun) =>
  archiveRef('observation-window', archiveDigest({ startSeconds: 0, endSeconds: run.index.plan.durationSeconds }));
export const recordIdentity = (run: FootballArchiveRun, episode: FootballEpisode) =>
  archiveRef(
    'public-record',
    archiveDigest({ run: run.experimentRef, caseId: episode.case.id, capture: episode.uncompressedSha256 }),
  );

export function caseLabel(id: string): string {
  const foot = id.includes('left') ? '左侧' : id.includes('right') ? '右侧' : '';
  const suffix = id.split('-').at(-1);
  const shape: Record<string, string> = {
    closer: '更近',
    farther: '更远',
    wider: '更宽',
    near: '近球',
    straight: '直行',
    far: '远球',
    manifest: '原定踢球时长',
    default: '延长踢球时长',
    offset: '前移球位',
  };
  return id.startsWith('stand-') ? `${foot} · 站立对照` : shape[suffix ?? ''] ? `${foot} · ${shape[suffix ?? '']}` : id;
}

function yaw([w, x, y, z]: FootballCapture['samples'][number]['robotQuaternionWxyz']): number {
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}
function motion(capture: FootballCapture, start: number, end: number) {
  const samples = capture.samples.filter((sample) => sample.seconds >= start && sample.seconds <= end);
  let travel = 0;
  let previousYaw: number | undefined;
  let continuousYaw = 0;
  let minYaw = 0;
  let maxYaw = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!sample) continue;
    const previous = samples[index - 1];
    if (previous)
      travel += Math.hypot(
        sample.robotPositionM[0] - previous.robotPositionM[0],
        sample.robotPositionM[1] - previous.robotPositionM[1],
      );
    const currentYaw = yaw(sample.robotQuaternionWxyz);
    if (previousYaw !== undefined) {
      let delta = currentYaw - previousYaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      continuousYaw += delta;
    }
    minYaw = Math.min(minYaw, continuousYaw);
    maxYaw = Math.max(maxYaw, continuousYaw);
    previousYaw = currentYaw;
  }
  return { trunk_travel: travel, yaw_span: ((maxYaw - minYaw) * 180) / Math.PI };
}

export function observeFootballCapture(capture: FootballCapture, run: FootballArchiveRun) {
  const horizon = run.index.plan.durationSeconds;
  const kick =
    capture.events.find((event) => event.kind === 'kick_trigger' && event.seconds <= horizon)?.seconds ?? null;
  const contacts = capture.contacts.filter((contact) => contact.seconds <= horizon);
  const before = contacts.filter((contact) => kick === null || contact.seconds < kick);
  const after = contacts.filter((contact) => kick !== null && contact.seconds >= kick);
  const foot =
    capture.case.behavior === 'kick_left'
      ? 'ankle_left'
      : capture.case.behavior === 'kick_right'
        ? 'ankle_right'
        : null;
  const intended = after.filter((contact) => contact.robotBody === foot);
  const observedUntil = capture.samples.at(-1)?.seconds ?? 0;
  const terminal = capture.metrics.terminalReason ?? capture.metrics.reason;
  let status: EvolutionExplorationRecordV1['result']['status'] = 'violated';
  let label: string;
  if (terminal === 'fall' && observedUntil <= horizon) label = '本次跌倒';
  else if (observedUntil < horizon) {
    label = '观察尚不完整';
    status = 'unknown';
  } else if (before.length) label = '走近碰球，存在踢球前或未踢球接触';
  else if (kick === null) label = '窗口内未踢出';
  else if (intended.length) {
    label = '踢后指定脚触球';
    status = 'satisfied';
  } else if (after.length) label = '踢后其它部位触球';
  else label = '已踢出，但没有触球';
  return {
    result: { status, label },
    values: {
      foot_contact: status === 'satisfied' ? 1 : status === 'unknown' ? null : 0,
      kick_time: kick,
      first_foot_contact: intended[0]?.seconds ?? null,
      before_contact_count: before.length,
      ...motion(capture, run.index.plan.triggerSeconds, kick ?? horizon),
    },
    output: [
      { label: '动作与接触', value: label },
      { label: '踢球触发', value: kick === null ? '本窗口没有 kick' : `${kick.toFixed(3)} s` },
      { label: '踢后指定脚接触', value: intended[0] ? `${intended[0].seconds.toFixed(3)} s` : '未观测到' },
      { label: '观察终点', value: `${Math.min(observedUntil, horizon)} s` },
    ],
  };
}

export async function readFootballRecord(
  reader: ArchiveReader,
  run: FootballArchiveRun,
  episode: FootballEpisode,
): Promise<EvolutionExplorationRecordV1> {
  const bytes = await reader.verified({
    path: `evidence/${run.id}/${episode.capture}`,
    sha256: episode.compressedSha256,
  });
  let expanded: Buffer;
  try {
    expanded = await unzip(bytes, { maxOutputLength: 32_000_000 });
  } catch (cause) {
    throw new ArchiveIntegrityError('capture compression is invalid', { cause });
  }
  if (digestBytes(expanded) !== episode.uncompressedSha256)
    throw new ArchiveIntegrityError('capture content revision drift');
  const capture = footballCaptureSchema.parse(JSON.parse(expanded.toString('utf8')));
  if (
    archiveDigest(capture.case) !== archiveDigest(episode.case) ||
    capture.samples.length !== episode.metrics.samples ||
    capture.samples.some((sample, index) => index > 0 && sample.seconds <= (capture.samples[index - 1]?.seconds ?? -1))
  )
    throw new ArchiveIntegrityError('capture case, samples or chronology mismatch');
  const observed = observeFootballCapture(capture, run);
  return {
    recordRef: recordIdentity(run, episode),
    experimentRef: run.experimentRef,
    nodeRef: run.nodeRef,
    caseId: episode.case.id,
    label: caseLabel(episode.case.id),
    inputRef: inputIdentity(episode.case, run),
    evidenceRef: archiveRef('capture', episode.uncompressedSha256),
    windowRef: windowIdentity(run),
    measurementRef,
    input: [
      { label: '初始球位 XY', value: `(${episode.case.ballXY.join(', ')}) m` },
      { label: '动作', value: episode.case.behavior ?? '站立对照' },
      { label: '踢球时长', value: `${episode.case.kickSeconds} s` },
      { label: '来源', value: '同次仿真状态与接触记录，公开开发数据' },
    ],
    ...observed,
    trace: projectFootballTrace(capture, episode.uncompressedSha256),
    media: [],
    sources: [
      { label: '完整运行归档', ref: archiveRef('run-index', run.indexRef.sha256) },
      { label: '原始状态与接触', ref: archiveRef('capture', episode.uncompressedSha256) },
      { label: '原件完整性清单', ref: archiveRef('archive-manifest', run.manifestRef.sha256) },
    ],
  };
}
