/**
 * F317 I-11: qoder runtime profile ownership / lifecycle
 *
 * L1 实证：qodercn 把 session 存在 config-dir 的 projects/<cwd-slug>/ 下，resume 要求
 * 同 config-dir + 同 cwd。生产不能逐 invocation 临时 clone（破坏 resume），也不能直接
 * 用用户个人 ~/.qoder-cn（越过 clean-profile 边界）。本模块实现提案 I-11 契约：
 * 归属（per-cat 持久目录，runtime 拥有）、原子 seed/swap、每次 invocation 前洁净审计、
 * 损坏或换绑时的原子替换（失败保留旧 profile）、account custody（fingerprint 绑定）。
 *
 * Slice 1 review 修正（砚砚 8xP1）：
 * - catId 单段安全字符 + resolve containment（杜绝 ../ 逃逸递归删除）
 * - 审计无深度上限；readdir/stat/lstat 异常与 symlink 一律判 violation（fail-closed）
 * - 审计 fs 依赖全量可注入（测试与生产同一语义文件系统面）
 * - 换绑账号：fingerprint marker 不匹配 → 原子换绑（绝不沿用旧凭证）
 * - swap：stage 新副本审计绿后才替换；失败保留旧 profile（backup 回滚）
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  statSync as fsStatSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface QoderProfileFs {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string, opts: { withFileTypes: true }) => import('node:fs').Dirent[];
  lstatSync: (p: string) => { isFile(): boolean; isSymbolicLink(): boolean; mode: number };
  readFileSync: (p: string) => string;
  writeFileSync: (p: string, data: string) => void;
  copySync: (src: string, dest: string) => void;
  mkdirSync: (p: string, opts: { recursive: true }) => void;
  renameSync: (from: string, to: string) => void;
  rmSync: (p: string, opts: { recursive: true; force: true }) => void;
}

export function defaultQoderProfileFs(): QoderProfileFs {
  return {
    existsSync: fsExistsSync,
    readdirSync: (p, opts) => fsReaddirSync(p, opts),
    lstatSync: (p) => fsLstatSync(p),
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
    writeFileSync: (p, d) => fsWriteFileSync(p, d),
    copySync: (s, d) => cpSync(s, d, { recursive: true }),
    mkdirSync: (p, o) => fsMkdirSync(p, o),
    renameSync: fsRenameSync,
    rmSync: fsRmSync,
  };
}

/** 审计结果：ok 或违规明细（fail-closed，调用方拒发 invocation） */
export interface QoderProfileAudit {
  ok: boolean;
  violations: string[];
  /** 触发了原子替换（损坏或换绑）；session 丢失为 I-11 已知语义 */
  swapped?: 'reseed-pollution' | 'rebind-account';
  /** account fingerprint（.auth/user 内容 sha256 前 16 位） */
  accountFingerprint?: string;
}

/** 无深度上限的完整遍历；异常与 symlink 一律 violation（安全审计不得把未知当绿） */
function findExecutableArtifacts(profileDir: string, fs: QoderProfileFs): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      offenders.push(`unreadable dir ${dir}: ${String(err)}`);
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      try {
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          offenders.push(`symlink: ${p}`);
          continue;
        }
        if (st.isFile()) {
          if (/\.(sh|js|mjs|cjs|py)$/.test(entry.name) || (st.mode & 0o111) !== 0) {
            offenders.push(`executable artifact: ${p}`);
          }
        } else {
          walk(p);
        }
      } catch (err) {
        offenders.push(`unstatable ${p}: ${String(err)}`);
      }
    }
  };
  walk(profileDir);
  return offenders;
}

/** settings*.json 出现非空 hooks 键即违规（hooks:{} 视为空，不算违规） */
function settingsHooksViolations(profileDir: string, fs: QoderProfileFs): string[] {
  const violations: string[] = [];
  for (const name of ['settings.json', 'settings.local.json'] as const) {
    const p = join(profileDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p)) as Record<string, unknown>;
      const hooks = parsed.hooks;
      if (hooks != null && typeof hooks === 'object' && Object.keys(hooks as object).length > 0) {
        violations.push(`${name}: non-empty hooks key`);
      }
    } catch {
      violations.push(`${name}: unparseable`);
    }
  }
  return violations;
}

/** catId 必须是单段安全字符（字母/数字/-/_），从根上杜绝路径逃逸 */
export function isSafeCatIdSegment(catId: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(catId);
}

/** resolve containment：target 必须严格位于 parent 内（或等于） */
function assertContained(parent: string, target: string, label: string): void {
  const rp = resolve(parent);
  const rt = resolve(target);
  if (rt !== rp && !rt.startsWith(rp + sep)) {
    throw new Error(`profile path escapes ${label}: ${target}`);
  }
}

