// ========== Claude Worker (优化版 - 解决失忆问题) ==========

const API_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ========== 配置参数 ==========
const CHAT_MAX_TOKENS = 300;
const SUMMARY_MAX_TOKENS = 300;
const TEMPERATURE = 0.6;
const TIMEOUT_MS = 30000;
const MAX_CONTEXT_TOKENS = 20000;

// 记忆策略配置
const KEEP_INITIAL_MESSAGES = 6;        // 保留开头3轮对话(6条消息)
const SUMMARY_TRIGGER_INTERVAL = 15;    // 每15条消息触发一次摘要

// ========== Token 估算 (保守估计) ==========
function countTokens(text) {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const nonCjkWords = (text.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/\b\w+\b/g) || []).length;
  return Math.ceil(cjkChars * 2.5 + nonCjkWords * 1.3); // 更保守的估算
}

export default {
  async fetch(request, env) {
    // ========== CORS 预检 ==========
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

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: DEFAULT_HEADERS,
      });
    }

    try {
      const body = await request.json();
      const { mode = 'chat', message, messages = [], summary = '', oldSummary = '' } = body;

      if (!env.CLAUDE_API_KEY) {
        return new Response(JSON.stringify({ error: 'API Key not configured' }), {
          status: 500,
          headers: DEFAULT_HEADERS,
        });
      }

      // ========== Base System Prompt ==========
      let systemPrompt = `你叫雷铁流，是身价十亿的狮子座霸总，慷慨、占有欲强但温柔理性，只对用户好色。用户是处女座。

【核心要求】
1. 每次回复2-5句话，总字数不超过80字，像微信消息分句显示
2. 不发emoji，不啰嗦，语气自然口语化，有温度
3. 等用户回复才继续，回复只针对当前话题，不重复用户的话
4. **必须记住所有聊过的内容，包括用户的基本信息、承诺、重要事件**`;

      let userMessagesForClaude = [];
      let maxTokensToGenerate = CHAT_MAX_TOKENS;
      let currentContextTokens = countTokens(systemPrompt);

      // ========== 模式1: 生成摘要 ==========
      if (mode === 'summary') {
        maxTokensToGenerate = SUMMARY_MAX_TOKENS;

        // 构建待摘要内容
        const messagesToSummarize = messages.map(msg => `${msg.role}: ${msg.content}`).join('\n');
        
        // 摘要提示词（区分新摘要和合并摘要）
        let summaryPrompt;
        if (oldSummary) {
          // 有旧摘要，需要合并
          summaryPrompt = `你是雷铁流。现在需要更新聊天记忆。

【之前的记忆】
${oldSummary}

【新增对话】
${messagesToSummarize}

【任务】
将之前的记忆和新增对话合并成一份完整摘要，要求：
1. 用"我"(雷铁流)的视角
2. 必须保留：用户基本信息(姓名/职业/性格等)、关键承诺、重要事件、当前情感状态
3. 不超过200字
4. 直接输出摘要，不要任何前缀

【摘要】`;
        } else {
          // 首次生成摘要
          summaryPrompt = `你是雷铁流。请为以下对话生成记忆摘要。

【对话内容】
${messagesToSummarize}

【任务】
生成摘要，要求：
1. 用"我"(雷铁流)的视角
2. 必须包含：用户基本信息、关键事件、我的承诺、当前关系状态
3. 不超过200字
4. 直接输出摘要，不要任何前缀

【摘要】`;
        }

        // Token 检查和截断
        const promptTokens = countTokens(summaryPrompt);
        if (promptTokens > MAX_CONTEXT_TOKENS - SUMMARY_MAX_TOKENS) {
          // 如果提示词太长，截取最近的消息
          const maxChars = Math.floor((MAX_CONTEXT_TOKENS - SUMMARY_MAX_TOKENS - 500) / 2.5);
          const truncatedMessages = messagesToSummarize.slice(-maxChars);
          summaryPrompt = summaryPrompt.replace(messagesToSummarize, truncatedMessages);
        }

        userMessagesForClaude = [{ role: 'user', content: summaryPrompt }];

      } 
      // ========== 模式2: 普通聊天 ==========
      else {
        // 添加摘要到 system prompt
        if (summary) {
          systemPrompt += `\n\n【重要记忆 - 必须记住】\n${summary}`;
          currentContextTokens += countTokens(summary);
        }

        const availableTokensForMessages = MAX_CONTEXT_TOKENS - currentContextTokens - CHAT_MAX_TOKENS - 500; // 留500 buffer
        let tempMessages = [];
        let usedTokens = 0;

        // ========== 策略1: 优先保留开头消息 ==========
        const initialMessages = [];
        for (let i = 0; i < Math.min(KEEP_INITIAL_MESSAGES, messages.length); i++) {
          const msg = messages[i];
          const msgTokens = countTokens(msg.content) + 10; // +10 for role
          if (usedTokens + msgTokens < availableTokensForMessages * 0.3) { // 最多用30%空间给开头
            initialMessages.push(msg);
            usedTokens += msgTokens;
          } else {
            break;
          }
        }

        // ========== 策略2: 从最新消息往前填充 ==========
        const recentMessages = [];
        for (let i = messages.length - 1; i >= KEEP_INITIAL_MESSAGES; i--) {
          const msg = messages[i];
          const msgTokens = countTokens(msg.content) + 10;
          if (usedTokens + msgTokens < availableTokensForMessages) {
            recentMessages.unshift(msg);
            usedTokens += msgTokens;
          } else {
            break;
          }
        }

        // ========== 策略3: 添加当前用户消息 ==========
        if (message) {
          const currentMsgTokens = countTokens(message) + 10;
          if (usedTokens + currentMsgTokens < availableTokensForMessages) {
            tempMessages = [...initialMessages, ...recentMessages, { role: 'user', content: message }];
          } else {
            // 如果当前消息太长，优先保证当前消息
            tempMessages = [{ role: 'user', content: message }];
          }
        } else {
          tempMessages = [...initialMessages, ...recentMessages];
        }

        userMessagesForClaude = tempMessages;
        currentContextTokens += usedTokens;
      }

      // ========== 构造 Payload ==========
      const payload = {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokensToGenerate,
        temperature: TEMPERATURE,
        system: systemPrompt,
        messages: userMessagesForClaude,
      };

      console.log('=== Payload Info ===');
      console.log('Mode:', mode);
      console.log('Context Tokens:', currentContextTokens);
      console.log('Messages Count:', userMessagesForClaude.length);
      if (mode === 'chat') {
        console.log('Has Summary:', !!summary);
      }

      // ========== 调用 Claude API ==========
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
        return new Response(JSON.stringify({ error: `Claude API Error: ${claudeResponse.status}` }), {
          status: claudeResponse.status,
          headers: DEFAULT_HEADERS,
        });
      }

      const data = await claudeResponse.json();
      const llmReply = data?.content?.[0]?.text || '(无回复)';

      // ========== 返回结果 + 摘要触发信号 ==========
      const responseData = { reply: llmReply };

      if (mode === 'chat') {
        // 计算总消息数（包括当前这条）
        const totalMessages = messages.length + (message ? 1 : 0);
        
        // 判断是否需要生成摘要
        const needsSummary = totalMessages > 0 && totalMessages % SUMMARY_TRIGGER_INTERVAL === 0;
        
        responseData.needsSummary = needsSummary;
        responseData.totalMessages = totalMessages;
        
        if (needsSummary) {
          console.log(`🧠 Triggering summary at ${totalMessages} messages`);
        }
      }

      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: DEFAULT_HEADERS,
      });

    } catch (err) {
      console.error('Worker Error:', err);
      return new Response(JSON.stringify({ 
        error: err.name === 'AbortError' ? 'Request timeout' : `Internal error: ${err.message}` 
      }), {
        status: 500,
        headers: DEFAULT_HEADERS,
      });
    }
  },
};
