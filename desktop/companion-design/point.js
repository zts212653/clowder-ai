document.addEventListener('click', (event) => window.pointDesign.select(event.clientX, event.clientY));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.pointDesign.cancel();
});
