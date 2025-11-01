// example_worker.js
// Cloudflare Worker 示例：提供 /api/summarize 的占位实现，真实部署时请替换为向 Claude/Anthropic/其他模型的 API 调用，并保护 API key

addEventListener('fetch', event => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/summarize' && request.method === 'POST') {
    return handleSummarize(request);
  }
  return new Response('Not found', { status: 404 });
}

async function handleSummarize(request) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    // 简单占位总结：取前后几条拼接并截断
    const preview = messages.slice(0,3).map(m=>m.text).join(' | ');
    const tail = messages.slice(-3).map(m=>m.text).join(' | ');
    const summary = `自动生成摘要（占位） - 前3：${preview} ... 后3：${tail}`;
    return new Response(JSON.stringify({ summary }), { status: 200, headers: { 'Content-Type':'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type':'application/json' } });
  }
}
