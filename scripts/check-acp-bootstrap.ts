import { inspectAcpBootstrapDirectory } from '../packages/api/src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.js';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--root')) {
  console.error('Usage: node --import tsx scripts/check-acp-bootstrap.ts [--root <absolute-directory>]');
  process.exitCode = 2;
} else {
  const result = inspectAcpBootstrapDirectory(args[1]);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
