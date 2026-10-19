/**
 * @local/dsh-minimax-mplan
 *
 * 把 MiniMax M Plan 订阅 API 接进 DeepSeek Harness，让主代理（DeepSeek）把
 * 细分工作交给 MiniMax 子代理执行，并获得 MiniMax 的图像生成能力。
 *
 * 暴露的能力：
 *  1. 工具 `minimax_delegate` —— 把一段自包含任务丢给 MiniMax 代理；该代理在
 *     宿主侧带工具循环执行，可自行生成图片、读写工作区文件、列目录。
 *  2. 工具 `minimax_generate_image` —— 直接文生图，图片经 attachment 服务进入
 *     会话，模型可直接看到，用户也能在对话中查看。
 *  3. 可选：向 `ctx.subagents` 注册名为 `minimax` 的 SubagentProvider，供官方
 *     `@deepseek-ai/dsh-tool-subagent` 以 `provider: minimax` 挂原生委托工具。
 *
 * 依赖策略：**零运行时依赖**。只用 node: 内置模块与 DSH 通过 ctx 注入的服务，
 * 不静态 import 任何 @deepseek-ai/* 包。这样插件在任何 profile、任何 DSH 版本
 * 上都能加载，不依赖宿主的包解析结果（宿主 profile 的 node_modules 不保证
 * 能解析到这些包）。工具定义因此手写为符合 dsh-tools 校验的 JSON Schema
 *（output 必须含 schema + render）。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';

import {
  IMAGE_ASPECT_RATIOS,
  MinimaxError,
  anthropicMessages,
  generateImages,
  resolveTextModel,
} from './minimax.js';
import { persistImage } from './image.js';

/** Cordis 插件名。 */
export const name = 'minimax-mplan';

/** 硬依赖：注册工具、解析凭据。其余服务按需 ctx.get() 可选降级。 */
export const inject = ['tools', 'credentials'];

/** 全部可配置字段的说明表：同时驱动文档与设置界面的兜底渲染。 */
export const FIELD_DESCRIPTIONS = {
  apiKey:
    'M Plan 订阅 Key（sk-cp- 开头）。填这里即可直接使用；留空则回退到 DSH 凭据或环境变量。' +
    '该字段已标记为 secret：读回时会脱敏，不会以明文过网。',
  apiKeyEnv: '凭据引用名（环境变量名），当上面的 apiKey 留空时使用。',
  baseURL: 'MiniMax API 根地址，中国区默认 https://api.minimax.cn。',
  textModel: '文本模型 id。平台对未知模型名会静默回退，插件会核验响应回显的模型名。',
  imageModel: '图片模型 id：image-01（通用）或 image-01-live（支持画风）。',
  reasoningEffort: '思考深度。越高越慢越贵，但复杂任务更稳。仅 MiniMax-M3.1-Flash 生效。',
  maxTokens: '单次回复最大生成 token（含 thinking）。太小会被 thinking 吃光导致空输出。',
  maxTurns: 'MiniMax 子代理的工具循环最多轮数。',
  delegateToolName: '委派工具的模型可见名称。',
  imageToolName: '出图工具的模型可见名称。',
  registerSubagentProvider: '是否注册名为 minimax 的 subagent 提供方。',
  allowWorkspaceWrites: '允许 MiniMax 子代理在工作目录内写文件。',
};

/**
 * 配置 schema：**用 schemastery 定义**。
 *
 * 这不是随意选择 —— DSH 的设置界面（`dsh-settings` 的 `volatileForm()`）
 * 只把 `meta.volatile === true` 的字段投影成表单控件；而 `role('secret')`
 * 让密钥字段在 `describe({ redactSecrets: true })` 时被脱敏。
 * 两者都是 schemastery 的 meta 能力，所以要让用户在设置里填 Key，
 * Config 必须是 schemastery schema。
 *
 * 为了让插件在**没有** schemastery 的 profile 里也能加载，加载失败时退回
 * 一个等价的、手写的 standard-schema 实现（见 `validateFallback`）。
 * 两条路径的字段集合与默认值必须保持一致。
 */

