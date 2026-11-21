/**
 * eslint-plugin-cafe — Clowder AI design system governance rules (F056)
 */
const noHardcodedColors = require('./no-hardcoded-colors');

module.exports = {
  rules: {
    'no-hardcoded-colors': noHardcodedColors,
  },
};
