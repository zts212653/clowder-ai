import { describe, expect, it } from 'vitest';
import { canonicalLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { WORKSPACE_MODES } from '@/lib/workspace-modes';
import { formatElapsed, formatObservedAge, formatWaitDuration, homeActivityLabel, shortRevision } from '../format';
import { destinationTestId, HOME_ROWS, HOME_TRANSITIONAL_DESTINATIONS, rowMatchesQuery } from '../home-rows';
import { homeCopy } from '../workspace-home.shell-copy';

describe('Workspace home formatting', () => {
  it('writes elapsed time as the design does: 0:50, 12:07, 1:02:03', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(50_000)).toBe('0:50');
    expect(formatElapsed(12 * 60_000 + 7_000)).toBe('12:07');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-5_000)).toBe('0:00');
  });

  it('writes waits and observation ages in whole units', () => {
    const { time } = homeCopy.zh;
    expect(formatWaitDuration(0, time)).toBe('1 分钟');
    expect(formatWaitDuration(34 * 60_000, time)).toBe('34 分钟');
    expect(formatWaitDuration(5 * 3_600_000, time)).toBe('5 小时');
    expect(formatWaitDuration(30 * 3_600_000, time)).toBe('1 天');
    expect(formatObservedAge(1_000, 1_000, time)).toBe('刚刚');
    expect(formatObservedAge(0, 4 * 60_000, time)).toBe('4 分钟前');
    expect(formatObservedAge(0, 2 * 3_600_000, time)).toBe('2 小时前');
    expect(formatObservedAge(0, 25 * 3_600_000, time)).toBe('1 天前');
    expect(shortRevision('630c66bc19d2aa')).toBe('630c66bc');
  });

  it('says the same in English, whole words, singular and plural counted', () => {
    const { time } = homeCopy.en;
    expect(formatWaitDuration(0, time)).toBe('1 minute');
    expect(formatWaitDuration(34 * 60_000, time)).toBe('34 minutes');
    expect(formatWaitDuration(60 * 60_000, time)).toBe('1 hour');
    expect(formatWaitDuration(5 * 3_600_000, time)).toBe('5 hours');
    expect(formatWaitDuration(24 * 3_600_000, time)).toBe('1 day');
    expect(formatWaitDuration(72 * 3_600_000, time)).toBe('3 days');
    expect(formatObservedAge(1_000, 1_000, time)).toBe('just now');
    expect(formatObservedAge(0, 60_000, time)).toBe('1 minute ago');
    expect(formatObservedAge(0, 4 * 60_000, time)).toBe('4 minutes ago');
    expect(formatObservedAge(0, 3_600_000, time)).toBe('1 hour ago');
    expect(formatObservedAge(0, 25 * 3_600_000, time)).toBe('1 day ago');
    expect(formatObservedAge(0, 50 * 3_600_000, time)).toBe('2 days ago');
  });

  it('names background work with the unified words, never the internal 门禁 / gate', () => {
    expect(homeActivityLabel('full_gate', homeCopy.zh.activity)).toBe('完整检查');
    expect(homeActivityLabel(undefined, homeCopy.zh.activity)).toBe('命令');
    expect(homeActivityLabel('full_gate', homeCopy.en.activity)).toBe('Full check');
    expect(homeActivityLabel(undefined, homeCopy.en.activity)).toBe('Command');
    expect(Object.values(homeCopy.zh.activity).join('')).not.toContain('门禁');
    expect(Object.values(homeCopy.en.activity).join(' ').toLowerCase()).not.toContain('gate');
  });
});

