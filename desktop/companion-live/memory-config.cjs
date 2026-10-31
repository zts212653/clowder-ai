const { resolve } = require('node:path');

function buildMemoryConfig({ synthetic = false, allowHomeReads = false, root, storage, memoryEntry, node }) {
  return {
    enabled: synthetic || allowHomeReads,
    command: node,
    args: [memoryEntry],
    enabled_tools: ['cat_cafe_read_file_slice'],
    env: {
      ALLOWED_WORKSPACE_DIRS: synthetic
        ? resolve(storage, 'mcp-data')
        : [resolve(root, 'docs/features'), resolve(root, 'docs/discussions/2026-09-15-f317-coactive-companion')].join(
            ',',
          ),
      CAT_CAFE_DATA_DIR: resolve(storage, 'mcp-data'),
    },
  };
}

module.exports = { buildMemoryConfig };
