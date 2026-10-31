import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deriveNamedAlphaCoordinates } from './alpha-coordinates.mjs';

export const STANDARD_ALPHA_PORTS = Object.freeze({
  frontend: 3011,
  api: 3012,
  preview: 4111,
  service: 5211,
  redis: 6397,
});

/** Bounded launcher options shared by guard and managed Alpha launch. No child/path overrides. */
export function parseAlphaLaunchOptions(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--instance', '--ports', '--no-quick', '--allow-empty-redis'].includes(flag))
      throw new Error(`Unsupported managed Alpha option: ${flag}`);
    if (Object.hasOwn(options, flag)) throw new Error(`Duplicate managed Alpha option: ${flag}`);
    if (['--instance', '--ports'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing managed Alpha value: ${flag}`);
      options[flag] = value;
    } else options[flag] = true;
  }
  if (Boolean(options['--instance']) !== Boolean(options['--ports']))
    throw new Error('Named Alpha requires --instance and --ports together');
  if (options['--instance'] && options['--no-quick']) throw new Error('Named Alpha does not support --no-quick');
  return options;
}

export function alphaLaunchCoordinates(mainRoot, options) {
  if (options['--instance'])
    return deriveNamedAlphaCoordinates({ mainRoot, instance: options['--instance'], ports: options['--ports'] });
  return { mainRoot, alphaRoot: join(dirname(mainRoot), 'cat-cafe-alpha'), ports: STANDARD_ALPHA_PORTS };
}

/** Explicit env values may restate isolated coordinates, never select code or a different port. */
export function parseAlphaLaunchChild(child, mainRoot) {
  const environment = [];
  let index = 0;
  if (child[0] === 'env') {
    index++;
    while (/^[A-Za-z_]\w*=/.test(child[index] ?? '')) environment.push(child[index++]);
  }
  if (child[index] !== 'pnpm' || child[index + 1] !== 'alpha:start')
    throw new Error('Managed Alpha requires pnpm alpha:start');
  const options = parseAlphaLaunchOptions(child.slice(index + 2));
  const coordinates = alphaLaunchCoordinates(mainRoot, options);
  const { ports } = coordinates;
  const allowed = {
    CAT_CAFE_API_PORT: String(ports.api),
    CAT_CAFE_WEB_PORT: String(ports.frontend),
    CAT_CAFE_ALPHA_API_PORT: String(ports.api),
    CAT_CAFE_ALPHA_FRONTEND_PORT: String(ports.frontend),
    CAT_CAFE_ALPHA_PREVIEW_GATEWAY_PORT: String(ports.preview),
    CAT_CAFE_ALPHA_REDIS_PORT: String(ports.redis),
  };
  const seen = new Set();
  for (const assignment of environment) {
    const equals = assignment.indexOf('=');
    const key = assignment.slice(0, equals);
    if (seen.has(key) || allowed[key] !== assignment.slice(equals + 1))
      throw new Error(`Unsupported managed Alpha environment: ${key}`);
    seen.add(key);
  }
  return { options, coordinates, environment };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    process.stdout.write(
      args.length === 1 && args[0] === '--standard-ports'
        ? `${Object.values(STANDARD_ALPHA_PORTS).join('\t')}\n`
        : `${JSON.stringify(parseAlphaLaunchOptions(args))}\n`,
    );
  } catch (error) {
    process.stderr.write(`[alpha-launch-contract] ${error.message}\n`);
    process.exitCode = 1;
  }
}
