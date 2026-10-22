#!/usr/bin/env node
import { prepareIntranetDeployment } from './lib/intranet-deployment.mjs';

const options = {};
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host-root', '--audit-dir'].includes(args[i]) || !args[i + 1])
      throw Error(
        'Usage: node scripts/prepare-intranet-deployment.mjs --host-root <absolute Host root> [--audit-dir <explicit audit directory>]',
      );
    options[args[i] === '--host-root' ? 'hostRoot' : 'auditDir'] = args[i + 1];
  }
  console.log(JSON.stringify(await prepareIntranetDeployment(options)));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: error.message, ...error.preparation }));
  process.exitCode = 1;
}
