export const F163_TEST_OWNER_USER_ID = 'f163-test-owner';

export function installF163AdminTestSessionHook(app) {
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
}

export function useF163TestOwner() {
  process.env.DEFAULT_OWNER_USER_ID = F163_TEST_OWNER_USER_ID;
}

export function restoreDefaultOwnerUserId(originalDefaultOwnerUserId) {
  if (originalDefaultOwnerUserId === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = originalDefaultOwnerUserId;
}

export function f163OwnerHeaders(extra = {}) {
  return { 'x-test-session-user': F163_TEST_OWNER_USER_ID, ...extra };
}
