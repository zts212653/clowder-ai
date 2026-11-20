import agentAccess from '@clowder-ai/agent-access/manifest.json' with { type: 'json' };
import { validateManifest } from '@clowder-ai/plugin-contract';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

const validatedAgentAccess = validateManifest(agentAccess);
if (!validatedAgentAccess.valid)
  throw new TypeError(`Bundled Agent access manifest is invalid: ${validatedAgentAccess.errors[0]?.message}`);
export const AGENT_ACCESS_MANIFEST = validatedAgentAccess.manifest;

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  { catalogId: 'agent-access', manifest: AGENT_ACCESS_MANIFEST },
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '4c31b455e4243bf93d7d8d6edddd28a68f62144fa6ecfae75870545847bef0c9' },
  },
];
