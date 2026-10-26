import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const carriers = [
  ['agy-native', /(?:antigravity|agy)[^ ]*(?: |$)/i],
  ['claude', /(?:^|[/ ])claude(?: |$|\/)/],
  ['codex', /(?:^|[/ ])codex(?: |$|\/)/],
  ['gemini', /(?:^|[/ ])gemini(?: |$|\/)/],
  ['kimi', /(?:^|[/ ])kimi(?: |$|\/)/],
  ['opencode', /(?:^|[/ ])opencode(?: |$|\/)/],
  ['acp', /(?:icode|acp-client|acp-stdio)/i],
];

function classify(command) {
  const builtin =
    /([^\s]+)\/packages\/mcp-server\/(?:dist|src)\/(secret-mcp-proxy|index|collab|memory|signals|limb|audio|finance|remote-spike|dot-remote-proxy)\.[cm]?[jt]s(?: |$)/.exec(
      command,
    );
  if (builtin)
    return {
      category: builtin[2] === 'secret-mcp-proxy' ? 'protection_proxy' : 'self_mcp',
      family: builtin[2] === 'secret-mcp-proxy' ? null : builtin[2],
      deploymentRoot: builtin[1],
    };
  if (
    /(?:Google Chrome(?: Helper)?(?:\.app)?|chrome-headless-shell|\/Chromium|\/firefox(?: |$)|ms-playwright\/.*(?:chrome|headless))/i.test(
      command,
    )
  )
    return { category: 'browser' };
  if (
    /(?:mcp-server|server-(?:filesystem|memory|everything)|playwright\/cli\.js|chrome-devtools-mcp|pencil.*mcp|mcp-remote|context7|fetch-mcp)/i.test(
      command,
    )
  )
    return { category: 'external_mcp' };
  if (carriers.some(([, pattern]) => pattern.test(command))) return { category: 'carrier' };
  if (/(?:^|[/ ])node(?: |$)/.test(command)) return { category: 'unknown_node' };
  return { category: 'other' };
}

/** Only this public projection may be archived; argv and environment never leave this function. */
export function projectProcessCensus(rows) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const processes = rows.map(({ pid, ppid, rssKiB, cpuPercent, elapsed, command }) => {
    let parent = byPid.get(pid);
    let carrier = 'unknown';
    const visited = new Set();
    while (parent && !visited.has(parent.pid)) {
      visited.add(parent.pid);
      const match = carriers.find(([, pattern]) => pattern.test(parent.command));
      if (match) {
        carrier = match[0];
        break;
      }
      parent = byPid.get(parent.ppid);
    }
    return {
      pid,
      ppid,
      rssKiB,
      cpuPercent,
      elapsed,
      carrier,
      family: null,
      deploymentRoot: null,
      ...classify(command),
      activity: 'unobserved',
      permissionDomain: 'unobserved',
    };
  });
  const groups = new Map();
  for (const row of processes) {
    const key = JSON.stringify([row.category, row.carrier, row.deploymentRoot, row.family]);
    const group = groups.get(key) ?? {
      category: row.category,
      carrier: row.carrier,
      deploymentRoot: row.deploymentRoot,
      family: row.family,
      count: 0,
      rssKiB: 0,
      cpuPercent: 0,
    };
    group.count++;
    group.rssKiB += row.rssKiB;
    group.cpuPercent += row.cpuPercent;
    groups.set(key, group);
  }
  return {
    processes,
    groups: [...groups.values()],
    totals: { count: rows.length, rssKiB: rows.reduce((n, row) => n + row.rssKiB, 0) },
  };
}

export function collectProcessCensus() {
  // argv is read only in memory for classification. No raw output, errors or env are archived.
  const output = execFileSync('ps', ['-ww', '-axo', 'pid=,ppid=,rss=,%cpu=,etime=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.+)$/.exec(line);
    return match
      ? [
          {
            pid: +match[1],
            ppid: +match[2],
            rssKiB: +match[3],
            cpuPercent: +match[4],
            elapsed: match[5],
            command: match[6],
          },
        ]
      : [];
  });
  const census = projectProcessCensus(rows);
  const revisions = [...new Set(census.processes.map((row) => row.deploymentRoot).filter(Boolean))].map((root) => {
    let checkoutHead = 'unknown';
    try {
      checkoutHead = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      }).trim();
    } catch {
      /* explicitly unknown */
    }
    return { root, checkoutHead, loadedVersion: 'unverified: checkout HEAD is not process-loaded provenance' };
  });
  return {
    v: 1,
    capturedAt: new Date().toISOString(),
    metric: 'sum of process RSS KiB; shared pages may be counted more than once; compare only matched loads',
    activityEvidence: 'unobserved: elapsed time and CPU do not prove active/idle ownership',
    permissionEvidence: 'unobserved: requires Host launch evidence, never inferred from argv/env',
    ...census,
    revisions,
  };
}

/** Inspect only the fixture's descendants in memory; archive booleans, never argv/env. */
export function inspectOwnedProcessCredentials(rootPid, credentialValues) {
  const census = collectProcessCensus();
  const owned = new Set([rootPid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of census.processes)
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const descendants = [...owned].filter((pid) => pid !== rootPid);
  const carrierProcessCount = census.processes.filter(
    (row) =>
      row.pid !== rootPid && owned.has(row.pid) && ['carrier', 'self_mcp', 'protection_proxy'].includes(row.category),
  ).length;
  const selfMcpProcessCount = census.processes.filter(
    (row) => owned.has(row.pid) && row.category === 'self_mcp',
  ).length;
  const ownedRows = census.processes
    .filter((row) => owned.has(row.pid))
    .map((row) => (row.pid === rootPid ? { ...row, category: 'api_host' } : row));
  const resourceCost = {
    rssKiB: ownedRows.reduce((sum, row) => sum + row.rssKiB, 0),
    hostRssKiB: ownedRows.find((row) => row.pid === rootPid)?.rssKiB ?? 0,
    byCategory: Object.fromEntries(
      [...new Set(ownedRows.map((row) => row.category))].map((category) => {
        const rows = ownedRows.filter((row) => row.category === category);
        return [category, { count: rows.length, rssKiB: rows.reduce((sum, row) => sum + row.rssKiB, 0) }];
      }),
    ),
  };
  if (!descendants.length)
    return {
      ...resourceCost,
      complete: true,
      processCount: 0,
      carrierProcessCount,
      selfMcpProcessCount,
      credentialValueDetected: false,
    };
  try {
    const observed = execFileSync('/bin/ps', ['eww', '-p', descendants.join(','), '-o', 'pid=,ppid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ...resourceCost,
      complete: true,
      processCount: descendants.length,
      carrierProcessCount,
      selfMcpProcessCount,
      credentialValueDetected: [...credentialValues].some((value) => value.length > 8 && observed.includes(value)),
    };
  } catch {
    return {
      ...resourceCost,
      complete: false,
      processCount: descendants.length,
      carrierProcessCount,
      selfMcpProcessCount,
      credentialValueDetected: false,
    };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(collectProcessCensus(), null, 2)}\n`);
}
