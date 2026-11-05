/** Test-owned auth inputs; never print, persist or change the host CLI's files. */
export const ACCOUNT_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'MOONSHOT_API_KEY',
  'KIMI_BASE_URL',
  'CAT_CAFE_KIMI_BASE_URL',
  'OPENCODE_BASE_URL',
  'CAT_CAFE_OC_BASE_URL',
];

/** Snapshot before clearing; restore exactly, including originally absent variables. */
export function isolateAccountAuthEnvironment() {
  const previous = new Map(ACCOUNT_AUTH_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ACCOUNT_AUTH_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