export function computeAccountFingerprint(authSourceDir: string, fs: QoderProfileFs): string | null {
  try {
    const bytes = fs.readFileSync(join(authSourceDir, '.auth', 'user'));
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 审计：.auth 在、fingerprint marker 在且匹配、无 settings hooks、无深层可执行物/symlink */
export function auditQoderProfile(
  profileDir: string,
  fs: QoderProfileFs,
  expectedAccountFingerprint?: string,
): QoderProfileAudit {
  const violations: string[] = [];
  if (!fs.existsSync(join(profileDir, '.auth'))) violations.push('missing .auth');
  let fingerprint: string | undefined;
  if (fs.existsSync(join(profileDir, '.account-fingerprint'))) {
    try {
      fingerprint = fs.readFileSync(join(profileDir, '.account-fingerprint')).trim();
    } catch {
      violations.push('unreadable .account-fingerprint');
    }
    if (expectedAccountFingerprint && fingerprint !== expectedAccountFingerprint) {
      violations.push(`account fingerprint mismatch (profile=${fingerprint} expected=${expectedAccountFingerprint})`);
    }
  } else {
    violations.push('missing .account-fingerprint');
  }
  violations.push(...settingsHooksViolations(profileDir, fs));
  violations.push(...findExecutableArtifacts(profileDir, fs));
  return { ok: violations.length === 0, violations, accountFingerprint: fingerprint };
}

/** 原子替换：stage(seed+fingerprint) → 审计 staging 绿 → swap（旧→backup→回滚保护） */
function atomicSwap(input: {
  profileDir: string;
  authSourceDir: string;
  fs: QoderProfileFs;
  swapReason: 'reseed-pollution' | 'rebind-account';
}): QoderProfileAudit {
  const { profileDir, authSourceDir, fs, swapReason } = input;
  const staging = `${profileDir}.staging-${process.pid}-${Date.now()}`;
  const backup = `${profileDir}.old-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(staging, { recursive: true });
    fs.copySync(join(authSourceDir, '.auth'), join(staging, '.auth'));
    const fingerprint = computeAccountFingerprint(authSourceDir, fs);
    if (!fingerprint) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, violations: ['auth source unreadable'] };
    }
    fs.writeFileSync(join(staging, '.account-fingerprint'), fingerprint);
    const stagingAudit = auditQoderProfile(staging, fs, fingerprint);
    if (!stagingAudit.ok) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, violations: [`staging audit failed: ${stagingAudit.violations.join('; ')}`] };
    }
    if (fs.existsSync(profileDir)) fs.renameSync(profileDir, backup);
    try {
      fs.renameSync(staging, profileDir);
    } catch (err) {
      // 回滚 backup 并**清掉含新凭证的 staging**（round-2 P1-7：不留凭证孤儿）
      try {
        if (fs.existsSync(backup)) fs.renameSync(backup, profileDir);
      } catch {
        /* best effort rollback */
      }
      try {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      return { ok: false, violations: [`swap failed (rolled back, staging cleaned): ${String(err)}`] };
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    return { ok: true, violations: [], swapped: swapReason, accountFingerprint: fingerprint };
  } catch (err) {
    for (const leftover of [staging, backup]) {
      try {
        if (fs.existsSync(leftover)) fs.rmSync(leftover, { recursive: true, force: true });
      } catch {
        /* best effort：任何遗留都不该含可用凭证（backup 在 swap 成功后删除，失败路径在上面） */
      }
    }
    return { ok: false, violations: [`swap aborted (staging/backup cleaned): ${String(err)}`] };
  }
}

/**
 * ensure：catId 安全段 + containment 校验后——
 * 不存在 → 原子 seed；存在且审计绿 → 复用；污染/换绑 → 原子替换（失败保留旧 profile）
 */
export function ensureQoderRuntimeProfile(input: {
  dataRoot: string;
  catId: string;
  authSourceDir: string;
  fs?: QoderProfileFs;
}): { profileDir: string; audit: QoderProfileAudit } {
  const fs = input.fs ?? defaultQoderProfileFs();
  if (!isSafeCatIdSegment(input.catId)) {
    throw new Error(`unsafe catId segment: ${JSON.stringify(input.catId)}`);
  }
  const base = join(input.dataRoot, 'qoder-profiles');
  const profileDir = join(base, input.catId);
  assertContained(base, profileDir, 'qoder-profiles root');
  const fingerprint = computeAccountFingerprint(input.authSourceDir, fs);
  if (!fingerprint) return { profileDir, audit: { ok: false, violations: ['auth source unreadable'] } };

  if (fs.existsSync(profileDir)) {
    const audit = auditQoderProfile(profileDir, fs, fingerprint);
    if (audit.ok) return { profileDir, audit };
    const isRebind = audit.violations.some((v) => v.includes('fingerprint mismatch'));
    return {
      profileDir,
      audit: atomicSwap({
        profileDir,
        authSourceDir: input.authSourceDir,
        fs,
        swapReason: isRebind ? 'rebind-account' : 'reseed-pollution',
      }),
    };
  }
  fs.mkdirSync(base, { recursive: true });
  return {
    profileDir,
    audit: atomicSwap({ profileDir, authSourceDir: input.authSourceDir, fs, swapReason: 'reseed-pollution' }),
  };
}
