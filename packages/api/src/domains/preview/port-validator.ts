import type { PortValidationOptions, PortValidationResult } from './types.js';

/** Clowder AI 自身服务端口 — 硬编码保底 */
export const DEFAULT_EXCLUDED_PORTS = [
  3001,
  3002, // Hub frontend + API (internal defaults)
  3003,
  3004, // Hub frontend + API (public defaults)
  6398,
  6399, // Redis dev + prod
  18888,
  19999, // MCP / API gateway
  9876,
  9878,
  9879, // Whisper, LLM postprocess, TTS
  9877, // Anthropic proxy
];

/**
 * Collect Clowder AI service ports from runtime environment variables.
 * These are merged with the hardcoded fallback list for defense in depth.
 */
export function collectRuntimePorts(): number[] {
  const envKeys = [
    'API_SERVER_PORT',
    'FRONTEND_PORT',
    'MCP_SERVER_PORT',
    'PREVIEW_GATEWAY_PORT',
    'REDIS_PORT',
    'VITE_PORT',
  ];
  const ports: number[] = [];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val) {
      const n = Number.parseInt(val, 10);
      if (n > 0 && n <= 65535) ports.push(n);
    }
  }
  return ports;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PORT_MIN = 1024;
const PORT_MAX = 65535;

export function validatePort(rawPort: number | string, opts: PortValidationOptions = {}): PortValidationResult {
  const port = typeof rawPort === 'string' ? Number.parseInt(rawPort, 10) : rawPort;
  if (!Number.isFinite(port)) {
    return { allowed: false, reason: 'Port must be a valid number' };
  }

  const { host, gatewaySelfPort, runtimePorts } = opts;
  const excludedPorts = [...DEFAULT_EXCLUDED_PORTS, ...(opts.excludedPorts ?? []), ...(runtimePorts ?? [])];

  if (host && !LOOPBACK_HOSTS.has(host)) {
    return { allowed: false, reason: `Only loopback hosts allowed (got: ${host})` };
  }

  if (port < PORT_MIN || port > PORT_MAX) {
    return { allowed: false, reason: `Port must be in range ${PORT_MIN}-${PORT_MAX}` };
  }

  if (gatewaySelfPort && port === gatewaySelfPort) {
    return { allowed: false, reason: 'Cannot proxy to gateway self port (recursive proxy)' };
  }

  if (excludedPorts.includes(port)) {
    return { allowed: false, reason: `Port ${port} is excluded (Clowder AI service port)` };
  }

  return { allowed: true };
}
