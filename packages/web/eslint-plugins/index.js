/**
 * eslint-plugin-cafe — Clowder AI design system governance rules (F056)
 */
const noHardcodedColors = require('./no-hardcoded-colors');
const noRawConsoleBorders = require('./no-raw-console-borders');

module.exports = {
  rules: {
    'no-hardcoded-colors': noHardcodedColors,
    'no-raw-console-borders': noRawConsoleBorders,
  },
};
