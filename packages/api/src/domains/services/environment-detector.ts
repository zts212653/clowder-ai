import { execSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EnvArch, EnvGpu, EnvironmentProfile, EnvOs, PythonArch } from './recommendation-types.js';

const CACHE_TTL_MS = 30_000;
let cached: { profile: EnvironmentProfile; expiresAt: number } | null = null;

function resolveOs(): EnvOs {
  const p = process.platform;
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new Error(`Unsupported OS: ${p}`);
}

function resolveArch(): EnvArch {
  // Previously coerced everything-not-arm64 to 'x64', so 32-bit hosts
  // (ia32, arm) and exotic arches (mips, ppc64, riscv64, s390x) passed
  // install gating and only failed deep inside the install scripts with
  // confusing wheel-resolution errors. Codex P2 3252087645 — return an
  // explicit 'unsupported' so buildRecommendation can fail fast with a
  // CPU-aware message.
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  return 'unsupported';
}

function runQuiet(command: string, args: string[] = [], timeout = 3000): string | null {
  try {
    const cmd = args.length ? `${command} ${args.join(' ')}` : command;
    return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function detectGpu(): { gpu: EnvGpu; gpuDetail?: string } {
  const os = resolveOs();
  if (os === 'darwin') {
    if (process.arch === 'arm64') {
      return { gpu: 'apple', gpuDetail: 'Apple Silicon GPU (Metal)' };
    }
    return { gpu: 'none', gpuDetail: 'Intel Mac (no MLX support)' };
  }

  const nv = runQuiet('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']);
  if (nv) {
    const first = nv.split('\n')[0]?.trim();
    return { gpu: 'cuda', gpuDetail: first || 'NVIDIA GPU (CUDA)' };
  }

  if (os === 'linux') {
    const rocm = runQuiet('rocminfo');
    if (rocm && rocm.includes('Agent')) {
      return { gpu: 'rocm', gpuDetail: 'AMD GPU (ROCm)' };
    }
  }

  return { gpu: 'none' };
}

interface PythonProbe {
  command: string;
  args: string[];
  machine: string | null;
  version: string | null;
}

function probePython(command: string, args: string[]): PythonProbe {
  const versionOutput = runQuiet(
    [command, ...args, '-c', '"import sys,platform;print(platform.machine());print(sys.version.split()[0])"'].join(' '),
  );
  if (!versionOutput) return { command, args, machine: null, version: null };
  const lines = versionOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    command,
    args,
    machine: lines[0] ?? null,
    version: lines[1] ?? null,
  };
}