/** 字段默认值（两条实现路径共用，避免漂移）。 */
const FIELD_DEFAULTS = {
  apiKey: '',
  apiKeyEnv: 'MINIMAX_CN_API_KEY',
  baseURL: 'https://api.minimax.cn',
  textModel: 'MiniMax-M3.1-Flash',
  imageModel: 'image-01',
  reasoningEffort: 'max',
  maxTokens: 32768,
  maxTurns: 12,
  delegateToolName: 'minimax_delegate',
  imageToolName: 'minimax_generate_image',
  registerSubagentProvider: true,
  allowWorkspaceWrites: true,
};

const ENUMS = {
  imageModel: ['image-01', 'image-01-live'],
  reasoningEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/**
 * 兜底 schema：schemastery 版本过旧（<3.18.3，没有 `.volatile()`）时使用。
 *
 * 仍用同一份 schemastery 构造原生 Schema（保留 `Symbol.for('schemastery')`
 * 标记、`type`、`meta`、`dict`），只是改为**手工设置 meta** 而不调用
 * `.volatile()`。这样：
 *  - DSH 的 `isNativeConfigSchema()` 认它（需要那个符号标记）；
 *  - dsh-settings 的 `volatileForm()` 能读到 `schema.dict` 与 `meta.volatile`；
 *  - Cordis 的 `~standard.validate` 正常工作。
 *
 * 如果 schemastery 完全不可用，返回纯对象实现（设置界面无法生成表单，但插件可用）。
 */
function buildFallbackSchema(z) {
  /** 给一个 schema 打上 volatile 标记（等价于 .volatile() 的效果）。 */
  const markVolatile = (schema, extra = {}) => {
    // schemastery 的 Schema 是普通对象，meta 可变；用 Object.assign 复制一份避免共享。
    const clone = Object.assign(Object.create(Object.getPrototypeOf(schema)), schema, {
      meta: { ...schema.meta, volatile: true, ...extra },
    });
    return clone;
  };

  const field = (key, schema) =>
    markVolatile(schema.default(FIELD_DEFAULTS[key]).description(FIELD_DESCRIPTIONS[key]), {
      ...key === 'apiKey' ? { role: 'secret' } : {},
    });

  const dict = {
    apiKey: z.string(),
    apiKeyEnv: z.string(),
    baseURL: z.string(),
    textModel: z.string(),
    imageModel: z.union([z.const('image-01'), z.const('image-01-live')]),
    reasoningEffort: z.union([
      z.const('low'),
      z.const('medium'),
      z.const('high'),
      z.const('xhigh'),
      z.const('max'),
    ]),
    maxTokens: z.number().min(256).step(1),
    maxTurns: z.number().min(1).max(64).step(1),
    delegateToolName: z.string(),
    imageToolName: z.string(),
    registerSubagentProvider: z.boolean(),
    allowWorkspaceWrites: z.boolean(),
  };

  return z.object(
    Object.fromEntries(
      Object.entries(dict).map(([key, schema]) => [key, field(key, schema)]),
    ),
  );
}

/**
 * 最末兜底：schemastery 完全不可用时，只满足 Cordis 的 `~standard.validate`。
 * 这条路径下设置界面不会生成表单，但插件仍可加载运行。
 */
const minimalFallbackSchema = {
  '~standard': {
    version: 1,
    vendor: 'dsh-minimax-mplan-fallback',
    validate: (raw) => validateFallback(raw),
  },
};

/**
 * 兜底校验：补齐默认值、拒绝未知字段与越界值。
 * 与 schemastery 路径的字段集合必须一致。
 */
function validateFallback(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const issues = [];
  const value = { ...FIELD_DEFAULTS };

  for (const [key, provided] of Object.entries(input)) {
    if (!(key in FIELD_DEFAULTS)) {
      issues.push({ path: [key], message: `未知配置字段 "${key}"` });
      continue;
    }
    const expected = typeof FIELD_DEFAULTS[key];
    if (typeof provided !== expected) {
      issues.push({ path: [key], message: `${key} 应为 ${expected}` });
      continue;
    }
    if (ENUMS[key] !== undefined && !ENUMS[key].includes(provided)) {
      issues.push({ path: [key], message: `${key} 只接受 ${ENUMS[key].join(' | ')}` });
      continue;
    }
    if (key === 'maxTurns' && (!Number.isInteger(provided) || provided < 1 || provided > 64)) {
      issues.push({ path: [key], message: 'maxTurns 应为 1-64 的整数' });
      continue;
    }
    if (key === 'maxTokens' && (!Number.isInteger(provided) || provided < 256)) {
      issues.push({ path: [key], message: 'maxTokens 应为不小于 256 的整数' });
      continue;
    }
    value[key] = provided;
  }
  return issues.length > 0 ? { issues } : { value };
}

/**
 * 配置 schema（导出给 Cordis）。
 *
 * 关键机制（读 schemastery 3.18.4、dsh-settings、dsh-app-boot 源码确认）：
 *
 *  - DSH 设置界面（`dsh-settings` 的 `volatileForm()`）**只**把
 *    `meta.volatile === true` 的字段投影成表单控件；它读的是 **Schema 对象本身**
 *    的 `.dict` / `.meta`，不是 `toJSON()` 的结果。所以必须是原生 schemastery
 *    Schema，纯对象做不到。
 *  - `dsh-app-boot` 的 `isNativeConfigSchema()` 还要求
 *    `Symbol.for('schemastery') === true` 且 `type` 是字符串 —— 这是"能不能在
 *    设置里配置"的开关。
 *  - `.role('secret')` 让字段在 `describe({ redactSecrets: true })` 时被脱敏。
 *  - 注意 `.volatile()` 还有一层语义：该字段**不参与值解析**，Cordis 走
 *    `~standard.validate` 拿到的是原始值（实测确认），但直接调用
 *    `Config(raw)` 会得到 cosmokit 惰性 jar。我们只依赖前者，并对后者做兼容
 *    解包（见 `unwrap`）。
 *
 * schemastery 不可用或版本过旧（<3.18.3 没有 `.volatile()`）时，
 * 用同一份 schemastery 构造原生 Schema 并手工打 meta 标记（`buildFallbackSchema`）。
 */
export const Config = await (async () => {
  let z;
  try {
    const mod = await import('@deepseek-ai/schemastery');
    z = mod.default ?? mod;
  } catch {
    // schemastery 完全不可用：插件仍可加载，但设置界面无法生成表单。
    return minimalFallbackSchema;
  }

  // 优先走标准写法；旧版 schemastery 没有 .volatile() 时退回手工打标。
  try {
    return z.object({
      // 每个字段都必须 volatile，否则设置界面看不到它。
      apiKey: z
        .string()
        .default(FIELD_DEFAULTS.apiKey)
        .description(FIELD_DESCRIPTIONS.apiKey)
        .role('secret')
        .volatile(),
      apiKeyEnv: z
        .string()
        .default(FIELD_DEFAULTS.apiKeyEnv)
        .description(FIELD_DESCRIPTIONS.apiKeyEnv)
        .volatile(),
      baseURL: z.string().default(FIELD_DEFAULTS.baseURL).description(FIELD_DESCRIPTIONS.baseURL).volatile(),
      textModel: z
        .string()
        .default(FIELD_DEFAULTS.textModel)
        .description(FIELD_DESCRIPTIONS.textModel)
        .volatile(),
      imageModel: z
        .union([z.const('image-01'), z.const('image-01-live')])
        .default(FIELD_DEFAULTS.imageModel)
        .description(FIELD_DESCRIPTIONS.imageModel)
        .volatile(),
      reasoningEffort: z
        .union([
          z.const('low'),
          z.const('medium'),
          z.const('high'),
          z.const('xhigh'),
          z.const('max'),
        ])
        .default(FIELD_DEFAULTS.reasoningEffort)
        .description(FIELD_DESCRIPTIONS.reasoningEffort)
        .volatile(),
      maxTokens: z
        .number()
        .min(256)
        .step(1)
        .default(FIELD_DEFAULTS.maxTokens)
        .description(FIELD_DESCRIPTIONS.maxTokens)
        .volatile(),
      maxTurns: z
        .number()
        .min(1)
        .max(64)
        .step(1)
        .default(FIELD_DEFAULTS.maxTurns)
        .description(FIELD_DESCRIPTIONS.maxTurns)
        .volatile(),
      delegateToolName: z
        .string()
        .default(FIELD_DEFAULTS.delegateToolName)
        .description(FIELD_DESCRIPTIONS.delegateToolName)
        .volatile(),
      imageToolName: z
        .string()
        .default(FIELD_DEFAULTS.imageToolName)
        .description(FIELD_DESCRIPTIONS.imageToolName)
        .volatile(),
      registerSubagentProvider: z
        .boolean()
        .default(FIELD_DEFAULTS.registerSubagentProvider)
        .description(FIELD_DESCRIPTIONS.registerSubagentProvider)
        .volatile(),
      allowWorkspaceWrites: z
        .boolean()
        .default(FIELD_DEFAULTS.allowWorkspaceWrites)
        .description(FIELD_DESCRIPTIONS.allowWorkspaceWrites)
        .volatile(),
      });
  } catch {
    // 旧版 schemastery 没有 .volatile()：用同一份 z 构造原生 Schema，
    // 手工打 volatile/secret 标记，效果等价（设置界面照样能生成表单）。
    return buildFallbackSchema(z);
  }
})();

/**
 * 从 volatile jar 或普通值中取出真实值。
 * volatile 字段解析后是 `{ get() }` 惰性对象；普通字段是原始值。
 */
function unwrap(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const inner = value.get();
      return inner === undefined ? fallback : inner;
    } catch {
      return fallback;
    }
  }
  return value === undefined ? fallback : value;
}

