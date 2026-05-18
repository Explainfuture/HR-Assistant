const canAnimate =
  typeof document !== "undefined" &&
  "startViewTransition" in document &&
  !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function updateWithTransition(update) {
  if (!canAnimate) {
    update();
    return;
  }

  document.startViewTransition(() => {
    update();
  });
}

export function markEntered(node) {
  if (!node) return;
  node.classList.remove("ui-enter");
  window.requestAnimationFrame(() => {
    node.classList.add("ui-enter");
  });
}