function listCandidatePythons(os: EnvOs): Array<{ command: string; args: string[] }> {
  if (os === 'win32') {
    return [
      { command: 'py', args: ['-3.13'] },
      { command: 'py', args: ['-3.12'] },
      { command: 'py', args: ['-3.11'] },
      { command: 'py', args: ['-3.10'] },
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
      { command: 'py', args: ['-3-32'] },
      { command: 'py', args: ['-3.13-32'] },
      { command: 'py', args: ['-3.12-32'] },
      { command: 'py', args: ['-3.11-32'] },
      { command: 'py', args: ['-3.10-32'] },
    ];
  }
  return [
    { command: 'python3.13', args: [] },
    { command: 'python3.12', args: [] },
    { command: 'python3.11', args: [] },
    { command: 'python3.10', args: [] },
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

function isNativeMachine(machine: string, arch: EnvArch): boolean {
  const m = machine.toLowerCase();
  if (arch === 'arm64') return m === 'arm64' || m === 'aarch64';
  if (arch === 'x64') return m === 'x86_64' || m === 'amd64';
  return false; // 'unsupported' — no native interpreter qualifies
}

/**
 * On Windows ARM64 a native arm64 Python interpreter can be detected on PATH,
 * but it's unusable for our service deps (aiohttp / PyAV / piper-tts /
 * sentence-transformers ship no win-arm64 wheels). The bash/ps1 resolver
 * (python-resolve.{sh,ps1}) handles this at install time by downloading an
 * AMD64 interpreter to ~/.cat-cafe/python/. To keep the install-preview UI
 * aligned with that behavior, the detector here must NOT report such an
 * arm64 interpreter as a usable 'native' python — otherwise the matrix
 * win-arm64+native unsupported branch fires and 422s the install request
 * before resolver ever runs.
 */
function isAcceptableNativeInterpreter(os: EnvOs, arch: EnvArch, machine: string): boolean {
  if (!isNativeMachine(machine, arch)) return false;
  if (os === 'win32' && arch === 'arm64') return false; // native = arm64 here, rejected
  return true;
}

function detectPython(os: EnvOs, arch: EnvArch): { pythonArch: PythonArch; pythonVersion?: string } {
  const candidates = listCandidatePythons(os);
  const probes: PythonProbe[] = [];
  for (const cand of candidates) {
    const probe = probePython(cand.command, cand.args);
    if (probe.machine) probes.push(probe);
  }

  if (probes.length === 0) {
    return { pythonArch: 'missing' };
  }

  const acceptableNative = probes.find((p) => p.machine && isAcceptableNativeInterpreter(os, arch, p.machine));
  if (acceptableNative) {
    return { pythonArch: 'native', pythonVersion: acceptableNative.version ?? undefined };
  }

  // Found an "emulated" interpreter — i.e. an architecture different from the
  // host's native one. On Windows ARM64 this is the desired AMD64 path.
  const emulated = probes.find((p) => p.machine && !isNativeMachine(p.machine, arch));
  if (emulated) {
    return { pythonArch: 'x86-emulated', pythonVersion: emulated.version ?? undefined };
  }

  // Only an unacceptable native interpreter (i.e. arm64 Python on Windows
  // ARM64) was found. From the matrix's point of view this is the same as
  // "no Python yet" — the resolver will replace it at install time.
  return { pythonArch: 'missing' };
}

function detectRamGb(): number {
  return Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10;
}

/**
 * Resolve the disk volume installs will actually write to. Mirrors the
 * resolution in python-resolve.sh and resolveVenvPath:
 *   1. process.env.CAT_CAFE_HOME (with leading-~ expansion for .env-loaded
 *      values that escape shell expansion)
 *   2. <repoRoot>/.cat-cafe (default, Redis-convention layout)
 *   3. ~/.cat-cafe (legacy pre-a34ab1f2 install location)
 *   4. homedir() or / as last-resort
 *
 * Without this, install-preview probes homedir() but installs go to
 * CAT_CAFE_HOME — on containers / mounted workspaces those are
 * different filesystems, so the modal overestimates available disk and
 * lets users select models that fail install-time disk checks.
 * Codex P2 3279103375.
 */
function resolveCatCafeHome(): string {
  const raw = process.env.CAT_CAFE_HOME?.trim();
  if (raw) {
    // Expand leading ~ for values that came from .env / Node without shell
    // tilde-expansion (same pattern as python-resolve.sh case statement).
    if (raw === '~') return homedir();
    if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
    return raw;
  }
  // Default: <repoRoot>/.cat-cafe (mirrors python-resolve.sh derivation
  // via SCRIPT_DIR/../..).
  const here = dirname(fileURLToPath(import.meta.url));
  // ../../../../.. from packages/api/src/domains/services/ → repo root
  return resolve(here, '../../../../..', '.cat-cafe');
}

export function resolveDiskProbePath(targetPath: string, fallbackPaths: string[] = []): string {
  let current = resolve(targetPath);
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const fallbackPath of fallbackPaths) {
    if (existsSync(fallbackPath)) return fallbackPath;
  }
  return '/';
}

function detectDiskFreeGb(): number {
  // Probe the filesystem that will contain CAT_CAFE_HOME even on first
  // install, before the leaf directory exists.
  const catCafeHome = resolveCatCafeHome();
  const legacyHome = resolve(homedir(), '.cat-cafe');
  const probePath = resolveDiskProbePath(catCafeHome, [legacyHome, homedir(), '/']);
  try {
    const stat = statfsSync(probePath);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Math.round((free / 1024 / 1024 / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

export function detectEnvironmentSync(): EnvironmentProfile {
  const os = resolveOs();
  const arch = resolveArch();
  const { gpu, gpuDetail } = detectGpu();
  const { pythonArch, pythonVersion } = detectPython(os, arch);
  return {
    os,
    arch,
    archRaw: arch === 'unsupported' ? process.arch : undefined,
    gpu,
    gpuDetail,
    pythonArch,
    pythonVersion,
    ramGb: detectRamGb(),
    diskFreeGb: detectDiskFreeGb(),
    detectedAt: Date.now(),
  };
}

export function getEnvironmentProfile(forceRefresh = false): EnvironmentProfile {
  const now = Date.now();
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.profile;
  }
  const profile = detectEnvironmentSync();
  cached = { profile, expiresAt: now + CACHE_TTL_MS };
  return profile;
}

export function clearEnvironmentCache(): void {
  cached = null;
}
