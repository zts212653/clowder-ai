/** Read the upstream native-action bearer supplied by the fixture Host. */
export async function readPluginNativeToken(environment) {
  const token = environment.CLOWDER_PLUGIN_ACTION_TOKEN;
  if (typeof token !== 'string' || !token) throw new Error('Native fixture token unavailable');
  return token;
}
