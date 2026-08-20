// Runtime application identity.
//
// electron-builder consumes desktop/package.json's `build` block while
// packaging and does not preserve that build-only metadata for the running
// application. Keep the Windows process identity in packaged code instead.
const DESKTOP_APP_ID = 'ai.clowderai.desktop';

module.exports = { DESKTOP_APP_ID };
