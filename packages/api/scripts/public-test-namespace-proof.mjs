import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';

const NAMESPACE_ID = /^\d+:\d+$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function kernelNamespaceIdentity(path = '/proc/self/ns/net') {
  const value = statSync(path, { bigint: true });
  return `${value.dev}:${value.ino}`;
}

/** No environment assertion can stand in for a different kernel namespace. */
export function validateNamespaceProof(proof, { currentNamespace, bootId }) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.schemaVersion !== 1) return 'unknown';
  if (
    ![proof.host, proof.isolated, currentNamespace].every(
      (value) => typeof value === 'string' && NAMESPACE_ID.test(value),
    )
  ) {
    return 'unknown';
  }
  if (![proof.nonce, proof.bootId, bootId].every((value) => typeof value === 'string' && UUID.test(value)))
    return 'unknown';
  if (proof.bootId !== bootId || proof.isolated !== currentNamespace || proof.host === currentNamespace)
    return 'absent';
  return 'verified';
}

/**
 * Read a root-created launcher receipt after privilege drop. PID 1's namespace
 * is unreadable then (ptrace access checks), so the launcher records it before
 * setpriv. Trust comes from kernel file ownership and namespace binding, not
 * the environment variable carrying the path. Pin the parent directory by fd
 * before opening its child, refusing symlinks and child-writable artifacts.
 * The root launcher is trusted: an adversarial root could forge the host field.
 * This proves isolation to the unprivileged child, not against a hostile host.
 */
export function observeNamespaceProof({
  proofPath = process.env.CAT_CAFE_PUBLIC_TEST_NETNS_PROOF,
  platform = process.platform,
} = {}) {
  if (platform !== 'linux' || proofPath === undefined || proofPath === '') return 'absent';
  if (typeof proofPath !== 'string' || !isAbsolute(proofPath)) return 'unknown';
  let directoryFd;
  let fileFd;
  try {
    directoryFd = openSync(dirname(proofPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const directory = fstatSync(directoryFd);
    if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o022) !== 0) return 'absent';
    fileFd = openSync(
      `/proc/self/fd/${directoryFd}/${basename(proofPath)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const file = fstatSync(fileFd);
    if (!file.isFile() || file.uid !== 0 || file.nlink !== 1 || (file.mode & 0o777) !== 0o444) return 'absent';
    if (file.size === 0 || file.size > 4096) return 'unknown';
    const proof = JSON.parse(readFileSync(fileFd, 'utf8'));
    return validateNamespaceProof(proof, {
      currentNamespace: kernelNamespaceIdentity(),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    });
  } catch (error) {
    return error.code === 'ENOENT' ? 'absent' : 'unknown';
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
