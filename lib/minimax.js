/**
 * MiniMax M Plan API 客户端（HOST 侧，零依赖，只用 Node 内置 fetch）。
 *
 * 三个能力面：
 *  1. anthropicMessages —— Anthropic 兼容 /anthropic/v1/messages（文本 + 工具调用 + thinking）
 *  2. generateImages    —— /v1/image_generation（文生图，base64 直出）
 *  3. listModels        —— GET /anthropic/v1/models，用于模型名协商
 *
 * 设计要点：
 *  - 不缓存密钥；每次调用由调用方传入，便于热更新与凭据轮换。
 *  - 所有请求带超时并与外部 AbortSignal 联动，避免子代理悬挂。
 *  - 错误统一抛 MinimaxError（status / code / detail），上层据此区分限流、鉴权、额度。
 */

/**
 * MiniMax 平台错误码 → 中文说明。
 * 来自官方文档 base_resp.status_code 表；2056 是 M Plan 订阅额度相关的关键码。
 */
export const BASE_RESP_STATUS = {
  0: '成功',
  1000: '未知错误',
  1001: '请求超时',
  1002: '触发限流，请稍后再试',
  1004: '账号鉴权失败，请检查 API Key 是否正确',
  1008: '账号余额/套餐额度不足',
  1026: '输入内容涉及敏感内容，被安全策略拦截',
  1027: '输出内容涉及敏感内容，被安全策略拦截',
  1039: 'Token 超限',
  2013: '入参异常，请检查模型名与参数',
  2049: '无效的 API Key',
  2056: '超出 M Plan 资源限制，请等待下一个时间窗口恢复后再试',
};

/** 统一错误类型：status 为 HTTP 状态，code 为平台码或内部标识。 */
export class MinimaxError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.name = 'MinimaxError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 从响应体中提取平台错误。
 * Anthropic 兼容面：{ type:'error', error:{ type, message } }
 * MiniMax 原生面：{ base_resp:{ status_code, status_msg } }
 */
function platformError(status, body) {
  const base = body?.base_resp;
  if (base && typeof base.status_code === 'number' && base.status_code !== 0) {
    const zh = BASE_RESP_STATUS[base.status_code] ?? '未知错误';
    const message = `MiniMax ${base.status_code}（${zh}）${base.status_msg ? `：${base.status_msg}` : ''}`;
    return new MinimaxError(message, {
      status,
      code: String(base.status_code),
      detail: body,
    });
  }
  const apiError = body?.error;
  if (apiError) {
    const message = apiError.message || apiError.type || '未知错误';
    const code = apiError.code ?? apiError.type;
    return new MinimaxError(`MiniMax 返回错误（HTTP ${status}）：${message}`, {
      status,
      code: code === undefined ? undefined : String(code),
      detail: body,
    });
  }
  return undefined;
}

/** HTTP 状态兜底文案（有些错误不经平台包装层）。 */
function httpError(status, text) {
  const hint =
    status === 401 || status === 403
      ? '鉴权失败：请确认 MINIMAX_CN_API_KEY 是 M Plan 订阅 Key（sk-cp- 开头），而不是按量计费 Key（sk-api- 开头）。'
      : status === 429
        ? '请求过于频繁或额度耗尽：请降低并发，或检查 M Plan 套餐额度（5 小时窗口 / 周窗口）。'
        : status === 402
          ? '额度不足：M Plan 套餐用量可能已用尽。'
          : undefined;
  const trimmed = typeof text === 'string' ? text.slice(0, 600) : '';
  return new MinimaxError(
    `MiniMax HTTP ${status}${hint ? `：${hint}` : ''}${trimmed ? `\n响应：${trimmed}` : ''}`,
    { status },
  );
}

/** 解析 JSON；失败返回 undefined 以便上层给出更好的诊断。 */
async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 合并外部取消信号与内部超时。 */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)),
    timeoutMs,
  );
  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/**
 * 调用 Anthropic 兼容 Messages 接口（非流式）。
 * thinking 不显式传：M3.1-Flash 强制开启，传 disabled 会 400。
 *
 * @param {object} options
 * @param {string} options.apiKey   M Plan 订阅 Key
 * @param {string} options.baseURL  例如 https://api.minimax.cn
 * @param {string} options.model    MiniMax-M3.1-Flash(-Preview) 等
 * @param {string} [options.system] 系统提示
 * @param {Array}  options.messages Anthropic 消息数组
 * @param {Array}  [options.tools]  Anthropic 工具定义
 * @param {number} [options.maxTokens]
 * @param {string} [options.effort] low|medium|high|xhigh|max（仅 M3.1-Flash 生效）
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{content: Array, stopReason?: string, usage?: object, raw: object}>}
 */