/** 生效配置：把 volatile 字段解包，补默认值并做边界收敛。 */
function resolveConfig(config) {
  const raw = config ?? {};
  const pick = (key) => unwrap(raw[key], FIELD_DEFAULTS[key]);
  const scalar = (value, fallback) =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : fallback;

  return {
    apiKey: typeof pick('apiKey') === 'string' ? pick('apiKey').trim() : '',
    apiKeyEnv: scalar(pick('apiKeyEnv'), FIELD_DEFAULTS.apiKeyEnv),
    baseURL: String(scalar(pick('baseURL'), FIELD_DEFAULTS.baseURL)).replace(/\/+$/u, ''),
    textModel: scalar(pick('textModel'), FIELD_DEFAULTS.textModel),
    imageModel: scalar(pick('imageModel'), FIELD_DEFAULTS.imageModel),
    reasoningEffort: scalar(pick('reasoningEffort'), FIELD_DEFAULTS.reasoningEffort),
    maxTokens: Number.isFinite(pick('maxTokens')) ? pick('maxTokens') : FIELD_DEFAULTS.maxTokens,
    maxTurns: Number.isFinite(pick('maxTurns'))
      ? Math.max(1, Math.trunc(pick('maxTurns')))
      : FIELD_DEFAULTS.maxTurns,
    delegateToolName: scalar(pick('delegateToolName'), FIELD_DEFAULTS.delegateToolName),
    imageToolName: scalar(pick('imageToolName'), FIELD_DEFAULTS.imageToolName),
    registerSubagentProvider: pick('registerSubagentProvider') !== false,
    allowWorkspaceWrites: pick('allowWorkspaceWrites') !== false,
  };
}

