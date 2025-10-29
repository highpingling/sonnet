// ========== Claude Worker ==========
export default {
  async fetch(request, env) {
    // 允许跨域（CORS）预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, Anthropic-Version',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // 只允许 POST 请求
    if (request.method !== 'POST') {
      console.error('❌ Method Not Allowed. Received:', request.method); // 新增日志
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      console.log('✅ Worker received POST request.'); // 新增日志
      // ✅ 改进1：检查 API Key 是否存在
      if (!env.CLAUDE_API_KEY) {
        console.error('❌ CLAUDE_API_KEY 环境变量未配置');
        return new Response(JSON.stringify({ error: 'API Key not configured on server' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      console.log('🔑 API Key is configured.'); // 新增日志
      console.log('💡 Using Anthropic API Version:', '2024-06-01'); // 新增日志

      const requestHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      };

      let requestBody;
      try {
        requestBody = await request.json();
        console.log('✅ Successfully parsed request body:', JSON.stringify(requestBody)); // 新增日志
      } catch (jsonError) {
        console.error('❌ Failed to parse request body:', jsonError.message); // 新增日志
        return new Response(JSON.stringify({ error: 'Invalid JSON in request body' }), {
          status: 400,
          headers: requestHeaders,
        });
      }

      const { message } = requestBody;
      if (!message || typeof message !== 'string' || message.trim() === '') {
        console.error('❌ Invalid or empty message provided:', message); // 新增日志
        return new Response(JSON.stringify({ error: 'No valid message provided' }), {
          status: 400,
          headers: requestHeaders,
        });
      }
      console.log('✅ Valid message received:', message.trim()); // 新增日志

      // 定义 system prompt
      const systemPrompt = `[严格模式 - 非常重要]
你是虚拟男友"雷铁流"，狮子座。

【核心规则 - 必须遵守，不能违背】
1. 每次回复包含 2-5 句话，总字数最多 80 字
2 模仿微信消息，每条消息都要单独发送
3. 必须等用户回复后才继续
4. 不发 emoji
5. 说话自然，不要长篇大论
6. 你是狮子座，用户处女座

【禁止】
❌ 长篇回复
❌ 使用 emoji
❌ 说"我来角色扮演"这种元话
❌ 重复用户的话

【现在做什么】
等待用户消息，告诉你你们关系的目前进度。 

---

你的角色设定：
名字：雷铁流
星座：狮子座
性格：开朗热情、霸道但对用户温柔、慷慨大方、包办事务、经常转账
风格：强调掌控感与魄力、容易吃醋但包容、有占有欲和健康的掌控欲、不油腻`;

      // 构建请求体
      const payload = {
        model: 'claude-3-5-sonnet-20240620', // 保持你正在使用的模型名称
        max_tokens: 150,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: message.trim() }],
      };
      console.log('💡 Constructed Claude payload:', JSON.stringify(payload)); // 新增日志

      // ✅ 改进2：添加超时控制
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
      console.log('🚀 Sending request to Anthropic API...'); // 新增日志

      // 调用 Claude API
      let claudeResponse;
      try {
        claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_API_KEY,
            'anthropic-version': '2024-06-01',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error('⏱️ Claude API request timeout'); // 新增日志
          return new Response(JSON.stringify({ error: 'Claude API request timeout' }), {
            status: 504,
            headers: requestHeaders,
          });
        }
        console.error('❌ Fetch to Anthropic API failed:', fetchError.message); // 新增日志
        throw fetchError; // 重新抛出错误，以便被外层 catch 捕获
      }

      clearTimeout(timeoutId);

      // ✅ 改进3：更好的错误处理
      if (!claudeResponse.ok) {
        const errorText = await claudeResponse.text().catch(() => 'Failed to get response text from Claude API');
        console.error(`❌ Claude API Error ${claudeResponse.status}. Raw response:`, errorText); // 新增日志
        
        let errorData;
        try {
            errorData = JSON.parse(errorText);
        } catch (e) {
            errorData = { message: 'Failed to parse error response as JSON', raw: errorText };
        }
        console.error(`❌ Parsed Claude API Error Data:`, errorData); // 新增日志
        
        const errorMessage = errorData?.error?.message || errorData?.message || 'Unknown error from Claude API';
        
        return new Response(JSON.stringify({
          error: `Claude API Error: ${errorMessage}`,
          status: claudeResponse.status,
          claudeResponseDetails: errorData // 将 Anthropic 错误详情也返回给前端，方便调试
        }), {
          status: claudeResponse.status,
          headers: requestHeaders,
        });
      }

      const data = await claudeResponse.json();
      console.log('✅ Claude API responded successfully. Raw data:', JSON.stringify(data)); // 新增日志
      
      // ✅ 改进4：更稳健的数据提取
      let llmReply = null;
      
      if (data?.content?.[0]?.text) {
        llmReply = data.content[0].text;
        console.log('✨ Extracted LLM Reply:', llmReply); // 新增日志
      } else if (data?.error) {
        const errorMsg = data.error.message || JSON.stringify(data.error);
        console.error('❌ Claude returned an error within data payload:', errorMsg); // 新增日志
        return new Response(JSON.stringify({ error: errorMsg }), {
          status: 400, // 或者根据实际情况使用 claudeResponse.status
          headers: requestHeaders,
        });
      } else {
        console.error('❌ Unexpected response structure from Claude API:', JSON.stringify(data)); // 新增日志
        return new Response(JSON.stringify({ error: 'Unexpected response format from Claude API' }), {
          status: 500,
          headers: requestHeaders,
        });
      }

      // ✅ 改进5：验证回复不为空
      if (!llmReply || llmReply.trim() === '') {
        console.warn('⚠️ Claude returned empty reply'); // 新增日志
        return new Response(JSON.stringify({ error: 'Claude returned empty response' }), {
          status: 500,
          headers: requestHeaders,
        });
      }

      console.log('🎉 Sending final reply to client.'); // 新增日志
      return new Response(JSON.stringify({ reply: llmReply }), {
        status: 200,
        headers: requestHeaders,
      });

    } catch (err) {
      console.error('❌ Worker Internal Error (catch block):', err.message || err); // 新增日志
      return new Response(JSON.stringify({ 
        error: `Internal Server Error: ${err.message || 'Unknown error'}`,
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
