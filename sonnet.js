// ========== Claude Worker (with Memory Summary) ==========

// 定义常量
const API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};
const CHAT_MAX_TOKENS = 300;
const SUMMARY_MAX_TOKENS = 200;
const TEMPERATURE = 0.7;
const TIMEOUT_MS = 30000; // 30 seconds
const MAX_MESSAGE_HISTORY = 40; // 限制最近消息条数

export default {
  async fetch(request, env) {
    // ✅ CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...DEFAULT_HEADERS,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Anthropic-Version',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ✅ 只允许 POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: DEFAULT_HEADERS,
      });
    }

    try {
      const body = await request.json();
      const { mode = 'chat', message, messages = [], summary = '' } = body;

      if (!env.CLAUDE_API_KEY) {
        return new Response(JSON.stringify({ error: 'API Key not configured in environment variables.' }), { status: 500, headers: DEFAULT_HEADERS });
      }

      if (!message && messages.length === 0 && mode !== 'summary') {
        // summary 模式可以只传 messages
        return new Response(JSON.stringify({ error: 'No valid message provided for chat mode.' }), { status: 400, headers: DEFAULT_HEADERS });
      }

      // ========== Base System Prompt ==========
      const baseSystemPrompt = `[严格模式 - 非常重要]
你是虚拟男友"雷铁流"，狮子座。

【核心规则 - 必须遵守】
1. 每次回复包含 2-5 句话，总字数不超过 80 字（自然停顿即可，不必精确计算）
2. 模仿微信消息，每句话都独立显示
3. 必须等用户回复后才继续
4. 不发 emoji，不啰嗦， 语气自然，像微信聊天，不要总结性或陈述性句子
5. 保持自然、口语化、有温度
6. 你是狮子座，对方是处女座
7. 回复只针对当前话题，不重复用户的话

【角色设定】
名字：雷铁流
设定：身价十亿的富有霸总，爱转账给用户，慷慨，只对用户好色
性格：热情、占有欲强但温柔、理性果断、习惯掌控`;

      // ========== 处理不同模式 ==========
      let userMessages = [];
      let maxTokens = CHAT_MAX_TOKENS;
      let systemPrompt = baseSystemPrompt;

      if (mode === 'summary') {
        // 🧠 生成摘要模式
        maxTokens = SUMMARY_MAX_TOKENS;
        const finalPromptContent = `
请你阅读以下对话内容，提炼出三句话以内的摘要。
要求：
1. 不超过100字
2. 说明情感关系的进展与主要话题
3. 语气自然，不写分析

对话内容：
${JSON.stringify(messages.slice(-MAX_MESSAGE_HISTORY))}
`;
        userMessages = [{ role: 'user', content: finalPromptContent }];
      } else {
        // 💬 普通聊天模式
        if (summary) {
          systemPrompt += `\n\n【上次聊天摘要】\n${summary}`;
        }
        
        userMessages = [
          ...messages.slice(-MAX_MESSAGE_HISTORY),
          { role: 'user', content: message },
        ];
      }

      // ========== 构造 payload ==========
      const payload = {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
        system: systemPrompt,
        messages: userMessages,
      };

      // ========== 超时控制 ==========
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const claudeResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          ...DEFAULT_HEADERS,
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text();
        console.error('Claude API Error:', claudeResponse.status, errText);
        return new Response(JSON.stringify({ error: `Claude API Error (${claudeResponse.status}): ${errText}` }), {
          status: claudeResponse.status,
          headers: DEFAULT_HEADERS,
        });
      }

      const data = await claudeResponse.json();
      const llmReply = data?.content?.[0]?.text || '(无回复)';

      return new Response(JSON.stringify({ reply: llmReply }), {
        status: 200,
        headers: DEFAULT_HEADERS,
      });
    } catch (err) {
      console.error('Request processing error:', err);
      return new Response(JSON.stringify({ error: `Internal Server Error: ${err.message || 'Unknown error'}` }), {
        status: 500,
        headers: DEFAULT_HEADERS,
      });
    }
  },
};
