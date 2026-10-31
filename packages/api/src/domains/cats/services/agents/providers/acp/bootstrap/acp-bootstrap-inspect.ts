import { dirname, isAbsolute } from 'node:path';
import { isTrustedHostCompatibilityEnabled } from '../../../../../../../config/trusted-host-compatibility.js';
import { resolveAcpBootstrapCwd } from '../acp-bootstrap-cwd.js';

export function isExplicitAcpBootstrapRoot(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\u0000\r\n]/.test(value) &&
    isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value))
  );
}

/** Same Host policy as a generic client; never starts an agent or repairs existing ACLs. */
export function inspectAcpBootstrapDirectory(
  root?: string,
): { ok: true; root: string; trustMode: 'strict' | 'trusted-host' } | { ok: false; error: string } {
  let compatibility = false;
  if (root !== undefined && !isExplicitAcpBootstrapRoot(root)) {
    return { ok: false, error: '引导目录必须是本机绝对路径。' };
  }
  try {
    compatibility = process.platform === 'win32' && isTrustedHostCompatibilityEnabled();
    const cwd = resolveAcpBootstrapCwd(
      process.cwd(),
      'directory-check',
      root,
      undefined,
      undefined,
      root === undefined,
      { preserveExistingPermissions: true },
    );
    return {
      ok: true,
      root: dirname(cwd),
      trustMode: compatibility ? 'trusted-host' : 'strict',
    };
  } catch (error) {
    return {
      ok: false,
      error: `${error instanceof Error ? error.message : String(error)}\n未修改已有目录权限。${compatibility ? '兼容模式仍要求目录自身私有权限、真实本地卷和非链接路径合格。' : '请选择祖先链同样安全的位置；在不可信卷内新建文件夹不能修复祖先问题。'}`,
    };
  }
}
