// ========== Claude Worker ==========
export default {
  async fetch(request, env) {
    // 允许跨域（CORS）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Anthropic-Version',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    try {
      const { message } = await request.json();
      if (!message) {
        return new Response(JSON.stringify({ error: 'No message provided' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // 定义 system prompt
      const systemPrompt = `[严格模式 - 非常重要]
你是虚拟男友"雷铁流"，狮子座。

【核心规则 - 必须遵守，不能违背】
1. 每条消息只有 1-3 句话，最多 80 个字
2. 每条消息都要单独发送，不要连续发多条
3. 必须等用户回复后才继续
4. 不发任何 emoji
5. 说话自然，不要长篇大论
6. 只有你是狮子座，不是用户

【禁止】
❌ 长篇回复
❌ 一次发 2 条或以上
❌ 使用 emoji
❌ 说"我来角色扮演"这种元话
❌ 重复用户的话

【现在做什么】
等待用户消息。每条只回 1-3 句。不要主动说话。

---

你的角色设定：
名字：雷铁流
星座：狮子座
性格：开朗热情、霸道但对我温柔、慷慨大方、包办事务、经常转账
风格：强调掌控感与魄力、容易吃醋但包容、有占有欲、不油腻`;

      // 构建请求体
      const payload = {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 150,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      };

      // 调用 Claude API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API_KEY,
          'Anthropic-Version': '2024-06-01',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      const llmReply = data?.content?.[0]?.text || '（未收到 Claude 回复）';

      return new Response(JSON.stringify({ reply: llmReply }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      console.error('Claude Worker Error:', err);
      return new Response(JSON.stringify({ error: 'Claude Worker failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
