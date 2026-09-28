export function useInvocationAuth(t) {
  const fixture = {
    CAT_CAFE_INVOCATION_ID: 'inv-registration-contract',
    CAT_CAFE_CALLBACK_TOKEN: 'token-registration-contract',
    CAT_CAFE_CREDENTIAL_FILE: undefined,
    CAT_CAFE_READONLY: 'false',
    CAT_CAFE_DESKTOP_MODE: undefined,
  };
  const original = new Map(Object.keys(fixture).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(fixture)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
