const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const postcss = require('postcss');
const files = require('../app-global-styles.json');
const roles = require('../../src/components/chat-background/surface-roles.json');

/** Standard CSS role declarations decorate existing paint. Native app links keep
 * their ordinary CSS; their decorations join globals.css, while modules compile in place. */
module.exports = () => ({
  postcssPlugin: 'cafe-surface-declarations',
  Once(root, { result }) {
    const webRoot = resolve(__dirname, '../..');
    if (root.source?.input.file === resolve(webRoot, 'src/app/globals.css')) {
      result.messages.push({
        type: 'dependency',
        plugin: 'cafe-surface-declarations',
        file: resolve(webRoot, 'scripts/app-global-styles.json'),
      });
      for (const name of files) {
        const file = resolve(webRoot, 'src/app', name);
        result.messages.push({ type: 'dependency', plugin: 'cafe-surface-declarations', file });
        let text = readFileSync(file, 'utf8');
        if (text.includes('@import "@cat-cafe/ui/styles.css";')) {
          const shared = resolve(webRoot, '../ui/src/styles.css');
          result.messages.push({ type: 'dependency', plugin: 'cafe-surface-declarations', file: shared });
          text = text.replace('@import "@cat-cafe/ui/styles.css";', readFileSync(shared, 'utf8'));
        }
        const source = postcss.parse(text, { from: file });
        source.walkDecls('--chat-background-role', (marker) => {
          let branch = marker.parent.clone({ nodes: [] });
          branch.append(marker.clone());
          for (let parent = marker.parent.parent; parent?.type === 'atrule'; parent = parent.parent) {
            const wrapper = parent.clone({ nodes: [] });
            wrapper.append(branch);
            branch = wrapper;
          }
          root.append(branch);
        });
      }
    }
    root.walkDecls('--chat-background-role', (marker) => {
      if (!Object.hasOwn(roles, marker.value)) throw marker.error(`Unknown Cafe surface role: ${marker.value}`);
      marker.replaceWith(
        postcss.atRule({ name: 'apply', params: `cafe-surface-${marker.value}`, source: marker.source }),
      );
    });
  },
});
module.exports.postcss = true;
