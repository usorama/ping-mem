// Mermaid config
mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  securityLevel: 'loose',
});

// Zoom state per diagram
const zoomState = {};

function zoomMermaid(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  if (delta === 0) { zoomState[id] = 1; }
  else {
    zoomState[id] = Math.min(3, Math.max(0.4, (zoomState[id] || 1) + delta));
  }
  el.style.transform = `scale(${zoomState[id]})`;
  el.style.transformOrigin = 'top center';
}

function openMermaidInNewTab(wrapId) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;
  const svg = wrap.querySelector('svg');
  if (!svg) return;
  const clone = svg.cloneNode(true);
  clone.removeAttribute('height');
  clone.style.maxWidth = '100%';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{margin:0;padding:2rem;background:#08111f;display:flex;justify-content:center;}
    svg{max-width:100%;}</style></head><body>${clone.outerHTML}</body></html>`;
  const blob = new Blob([html], {type: 'text/html'});
  window.open(URL.createObjectURL(blob), '_blank');
}

// Drag-to-pan on mermaid containers
document.querySelectorAll('.mermaid-content').forEach(el => {
  let isDragging = false, startX, startY, scrollLeft, scrollTop;
  el.addEventListener('mousedown', e => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    el.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.scrollLeft -= dx;
    el.scrollTop -= dy;
    startX = e.clientX;
    startY = e.clientY;
  });
  document.addEventListener('mouseup', () => {
    isDragging = false;
    el.style.cursor = 'zoom-in';
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const wrapId = el.id;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    zoomMermaid(wrapId, delta);
  }, { passive: false });
});
