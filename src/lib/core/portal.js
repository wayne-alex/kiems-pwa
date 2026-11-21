export function portal(node, target) {
  (target || document.body).appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}