/**
 * 解析 API Key。三级回退，优先级从高到低：
 *  1. 配置里的 `apiKey`（明文，适合快速试用；会存进配置文件）
 *  2. DSH 凭据服务里的 `apiKeyEnv` 引用（推荐）
 *  3. 同名环境变量
 */
async function resolveApiKey(ctx, resolved) {
  if (typeof resolved.apiKey === 'string' && resolved.apiKey.trim().length > 0) {
    return resolved.apiKey.trim();
  }
  const credentials = ctx?.get?.('credentials');
  if (credentials !== undefined) {
    const found = await credentials.resolve(resolved.apiKeyEnv);
    if (found?.value) return found.value;
  }
  const ambient = process.env[resolved.apiKeyEnv];
  if (ambient && ambient.length > 0) return ambient;
  throw new MinimaxError(
    `未配置 MiniMax API Key。三种填法任选其一：\n` +
      `  1) 在插件配置里设置 "apiKey": "sk-cp-..."（最简单，但会存进配置文件）\n` +
      `  2) 在 DSH 凭据中配置 "${resolved.apiKeyEnv}"（推荐，不落明文）\n` +
      `  3) 设置同名环境变量 ${resolved.apiKeyEnv}\n` +
      `Key 需为 M Plan 订阅 Key（sk-cp- 开头），不是按量计费 Key（sk-api- 开头）。`,
    { code: 'MISSING_CREDENTIAL' },
  );
}

