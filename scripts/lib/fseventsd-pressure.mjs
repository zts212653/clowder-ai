const ADVISORY_MEMORY_FRACTION = 0.1;
const CRITICAL_MEMORY_FRACTION = 0.2;
const ACTIVE_CPU_PERCENT = 50;
const CONSTRAINED_MEMORY_FREE_PERCENT = 10;

export function fseventsdAdvisoryRssKb(configuredMaxKb, totalMemoryKb) {
  const scaledMaxKb = Math.floor(totalMemoryKb * ADVISORY_MEMORY_FRACTION);
  return Math.min(configuredMaxKb, scaledMaxKb);
}

function pressureSignals(row, totalMemoryKb, memoryFreePercent) {
  const rssMemoryPercent = (row.rssKb / totalMemoryKb) * 100;
  const signals = [];
  if (rssMemoryPercent >= CRITICAL_MEMORY_FRACTION * 100) {
    signals.push(`${rssMemoryPercent.toFixed(1)}% of system memory`);
  }
  if (row.cpuPercent !== null && row.cpuPercent >= ACTIVE_CPU_PERCENT) {
    signals.push(`CPU ${row.cpuPercent.toFixed(1)}%`);
  }
  if (memoryFreePercent !== null && memoryFreePercent <= CONSTRAINED_MEMORY_FREE_PERCENT) {
    signals.push(`system memory free ${memoryFreePercent}%`);
  }
  return signals;
}

function diagnosticSuffix() {
  return [
    `  diagnose stale/no-listener Clowder AI dev/watch process groups: pnpm process:doctor`,
    `  safe cleanup for Clowder AI-owned stale rows: pnpm process:cleanup`,
    `  re-check fseventsd: ps -axo pid=,rss=,%cpu=,command= | rg '(^|/)fseventsd'`,
    `  cleanup can reduce new file-event load but will not necessarily reduce fseventsd RSS once the daemon is inflated; OS-level recovery or reboot may still be required.`,
    `  Manual gate bypass is a operator override, not a pnpm gate pass.`,
  ].join('\n');
}

export function classifyFseventsdPressure(row, advisoryRssKb, totalMemoryKb, memoryFreePercent) {
  if (row.rssKb <= advisoryRssKb) {
    return null;
  }

  const signals = pressureSignals(row, totalMemoryKb, memoryFreePercent);
  const observed = [
    row.cpuPercent === null ? 'CPU unavailable' : `CPU ${row.cpuPercent.toFixed(1)}%`,
    memoryFreePercent === null ? 'system memory pressure unavailable' : `system memory free ${memoryFreePercent}%`,
  ].join(', ');

  if (signals.length === 0) {
    return {
      level: 'warning',
      message:
        `fseventsd RSS ${row.rssKb}KB exceeds advisory threshold ${advisoryRssKb}KB (pid ${row.pid}), ` +
        `but no active pressure signal was observed (${observed}); gate allowed. Monitor before starting other heavy file workloads.`,
    };
  }

  return {
    level: 'failure',
    message:
      `fseventsd RSS ${row.rssKb}KB exceeds advisory threshold ${advisoryRssKb}KB (pid ${row.pid}); ` +
      `gate blocked because active/critical pressure was observed: ${signals.join(', ')}.\n${diagnosticSuffix()}`,
  };
}
