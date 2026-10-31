import { deploymentDefaults } from '@cat-cafe/shared';

/**
 * F120: Preview URL parsing + Clowder AI Hub URL detection.
 * Extracted as pure function for testability.
 */

/** Paths that indicate a Clowder AI Hub page (not a dev server app) */
const HUB_PATH_PATTERNS = [/^\/thread\//, /^\/api\//, /^\/settings\/?/];

/** F322 v2: typed issue codes so each presentation can render its own copy. */
export type PreviewUrlIssueCode = 'invalid_url' | 'hub_page';

export interface ParsedPreviewUrl {
  valid: boolean;
  port?: number;
  path?: string;
  error?: string;
  /** Non-blocking warning: URL looks like a Clowder AI Hub page */
  warning?: string;
  errorCode?: PreviewUrlIssueCode;
  warningCode?: PreviewUrlIssueCode;
}

export function parsePreviewUrl(input: string): ParsedPreviewUrl {
  if (!input.trim()) {
    return { valid: false, error: 'Enter a valid localhost URL (e.g. localhost:5173)', errorCode: 'invalid_url' };
  }

  const match = input.match(/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|::1):(\d+)(\/.*)?$/);
  if (!match) {
    return { valid: false, error: 'Enter a valid localhost URL (e.g. localhost:5173)', errorCode: 'invalid_url' };
  }

  const port = Number.parseInt(match[1], 10);
  const path = match[2] ?? '/';

  let warning: string | undefined;
  for (const pattern of HUB_PATH_PATTERNS) {
    if (pattern.test(path)) {
      warning =
        `This URL looks like a ${deploymentDefaults.brand.displayName} Hub page, not a dev server. ` +
        'Preview is designed for dev servers (Vite, Next.js, etc.).';
      break;
    }
  }

  return { valid: true, port, path, warning, warningCode: warning ? 'hub_page' : undefined };
}
