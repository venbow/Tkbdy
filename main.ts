import { serve } from "https://deno.land/std/http/server.ts";

/**
 * 存储在 Deno KV 中的 token 信息
 */
interface TokenInfo {
  token: string;        // 当前可用的访问令牌
  refreshToken: string; // 用于刷新访问令牌的刷新令牌
  expiresAt: number;    // 访问令牌的过期时间戳
}

/**
 * Thinkbuddy API 返回的模型信息格式
 */
interface ThinkbuddyModel {
  category: string;
  creator: string;
  dataFreshness: string;
  description: string;
  isActive: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  model: string;
  name: string;
  releaseDate: string;
  responseSpeed: number;
  supportedOpenAIParams: string[];
  supportsAssistantPrefill: boolean;
  supportsFunctionCalling: boolean;
  supportsSystemMessages: boolean | null;
  supportsVision: boolean;
}

/**
 * 转换后的 OpenAI 兼容的模型信息格式
 */
interface OpenAIModel {
  id: string;
  created: number;
  object: string;
  owned_by: string;
  permission: unknown[];
  root: string;
  parent: string | null;
}

// 初始化 Deno KV 用于存储 token
const kv = await Deno.openKv();

/**
 * 注册新用户并获取 token
 * 在以下情况下调用：
 * 1. 首次使用 apiKey
 * 2. token 刷新失败需要重新注册
 * 
 * @param apiKey - Firebase API 密钥
 * @returns 包含 token 信息的对象
 * @throws 注册失败时抛出错误
 */
async function registerUser(apiKey: string): Promise<TokenInfo> {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        returnSecureToken: true,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to register user: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    token: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + parseInt(data.expiresIn) * 1000, // 将秒转换为毫秒
  };
}

/**
 * 刷新已有的 token
 * 在 token 即将过期时（5分钟内）调用
 * 
 * @param apiKey - Firebase API 密钥
 * @param refreshToken - 用于刷新的 token
 * @returns 新的 token 信息
 * @throws 刷新失败时抛出错误
 */
async function refreshToken(apiKey: string, refreshToken: string): Promise<TokenInfo> {
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to refresh token: ${response.statusText}`);
  }

  const data = await response.json();
  return {
    token: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000, // 将秒转换为毫秒
  };
}

/**
 * 获取有效的访问令牌
 * token 管理的核心逻辑：
 * 1. 检查是否有缓存的 token
 * 2. 如果没有，注册新用户
 * 3. 如果有但即将过期，刷新 token
 * 4. 如果刷新失败，重新注册
 * 
 * @param apiKey - API 密钥
 * @returns 有效的访问令牌
 * @throws token 管理失败时抛出错误
 */
async function getValidToken(apiKey: string): Promise<string> {
  const tokenInfo = await kv.get<TokenInfo>([apiKey]);
  
  try {
    // 检查 token 是否存在或是否在 5 分钟内过期
    if (!tokenInfo.value || Date.now() >= tokenInfo.value.expiresAt - 300000) {
      const newTokenInfo = tokenInfo.value
        ? await refreshToken(apiKey, tokenInfo.value.refreshToken)
        : await registerUser(apiKey);
      
      await kv.set([apiKey], newTokenInfo);
      return newTokenInfo.token;
    }

    return tokenInfo.value.token;
  } catch (error) {
    // 如果 token 刷新失败，尝试重新注册
    if (error.message.includes("Failed to refresh token")) {
      const newTokenInfo = await registerUser(apiKey);
      await kv.set([apiKey], newTokenInfo);
      return newTokenInfo.token;
    }
    throw error;
  }
}

/**
 * 处理 /models 接口请求
 * 获取 Thinkbuddy 的模型列表并转换为 OpenAI 格式
 * 
 * @param apiKey - API 密钥
 * @returns 模型列表响应
 * @throws 获取模型失败时抛出错误
 */
async function handleModels(apiKey: string): Promise<Response> {
  const token = await getValidToken(apiKey);
  const response = await fetch("https://api.thinkbuddy.ai/v1/chat/models", {
    headers: {
      "Authorization": `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`);
  }

  const data = await response.json();
  // 将 Thinkbuddy 模型格式转换为 OpenAI 格式
  const models = data.models.map((model: ThinkbuddyModel): OpenAIModel => ({
    id: model.model,
    created: Date.parse(model.releaseDate) / 1000,
    object: "model",
    owned_by: model.creator,
    permission: [],
    root: model.model,
    parent: null,
  }));

  return new Response(JSON.stringify({
    object: "list",
    data: models,
  }), {
    headers: {
      "content-type": "application/json",
    },
  });
}

/**
 * 处理 /chat/completions 接口请求
 * 转发聊天请求并处理响应
 * 支持普通响应和流式响应两种模式
 * 
 * @param req - 客户端请求
 * @param apiKey - API 密钥
 * @returns 聊天完成响应
 * @throws 请求失败时抛出错误
 */
async function handleChatCompletions(
  req: Request,
  apiKey: string,
): Promise<Response> {
  const token = await getValidToken(apiKey);
  const body = await req.json();
  const isStream = body.stream === true;

  const response = await fetch("https://api.thinkbuddy.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Failed to get chat completion: ${response.statusText}`);
  }

  // 对于非流式响应，直接转发
  if (!isStream) {
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("content-type", "application/json");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  // 处理流式响应
  const responseHeaders = new Headers();
  responseHeaders.set("content-type", "text/event-stream");
  responseHeaders.set("cache-control", "no-cache");
  responseHeaders.set("connection", "keep-alive");

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();

      if (!reader) {
        controller.close();
        return;
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            break;
          }

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.trim() === "") continue;
            if (!line.startsWith("data: ")) continue;

            const data = JSON.parse(line.slice(6));
            if (data === "[DONE]") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            // 确保响应格式符合 OpenAI API 规范
            if (data.choices?.[0]?.delta === undefined) {
              data.choices[0].delta = {};
            }
            // 将 text 字段转换为 content 字段
            if (data.choices?.[0]?.delta?.content === undefined && data.choices?.[0]?.text) {
              data.choices[0].delta.content = data.choices[0].text;
              delete data.choices[0].text;
            }

            // 处理完成标志
            if (data.choices?.[0]?.finish_reason) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
              return;
            }

            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }
        }
      } catch (error) {
        console.error("Stream processing error:", error);
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: responseHeaders,
  });
}

// 启动服务器
serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const authHeader = req.headers.get("authorization");
    
    // 验证认证头
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({
        error: {
          message: "Missing or invalid authorization header",
          type: "invalid_request_error",
          code: "invalid_api_key",
        }
      }), { 
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }

    const apiKey = authHeader.slice(7);
    // 同时支持 /api/v1 和 /api 路径
    const path = url.pathname.replace(/^\/api\/v1/, "/api");

    // 路由到对应的处理函数
    if (path === "/api/models") {
      return await handleModels(apiKey);
    } else if (path === "/api/chat/completions") {
      return await handleChatCompletions(req, apiKey);
    }

    // 处理未知路由
    return new Response(JSON.stringify({
      error: {
        message: "Invalid API route",
        type: "invalid_request_error",
        code: "route_not_found",
      }
    }), { 
      status: 404,
      headers: { "content-type": "application/json" }
    });
  } catch (error) {
    // 使用 OpenAI 兼容的格式处理错误
    console.error(error);
    return new Response(JSON.stringify({
      error: {
        message: error.message,
        type: "api_error",
        code: "internal_error",
      }
    }), { 
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
}); 