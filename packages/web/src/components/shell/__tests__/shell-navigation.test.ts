import { beforeEach, describe, expect, it } from 'vitest';
import { rememberCafeReturnTarget, resolveShellNavTarget } from '../shell-navigation';

describe('shell world return navigation', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('returns to the original Cafe thread after exact world URLs drop their transient referrer', () => {
    rememberCafeReturnTarget('/thread/thread_original');
    window.history.replaceState(
      {},
      '',
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_aaaaaaaa',
    );

    expect(resolveShellNavTarget('/', '/collective')).toBe('/thread/thread_original');
  });

  it('captures the generic directory referrer without copying it into the strict world target', () => {
    window.history.replaceState({}, '', '/collective?from=thread_from_directory');
    rememberCafeReturnTarget('/collective');
    window.history.replaceState(
      {},
      '',
      '/collective?serviceUrl=https%3A%2F%2Fcollective.example&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_aaaaaaaa',
    );

    expect(resolveShellNavTarget('/', '/collective')).toBe('/thread/thread_from_directory');
    expect(window.location.search).not.toContain('from=');
  });

  it('lets an explicit Cafe-home visit replace an older thread return target', () => {
    rememberCafeReturnTarget('/thread/thread_old');
    rememberCafeReturnTarget('/');

    expect(resolveShellNavTarget('/', '/collective')).toBe('/');
  });
});