describe('Workspace home tool rows', () => {
  it('lists the tools in the design order and groups', () => {
    expect(HOME_ROWS.map((row) => `${row.group}/${row.id}`)).toEqual([
      'activity/host:status',
      'activity/mode:trajectory',
      'activity/action:theater',
      'activity/mode:schedule',
      'activity/mode:eval',
      'activity/mode:tasks',
      'code/surface:files',
      'code/surface:changes',
      'code/surface:git',
      'code/surface:terminal',
      'code/surface:browser',
      'other/mode:recall',
      'other/host:voice',
      'other/host:films',
      'other/mode:team',
      'other/mode:community',
      'other/workspace:capability-evolution',
    ]);
    expect(new Set(HOME_ROWS.map((row) => row.id)).size).toBe(HOME_ROWS.length);
  });

  it('keeps the classic test ids so existing journeys find a tool in either shell', () => {
    const ids = HOME_ROWS.flatMap((row) => (row.kind === 'destination' ? [destinationTestId(row.destination)] : []));
    expect(ids).toEqual([
      'workspace-launcher-status',
      'workspace-launcher-trajectory',
      'workspace-launcher-theater',
      'workspace-launcher-schedule',
      'workspace-launcher-eval',
      'workspace-launcher-tasks',
      'workspace-launcher-dev-files',
      'workspace-launcher-dev-changes',
      'workspace-launcher-dev-git',
      'workspace-launcher-dev-terminal',
      'workspace-launcher-dev-browser',
      'workspace-launcher-recall',
      'workspace-launcher-voice',
      'workspace-launcher-films',
      'workspace-launcher-team',
      'workspace-launcher-community',
      'workspace-launcher-capability-evolution',
    ]);
  });

  it('hands the host the classic launcher\u2019s own destination objects, not look-alikes', () => {
    for (const row of HOME_ROWS) {
      if (row.kind !== 'destination') continue;
      const { kind, id } = row.destination;
      expect(row.destination).toEqual(canonicalLauncherDestination(kind, id));
    }
    for (const destination of Object.values(HOME_TRANSITIONAL_DESTINATIONS)) {
      expect(destination).toEqual(canonicalLauncherDestination(destination.kind, destination.id));
    }
    expect(() => canonicalLauncherDestination('surface', 'nope')).toThrow('No canonical launcher destination');
  });

  it('accounts for every workspace mode: on this page, or sent somewhere the shell already reaches', () => {
    // Where each mode the classic launcher offered goes in the new shell (verified reachable in the real host, see the
    // preservation matrix at the top of home-rows.ts). A new WorkspaceMode must be placed here on purpose.
    const relocated = {
      'needs-me': '待办 · 打开待处理列表',
      'product-schedule': '待办及工具页脚 · 日程',
      approval: '待办 · 打开审批列表',
      artifacts: '对话顶栏 · 作品',
    } as const;
    const onThisPage = HOME_ROWS.flatMap((row) =>
      row.kind === 'destination' && row.destination.kind === 'mode' ? [row.destination.id] : [],
    );
    const placed = [...onThisPage, ...Object.keys(relocated)].sort();
    expect(placed).toEqual(WORKSPACE_MODES.filter((mode) => mode !== 'dev').sort());
  });

  it('filters by name, description and search terms, case-insensitively', () => {
    const matching = (query: string) => HOME_ROWS.filter((row) => rowMatchesQuery(row, query)).map((row) => row.id);
    expect(matching('')).toHaveLength(HOME_ROWS.length);
    expect(matching('终端')).toEqual(['surface:terminal']);
    expect(matching('git')).toEqual(['surface:git', 'mode:community']);
    for (const query of ['调度', 'scheduling']) expect(matching(query)).toContain('mode:schedule');
    for (const query of ['评估', 'periodic']) expect(matching(query)).toContain('mode:eval');
    for (const query of ['社区', 'community']) expect(matching(query)).toContain('mode:community');
    for (const query of ['能力进化', 'evolution']) expect(matching(query)).toContain('workspace:capability-evolution');
    for (const query of ['毛线球', 'yarn ball', 'tasks']) expect(matching(query)).toContain('mode:tasks');
    expect(matching('会议')).toEqual(['host:voice']);
    expect(matching('zzz-nothing')).toEqual([]);
  });

  it('uses the unified product words, not internal ones', () => {
    const text = HOME_ROWS.map(
      (row) => `${homeCopy.zh.rows[row.copyKey].label}${homeCopy.zh.rows[row.copyKey].description}`,
    ).join('');
    expect(text).not.toContain('这条对话');
    expect(text).not.toContain('门禁');
  });

  it('has words in both languages for exactly the rows it lists, and no row is without its words', () => {
    const keys = HOME_ROWS.map((row) => row.copyKey).sort();
    expect(keys).toEqual(Object.keys(homeCopy.zh.rows).sort());
    expect(keys).toEqual(Object.keys(homeCopy.en.rows).sort());
    expect(new Set(keys).size).toBe(HOME_ROWS.length);
  });

  it('finds a row by either language, whichever language the page shows', () => {
    const matching = (query: string) => HOME_ROWS.filter((row) => rowMatchesQuery(row, query)).map((row) => row.id);
    expect(matching('terminal')).toEqual(['surface:terminal']);
    expect(matching('page preview')).toEqual(['surface:browser']);
    expect(matching('页面预览')).toEqual(['surface:browser']);
    expect(matching('modified')).toEqual(['surface:changes']);
    expect(matching('修改')).toEqual(['surface:changes']);
    expect(matching('meeting')).toEqual(['host:voice']);
    expect(matching('replay')).toEqual(['action:theater']);
    expect(matching('trace')).toEqual(['mode:trajectory']);
    expect(matching('轨迹')).toEqual(['mode:trajectory']);
    expect(matching('回放')).toEqual(['action:theater']);
  });
});
