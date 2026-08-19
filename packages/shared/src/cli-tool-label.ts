const CLI_PRIMARY_ARG_KEYS = ['file_path', 'command', 'pattern', 'url', 'query', 'prompt'] as const;

function truncateCliArg(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

export function cleanCliToolLabel(label: string): string {
  const arrowIndex = label.indexOf(' → ');
  return arrowIndex >= 0 ? label.slice(arrowIndex + 3) : label;
}

export function extractCliPrimaryArg(detail?: string): string | undefined {
  if (!detail) return undefined;
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    for (const key of CLI_PRIMARY_ARG_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) return truncateCliArg(value);
    }
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.length > 0 && value.length <= 80) return truncateCliArg(value);
    }
  } catch {
    for (const key of CLI_PRIMARY_ARG_KEYS) {
      const match = detail.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (match?.[1]) return truncateCliArg(match[1]);
    }
  }
  return undefined;
}

/** Canonical label projection shared by the visible CLI and F294 source verification. */
export function projectCliToolUseLabel(label: string, detail?: string): string {
  const toolName = cleanCliToolLabel(label);
  const primaryArg = extractCliPrimaryArg(detail);
  return primaryArg ? `${toolName} ${primaryArg}` : toolName;
}
