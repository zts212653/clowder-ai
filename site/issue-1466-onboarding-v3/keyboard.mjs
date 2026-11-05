export function bindKeyboard({ getState, dispatch, togglePanel, dismiss }) {
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input,textarea,select')) return;
    if (event.key.toLowerCase() === 'h') togglePanel();
    if (event.key === 'Escape') dismiss();
    if (getState().stage !== 'demo') return;
    if (event.code === 'Space') {
      event.preventDefault();
      dispatch({ type: 'pause' });
    }
    if (event.key === 'ArrowRight') dispatch({ type: 'scene', delta: 1 });
    if (event.key === 'ArrowLeft') dispatch({ type: 'scene', delta: -1 });
  });
}
