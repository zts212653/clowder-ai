/** The renderer's view.layout request, checked and copied before the Host places anything.
 * Moved unchanged from pet-window.cjs. */
const exactKeys = (value, allowed) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
function validCallLayout(value) {
  if (!exactKeys(value, ['presentation', 'bubble']) || !['lite', 'controls'].includes(value.presentation)) return false;
  if (value.bubble === undefined) return true;
  return (
    exactKeys(value.bubble, ['width', 'height']) &&
    Object.keys(value.bubble).length === 2 &&
    Number.isInteger(value.bubble.width) &&
    value.bubble.width >= 120 &&
    value.bubble.width <= 420 &&
    Number.isInteger(value.bubble.height) &&
    value.bubble.height >= 32 &&
    value.bubble.height <= 500
  );
}
const panelKinds = new Set([
  'none',
  'bubble',
  'actions',
  'menu',
  'chat',
  'decisions',
  'transcript',
  'settings',
  'app-assist',
  // F335 交付三：the desk bubble / list. Only a desk-line archive's command schema lets this panel through.
  'desk',
]);
const validDimension = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
function validLayoutCommand(command) {
  return (
    panelKinds.has(command.panel) &&
    validDimension(command.width, 120, 420) &&
    validDimension(command.height, 32, 500) &&
    (command.call === undefined || (command.panel === 'actions' && validCallLayout(command.call)))
  );
}
function copyPanelRequest(command) {
  if (command.panel === 'none') return undefined;
  return {
    kind: command.panel,
    width: command.width,
    height: command.height,
    ...(command.call
      ? {
          call: {
            presentation: command.call.presentation,
            ...(command.call.bubble ? { bubble: { ...command.call.bubble } } : {}),
          },
        }
      : {}),
  };
}

module.exports = { validLayoutCommand, copyPanelRequest };