export async function anthropicMessages({
  apiKey,
  baseURL,
  model,
  system,
  messages,
  tools,
  maxTokens = 8192,
  effort,
  signal,
  timeoutMs = 240000,
}) {
  const deadline = withDeadline(signal, timeoutMs);
  try {
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
    if (effort) body.output_config = { effort };

    let response;
    try {
      response = await fetch(`${baseURL}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.signal.aborted) {
        throw new MinimaxError(
          `调用 MiniMax 失败：${deadline.signal.reason?.message ?? '请求被取消'}`,
          { code: 'ABORTED' },
        );
      }
      throw new MinimaxError(`无法连接 MiniMax（${baseURL}）：${error.message}`, {
        code: 'NETWORK',
      });
    }

    const json = await readJson(response);
    if (!response.ok) {
      throw (
        platformError(response.status, json) ??
        httpError(response.status, JSON.stringify(json ?? ''))
      );
    }
    const error = platformError(response.status, json);
    if (error) throw error;
    if (!json || typeof json !== 'object') {
      throw new MinimaxError('MiniMax 返回了无法解析的响应体', {
        status: response.status,
        code: 'BAD_BODY',
      });
    }
    return {
      content: Array.isArray(json.content) ? json.content : [],
      stopReason: json.stop_reason,
      usage: json.usage,
      raw: json,
    };
  } finally {
    deadline.dispose();
  }
}

/** 文生图参数上限：官方要求 prompt ≤ 1500 字符，n ∈ [1,9]。 */
export const IMAGE_PROMPT_MAX = 1500;
export const IMAGE_COUNT_MAX = 9;
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '4:3',
  '3:2',
  '2:3',
  '3:4',
  '9:16',
  '21:9',
];

/**
 * 文生图：POST /v1/image_generation。
 * 固定 response_format=base64：直接拿图片字节，绕开 24 小时 URL 过期问题，
 * 也便于落盘与进入会话附件。
 *
 * 两个实测要点（见 verify/REPORT.md）：
 *  - 该接口**所有错误的 HTTP 状态都是 200**，错误只体现在 base_resp.status_code，
 *    因此绝不能只看 response.ok，必须同时检查平台码与 data 是否为空。
 *  - 单图最坏耗时可超 100 秒，超时预算必须给足（默认 180s）。
 *
 * @returns {Promise<Array<{base64?: string, url?: string}>>}
 */
export async function generateImages({
  apiKey,
  baseURL,
  model = 'image-01',
  prompt,
  aspectRatio = '1:1',
  n = 1,
  seed,
  promptOptimizer = true,
  aigcWatermark = false,
  signal,
  timeoutMs = 180000,
}) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new MinimaxError('生成图片需要非空的 prompt', { code: 'INVALID_ARGS' });
  }
  if (prompt.length > IMAGE_PROMPT_MAX) {
    throw new MinimaxError(
      `prompt 超长：MiniMax 图片接口最多 ${IMAGE_PROMPT_MAX} 字符，当前 ${prompt.length} 字符`,
      { code: 'INVALID_ARGS' },
    );
  }

  const deadline = withDeadline(signal, timeoutMs);
  try {
    const body = {
      model,
      prompt,
      aspect_ratio: aspectRatio,
      response_format: 'base64',
      n: Math.min(Math.max(1, Math.trunc(n)), IMAGE_COUNT_MAX),
      prompt_optimizer: promptOptimizer,
      aigc_watermark: aigcWatermark,
    };
    if (Number.isInteger(seed)) body.seed = seed;

    let response;
    try {
      response = await fetch(`${baseURL}/v1/image_generation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
    } catch (error) {
      if (deadline.signal.aborted) {
        throw new MinimaxError(
          `生成图片失败：${deadline.signal.reason?.message ?? '请求被取消'}`,
          { code: 'ABORTED' },
        );
      }
      throw new MinimaxError(`无法连接 MiniMax 图片接口（${baseURL}）：${error.message}`, {
        code: 'NETWORK',
      });
    }

    const json = await readJson(response);
    if (!response.ok) {
      throw (
        platformError(response.status, json) ??
        httpError(response.status, JSON.stringify(json ?? ''))
      );
    }
    const error = platformError(response.status, json);
    if (error) throw error;

    const base64 = json?.data?.image_base64;
    const urls = json?.data?.image_urls;
    if (Array.isArray(base64) && base64.length > 0) {
      // 个别网关会带 data: 前缀，统一剥掉，保证是裸 base64。
      return base64.map((value) => ({
        base64: String(value).replace(/^data:[^;]+;base64,/u, ''),
      }));
    }
    if (Array.isArray(urls) && urls.length > 0) {
      return urls.map((url) => ({ url: String(url) }));
    }
    const failed = Number(json?.metadata?.failed_count ?? 0);
    if (failed > 0) {
      throw new MinimaxError(
        `图片被内容安全策略拦截（failed_count=${failed}），请调整提示词后重试`,
        { status: response.status, code: 'CONTENT_BLOCKED', detail: json },
      );
    }
    throw new MinimaxError('MiniMax 未返回任何图片（image_base64 / image_urls 均为空）', {
      status: response.status,
      code: 'EMPTY_RESULT',
      detail: json,
    });
  } finally {
    deadline.dispose();
  }
}

/**
 * 可选的文本模型名候选（按优先级）。
 *
 * 实测结论（2026-10，见 verify/REPORT.md）：MiniMax 对**无效模型名不会报错**，
 * 而是静默回退到 MiniMax-M3。因此不能靠"调用失败再换名字"来协商，只能：
 *   1. 发一次最小请求，读响应里回显的 `model` 字段，确认实际生效的模型；
 *   2. 若回显与预期不符，按候选列表继续尝试，取第一个被平台接受的名字。
 *
 * 实测可用：MiniMax-M3.1-Flash、MiniMax-M3.1-Flash-Preview、MiniMax-M3
 *（大小写不敏感：minimax-m3.1-flash 也解析为 MiniMax-M3.1-Flash）。
 */
export function textModelCandidates(configured) {
  const list = [];
  for (const candidate of [
    configured,
    'MiniMax-M3.1-Flash',
    'MiniMax-M3.1-Flash-Preview',
    'MiniMax-M3',
  ]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !list.includes(candidate)) {
      list.push(candidate);
    }
  }
  return list;
}

