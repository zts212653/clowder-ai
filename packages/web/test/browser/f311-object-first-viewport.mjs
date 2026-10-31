/** Device frame only. The iframe loads the actual Next Thread route and F307 components. */
export function objectFirstViewportHtml({ duck, memory }) {
  const target = (projection) =>
    `/thread/thread-f311-workspace-contract?evolutionProgram=${encodeURIComponent(projection.program.programId)}&evolutionView=judgment`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>F311 对象优先 · 隔离真实壳预览</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4f0ea;color:#302b26;font:14px/1.5 system-ui,sans-serif}header{padding:12px 16px;background:#fff;border-bottom:1px solid #d7cbbf}h1{margin:0;font-size:16px}p{margin:5px 0 10px;color:#685e54}nav{display:flex;gap:8px;flex-wrap:wrap}button{padding:6px 12px;background:#fff;border:1px solid #cbbbab;border-radius:6px;color:inherit;cursor:pointer}button[aria-pressed=true]{background:#f5e2d0;border-color:#94653d}.frame{overflow:auto;padding:12px}iframe{box-sizing:content-box;display:block;border:1px solid #ccbbaa;background:#fff;width:100%;height:calc(100vh - 160px);min-height:420px;margin:auto}output{display:block;color:#685e54;font-size:12px;margin-top:6px}
</style>
<header><h1>对象优先 · 隔离修订预览</h1><p>真实 Chat / F307 组件；内容为待审修订稿和冻结原文快照。不连接生产数据。首次打开请点「准备」。</p>
<nav aria-label="预览案例"><button data-case="duck" aria-pressed="true">鸭鸭</button><button data-case="memory" aria-pressed="false">记忆检索反例</button>
<button data-width="auto" aria-pressed="true">可用宽度</button><button data-width="416" aria-pressed="false">416px</button><button data-width="320" aria-pressed="false">320px</button></nav><output id="size">可用宽度</output></header>
<main class="frame"><iframe title="真实 Chat/F307 预览" src="${target(duck)}"></iframe></main>
<script>
const paths=${JSON.stringify({ duck: target(duck), memory: target(memory) })};
const frame=document.querySelector('iframe');
document.querySelectorAll('[data-case]').forEach(button=>button.addEventListener('click',()=>{
 frame.src=paths[button.dataset.case];
 document.querySelectorAll('[data-case]').forEach(peer=>peer.setAttribute('aria-pressed',String(peer===button)));
}));
document.querySelectorAll('[data-width]').forEach(button=>button.addEventListener('click',()=>{
 frame.style.width=button.dataset.width==='auto'?'100%':button.dataset.width+'px';
 document.querySelectorAll('[data-width]').forEach(peer=>peer.setAttribute('aria-pressed',String(peer===button)));
}));
new ResizeObserver(()=>{document.querySelector('output').textContent='实际 iframe 视口：'+frame.clientWidth+'px';}).observe(frame);
</script></html>`;
}