/**
 * 取会话工作目录。
 * 优先用官方的 workingDirectory 服务（签名 ensure(agent, signal?)），
 * 回退到 exec.agent.session.header.cwd（Session 头里记录的 cwd），
 * 最后才是进程 cwd。
 */
async function resolveCwd(ctx, exec) {
  const agent = exec?.agent;
  const workingDirectory = ctx.get('workingDirectory');
  if (workingDirectory !== undefined && agent !== undefined) {
    try {
      const dir = await workingDirectory.ensure(agent, exec?.signal);
      if (typeof dir === 'string' && dir.length > 0) return dir;
    } catch {
      // 继续走回退。
    }
  }
  const sessionCwd = agent?.session?.header?.cwd;
  if (typeof sessionCwd === 'string' && sessionCwd.length > 0) return sessionCwd;
  return process.cwd();
}

/** 阻止路径逃逸出工作目录。 */
function safeResolve(cwd, relPath) {
  const target = resolvePath(cwd, relPath ?? '.');
  const rel = relative(cwd, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径越界：${relPath ?? '.'} 不在工作目录内`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// MiniMax 子代理的工具循环
// ---------------------------------------------------------------------------

/** 子代理可用的工具（Anthropic tools 格式）。 */
function subagentTools(resolved) {
  const tools = [
    {
      name: 'generate_image',
      description:
        '根据文本提示生成图片并保存到工作区。需要视觉素材、插画、示意图、封面时使用。',
      input_schema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '图片描述，尽量具体（主体、风格、构图、光线），最多 1500 字符。',
          },
          aspect_ratio: {
            type: 'string',
            enum: IMAGE_ASPECT_RATIOS,
            description: '宽高比，默认 1:1。',
          },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'list_dir',
      description: '列出工作目录下某个相对路径的文件与子目录。',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对路径，默认 "."。' } },
      },
    },
    {
      name: 'read_file',
      description: '读取工作目录内某个相对路径的文本文件。',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作目录的文件路径。' } },
        required: ['path'],
      },
    },
  ];
  if (resolved.allowWorkspaceWrites) {
    tools.push({
      name: 'write_file',
      description: '把文本内容写入工作目录内的文件（覆盖或新建）。用于产出交付物。',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径。' },
          content: { type: 'string', description: '完整文件内容。' },
        },
        required: ['path', 'content'],
      },
    });
  }
  return tools;
}

/** 执行子代理的一次工具调用。 */
async function runSubagentTool(call, { ctx, resolved, apiKey, cwd }) {
  const args = call.input ?? {};
  switch (call.name) {
    case 'generate_image': {
      const results = await generateImages({
        apiKey,
        baseURL: resolved.baseURL,
        model: resolved.imageModel,
        prompt: String(args.prompt ?? ''),
        aspectRatio: args.aspect_ratio ?? '1:1',
        n: 1,
      });
      const attachments = ctx.get('attachments');
      const lines = [];
      for (const item of results) {
        if (item.base64 === undefined) continue;
        const persisted = await persistImage({
          attachments,
          cwd,
          base64: item.base64,
          name: `minimax-${Date.now()}`,
        });
        lines.push(
          persisted.kind === 'attachment'
            ? `图片已生成并存入会话附件（attachmentId=${persisted.ref.attachmentId}）。`
            : `图片已保存：${persisted.file}`,
        );
      }
      return lines.join('\n') || '图片生成未返回结果。';
    }
    case 'list_dir': {
      const target = safeResolve(cwd, args.path);
      const entries = await readdir(target, { withFileTypes: true });
      return (
        entries
          .slice(0, 200)
          .map((entry) => `${entry.isDirectory() ? '[目录]' : '[文件]'} ${entry.name}`)
          .join('\n') || '(空目录)'
      );
    }
    case 'read_file': {
      const target = safeResolve(cwd, args.path);
      const text = await readFile(target, 'utf8');
      return text.length > 60000 ? `${text.slice(0, 60000)}\n...(已截断)` : text;
    }
    case 'write_file': {
      const target = safeResolve(cwd, args.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, String(args.content ?? ''), 'utf8');
      return `已写入：${args.path}`;
    }
    default:
      return `未知工具：${call.name}`;
  }
}

/**
 * 跑一次完整委派：MiniMax 作为带工具循环的子代理执行任务。
 * @returns {Promise<{text: string, turns: number, usages: object[], model: string, fellBack: boolean}>}
 */
async function runMinimaxAgent({ ctx, resolved, apiKey, cwd, prompt, maxTurns, signal }) {
  const resolution = await resolveTextModel({
    apiKey,
    baseURL: resolved.baseURL,
    configured: resolved.textModel,
    signal,
  });
  const model = resolution.model;

  const tools = subagentTools(resolved);
  const messages = [{ role: 'user', content: prompt }];
  const usages = [];
  let lastText = '';

  const system = [
    '你是由 MiniMax 驱动的执行型子代理，受主代理（DeepSeek）委派完成明确的细分任务。',
    '要求：',
    '1. 直接执行，不要反问；缺少的信息做合理假设并在结论中说明。',
    '2. 需要视觉素材时调用 generate_image；需要读写文件时调用对应工具。',
    '3. 完成后用简洁中文给出结论：做了什么、产出在哪里、关键结果。',
    `4. 工作目录：${cwd}。`,
  ].join('\n');

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await anthropicMessages({
      apiKey,
      baseURL: resolved.baseURL,
      model,
      system,
      messages,
      tools,
      maxTokens: resolved.maxTokens,
      effort: resolved.reasoningEffort,
      signal,
    });
    if (response.usage) usages.push(response.usage);

    const blocks = response.content;
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    if (texts.length > 0) lastText = texts.join('\n');

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // 实测坑：max_tokens 太小会被 thinking 吃光，表现为 stop_reason=max_tokens
      // 且没有任何文本输出。这里给出可操作的诊断，而不是返回空字符串。
      const exhausted = response.stopReason === 'max_tokens' && lastText.length === 0;
      return {
        text: exhausted
          ? `MiniMax 思考过程耗尽了 max_tokens（${resolved.maxTokens}），没有产出正文。` +
            '请调大 maxTokens 配置，或把任务拆得更小。'
          : lastText,
        turns: turn + 1,
        usages,
        model: resolution.effective,
        fellBack: resolution.fellBack,
      };
    }

    // 完整回传 assistant 内容（含 thinking / tool_use）以保持思维链连续性。
    messages.push({ role: 'assistant', content: blocks });

    const toolResults = [];
    for (const call of toolUses) {
      let text;
      let isError = false;
      try {
        text = await runSubagentTool(call, { ctx, resolved, apiKey, cwd });
      } catch (error) {
        isError = true;
        text = `工具执行失败：${error?.message ?? String(error)}`;
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: [{ type: 'text', text }],
        ...(isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return {
    text: `${lastText}\n\n（已达工具循环上限 ${maxTurns} 轮，提前结束）`.trim(),
    turns: maxTurns,
    usages,
    model: resolution.effective,
    fellBack: resolution.fellBack,
  };
}

/** 汇总 usage。 */
function summarizeUsage(usages) {
  if (!Array.isArray(usages) || usages.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const usage of usages) {
    inputTokens += Number(usage.input_tokens ?? 0);
    outputTokens += Number(usage.output_tokens ?? 0);
  }
  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

/** 委派工具。 */
function registerDelegateTool(ctx, resolved) {
  const definition = {
    name: resolved.delegateToolName,
    description:
      '把一个自包含的细分任务委派给 MiniMax M Plan 子代理执行。该子代理有自己的工具循环，' +
      '能生成图片、读写工作区文件、列目录。适合：批量生成素材/图片、独立的资料整理与写作、' +
      '与当前上下文无关的独立子任务、需要另一个模型视角的评审。返回子代理的最终结论。' +
      '任务必须自包含——子代理看不到本对话。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '完整、自包含的任务说明：目标、输入、期望产出形式、约束。避免"上面那段代码"这类依赖上下文的表述。',
        },
        max_turns: { type: 'integer', description: '工具循环最大轮数；省略用配置值。' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          result: { type: 'string' },
          model: { type: 'string' },
          turns: { type: 'number' },
          inputTokens: { type: 'number' },
          outputTokens: { type: 'number' },
        },
        required: ['ok', 'result'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const stats = [
          value.turns === undefined ? undefined : `${value.turns} 轮`,
          value.inputTokens === undefined
            ? undefined
            : `输入 ${value.inputTokens} token / 输出 ${value.outputTokens} token`,
        ]
          .filter(Boolean)
          .join('，');
        return [
          {
            type: 'text',
            text: stats.length > 0 ? `${value.result}\n\n— MiniMax ${value.model ?? ''}（${stats}）—` : value.result,
          },
        ];
      },
    },
    timeoutMs: 600000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      try {
        const apiKey = await resolveApiKey(ctx, resolved);
        const cwd = await resolveCwd(ctx, exec);
        const maxTurns = Number.isFinite(args.max_turns)
          ? Math.max(1, Math.trunc(args.max_turns))
          : resolved.maxTurns;
        const outcome = await runMinimaxAgent({
          ctx,
          resolved,
          apiKey,
          cwd,
          prompt: String(args.task ?? ''),
          maxTurns,
          signal: exec.signal,
        });
        const usage = summarizeUsage(outcome.usages);
        const resultText = outcome.text.length > 0 ? outcome.text : '（子代理未返回文本内容）';
        return {
          ok: true,
          // 平台对未知模型名会静默回退，这里如实标注实际生效的模型。
          result:
            outcome.fellBack === true
              ? `${resultText}\n\n（注意：平台未接受所配置的模型名，实际使用 ${outcome.model} 执行）`
              : resultText,
          model: outcome.model,
          turns: outcome.turns,
          ...(usage === undefined
            ? {}
            : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }),
        };
      } catch (error) {
        return {
          ok: false,
          result:
            error instanceof MinimaxError
              ? error.message
              : `委派执行失败：${error?.message ?? String(error)}`,
        };
      }
    },
  };
  return ctx.effect(() => ctx.tools.register(definition));
}

/** 出图工具：图片通过 finalizeContent 附加为真正的 image 块。 */
function registerImageTool(ctx, resolved) {
  /** 把本次执行生成的图片块挂在 value 上，供 finalizeContent 取用。 */
  const blocksByValue = new WeakMap();

  const definition = {
    name: resolved.imageToolName,
    description:
      '用 MiniMax 文生图直接生成图片（不经过文本子代理）。适合插画、封面、示意图、配图、图标草图。' +
      '生成的图片会进入会话，你可以直接看到，用户也能在对话中查看。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述，尽量具体：主体、风格、构图、光线、色调。最多 1500 字符。',
        },
        aspect_ratio: {
          type: 'string',
          enum: IMAGE_ASPECT_RATIOS,
          description: '宽高比，默认 1:1。16:9 适合横版封面，9:16 适合竖版海报。',
        },
        count: { type: 'integer', description: '生成张数 1-9，默认 1。' },
        save_as: { type: 'string', description: '可选：落盘文件名（不含扩展名）。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok', 'summary'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const attachments = ctx.get('attachments');
      let apiKey;
      let cwd;
      try {
        apiKey = await resolveApiKey(ctx, resolved);
        cwd = await resolveCwd(ctx, exec);
      } catch (error) {
        const summary =
          error instanceof MinimaxError
            ? error.message
            : `准备出图失败：${error?.message ?? String(error)}`;
        const failure = { ok: false, summary, paths: [] };
        blocksByValue.set(failure, [
          { type: 'text', text: `图片生成失败：${summary}` },
        ]);
        return failure;
      }

      const count = Number.isFinite(args.count)
        ? Math.min(Math.max(1, Math.trunc(args.count)), 9)
        : 1;

      let results;
      try {
        results = await generateImages({
          apiKey,
          baseURL: resolved.baseURL,
          model: resolved.imageModel,
          prompt: String(args.prompt ?? ''),
          aspectRatio: args.aspect_ratio ?? '1:1',
          n: count,
          signal: exec.signal,
        });
      } catch (error) {
        const summary =
          error instanceof MinimaxError
            ? error.message
            : `图片生成失败：${error?.message ?? String(error)}`;
        const failure = { ok: false, summary, paths: [] };
        blocksByValue.set(failure, [
          { type: 'text', text: `图片生成失败：${summary}` },
        ]);
        return failure;
      }

      const blocks = [];
      const paths = [];
      let persistedCount = 0;
      for (const item of results) {
        if (item.base64 === undefined) continue;
        const persisted = await persistImage({
          attachments,
          cwd,
          base64: item.base64,
          name: args.save_as ?? `minimax-${Date.now()}`,
        });
        persistedCount += 1;
        if (persisted.kind === 'attachment') {
          blocks.push({ type: 'image', attachment: persisted.ref });
        } else {
          paths.push(persisted.file);
          blocks.push({
            type: 'text',
            text: `图片已保存到：${persisted.file}（${persisted.mediaType}，${persisted.bytes} 字节）`,
          });
        }
      }

      const value = {
        ok: persistedCount > 0,
        summary:
          persistedCount === 0
            ? '未生成任何图片'
            : `MiniMax ${resolved.imageModel} 生成 ${persistedCount} 张图片` +
              (paths.length > 0 ? `，其中 ${paths.length} 张落盘` : ''),
        paths,
      };
      blocksByValue.set(value, blocks);
      return value;
    },
    /** 把图片块合并进工具结果 content。 */
    finalizeContent(exec, result) {
      if (result?.isError !== false) return undefined;
      const blocks = blocksByValue.get(result.value);
      if (blocks === undefined || blocks.length === 0) return undefined;
      const rendered = result.content ?? [];
      return [...rendered, ...blocks];
    },
  };

  return ctx.effect(() => ctx.tools.register(definition));
}

/** 注册名为 minimax 的 subagent 提供方（供官方 dsh-tool-subagent 使用）。 */
function registerSubagentProvider(ctx, resolved) {
  const subagents = ctx.get('subagents');
  if (subagents === undefined) return undefined;

  const provider = {
    name: 'minimax',
    capabilities: {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },
    inheritsParentContext: false,
    async start(request) {
      const apiKey = await resolveApiKey(ctx, resolved);
      const cwd =
        typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : process.cwd();
      const promptText = (request.prompt ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      // 外部后端一次性执行：这里的 promise 就是其结果。
      const resultPromise = (async () => {
        const outcome = await runMinimaxAgent({
          ctx,
          resolved,
          apiKey,
          cwd,
          prompt: promptText,
          maxTurns: resolved.maxTurns,
          signal: request.signal,
        });
        return {
          output: [{ type: 'text', text: outcome.text }],
          stopReason: 'completed',
        };
      })();

      return {
        id: `minimax-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        result: resultPromise,
        async dispose() {
          // 无法中断进行中的 HTTP 请求；由 request.signal 负责取消。
        },
      };
    },
  };

  return ctx.effect(() => subagents.registerProvider(provider));
}

/**
 * Cordis 入口。
 * 所有注册都用 ctx.effect 包裹，插件卸载时由 Cordis 自动清理。
 * @param {object} ctx 插件 Context
 * @param {object} config 行配置
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);

  registerDelegateTool(ctx, resolved);
  registerImageTool(ctx, resolved);
  if (resolved.registerSubagentProvider) {
    registerSubagentProvider(ctx, resolved);
  }

  // 系统提示：说明两个工具各自何时使用。
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: 'tool:minimax-mplan',
      order: systemPrompt.getSectionOrder('TOOLS') ?? 0,
      text: (context) => {
        const lines = [];
        if (ctx.tools.get(resolved.delegateToolName, context?.scope) !== undefined) {
          lines.push(
            `\`${resolved.delegateToolName}\`：把自包含的细分任务委派给 MiniMax 子代理（可生成图片、读写工作区文件）。任务必须自包含，它看不到本对话。`,
          );
        }
        if (ctx.tools.get(resolved.imageToolName, context?.scope) !== undefined) {
          lines.push(
            `\`${resolved.imageToolName}\`：直接调用 MiniMax 文生图，图片会进入会话供你与用户查看。`,
          );
        }
        return lines.join('\n');
      },
    });
  }
}