/** 规范化模型名用于比较：平台大小写不敏感，且可能回显不同后缀写法。 */
function normalizeModelName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 缓存已确认可用的模型名，避免每次工具调用都多打一次探针。 */
const resolvedModelCache = new Map();

/**
 * 确认一个真正生效的文本模型名。
 *
 * 由于平台对未知模型名静默回退，这里以**响应回显的 model 字段**为准：
 * 回显与请求名规范化后一致 → 采用；否则换下一个候选。
 * 全部候选都回显成别的模型时，退回平台实际回显的模型并记录（不报错，
 * 因为任务仍可完成，只是模型不同）。
 *
 * @returns {Promise<{model: string, effective: string, fellBack: boolean}>}
 */
export async function resolveTextModel({ apiKey, baseURL, configured, signal }) {
  const cacheKey = `${baseURL}\u0000${normalizeModelName(configured)}`;
  const cached = resolvedModelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const candidates = textModelCandidates(configured);
  let effectiveFromPlatform;

  for (const model of candidates) {
    const response = await anthropicMessages({
      apiKey,
      baseURL,
      model,
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
      signal,
      timeoutMs: 60000,
    });
    const echoed = typeof response.raw?.model === 'string' ? response.raw.model : undefined;
    if (echoed === undefined) {
      // 网关不回显模型名：无法校验，信任请求名。
      const resolved = { model, effective: model, fellBack: false };
      resolvedModelCache.set(cacheKey, resolved);
      return resolved;
    }
    effectiveFromPlatform ??= echoed;
    if (normalizeModelName(echoed) === normalizeModelName(model)) {
      const resolved = { model, effective: echoed, fellBack: false };
      resolvedModelCache.set(cacheKey, resolved);
      return resolved;
    }
  }

  // 所有候选都被回退到了别的模型：接受平台实际给出的模型，但如实告知调用方。
  const fallback = effectiveFromPlatform ?? candidates.at(-1) ?? 'MiniMax-M3';
  const resolved = { model: candidates[0], effective: fallback, fellBack: true };
  resolvedModelCache.set(cacheKey, resolved);
  return resolved;
}

/** 供测试与配置界面使用：清空模型名缓存。 */
export function clearModelResolutionCache() {
  resolvedModelCache.clear();
}

/**
 * 从图片字节嗅探真实格式（不信任扩展名与网关声明）。
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|undefined}
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return undefined;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45
  ) {
    return 'image/webp';
  }
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return undefined;
}
