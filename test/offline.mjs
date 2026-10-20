/**
 * 离线单元测试：不联网，全部用桩函数。
 * 覆盖插件的注册契约、工具循环、图片落盘与错误归类。
 * 运行：node test/offline.mjs
 *
 * 注意：本文件必须以 UTF-8 读写（用 write 工具或 Node 脚本），
 * 不要用 PowerShell 的 Get-Content/Set-Content 往返，否则中文会被破坏。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.stack ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message ?? 'values differ'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 假 Context
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string|null} [options.credentialsValue] 传 null 表示"显式要求凭据缺失"。
 *   不能靠传 undefined：默认参数会把 undefined 也替换成默认值。
 */
function createFakeCtx({ credentialsValue = 'sk-cp-test', attachments, subagents, workingDirectory } = {}) {
  const registered = new Map();
  const sections = [];
  const providers = [];
  const hasCredential = credentialsValue !== null;
  const workdir = workingDirectory ?? process.cwd();

  return {
    registered,
    sections,
    providers,
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get(name) {
      switch (name) {
        case 'credentials':
          return {
            async resolve(ref) {
              return hasCredential ? { value: credentialsValue, source: ref } : undefined;
            },
          };
        case 'attachments':
          return attachments;
        case 'subagents':
          return subagents;
        case 'systemPrompt':
          return {
            section(spec) {
              sections.push(spec);
            },
            getSectionOrder() {
              return 10;
            },
          };
        case 'workingDirectory':
          return {
            async ensure() {
              return workdir;
            },
          };
        default:
          return undefined;
      }
    },
    tools: {
      register(definition) {
        if (registered.has(definition.name)) {
          throw new Error(`duplicate tool ${definition.name}`);
        }
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      get(name) {
        return registered.get(name);
      },
    },
  };
}

function createFakeSubagents(providers) {
  return {
    registerProvider(provider) {
      providers.push(provider);
      return () => {
        const index = providers.indexOf(provider);
        if (index >= 0) providers.splice(index, 1);
      };
    },
  };
}

/** 构造可注入的 fetch 桩：拦截请求，按脚本返回响应。 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const reply = await handler({ url: String(url), body, init });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// minimax.js
// ---------------------------------------------------------------------------

console.log('\n# minimax.js: 错误归类与图片格式');

const minimax = await import('../lib/minimax.js');

await test('base_resp 非零错误被转成带中文说明的 MinimaxError', async () => {
  const restore = stubFetch(() => ({
    body: { base_resp: { status_code: 2056, status_msg: 'resource limit' } },
  }));
  try {
    await minimax.generateImages({
      apiKey: 'k',
      baseURL: 'https://api.minimax.cn',
      prompt: 'x',
    });
    throw new Error('应当抛错');
  } catch (error) {
    assert(error instanceof minimax.MinimaxError, '应为 MinimaxError');
    assertEqual(error.code, '2056', '错误码');
    assert(error.message.includes('M Plan'), `应包含 M Plan 提示，实际：${error.message}`);
  } finally {
    restore();
  }
});

await test('prompt 超过 1500 字符在发请求前被拒绝', async () => {
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return { body: {} };
  });
  try {
    await minimax.generateImages({
      apiKey: 'k',
      baseURL: 'https://api.minimax.cn',
      prompt: 'a'.repeat(1501),
    });
    throw new Error('应当抛错');
  } catch (error) {
    assertEqual(error.code, 'INVALID_ARGS', '错误码');
    assertEqual(called, false, '不应发出请求');
  } finally {
    restore();
  }
});

await test('图片 base64 的 data: 前缀被剥离', async () => {
  const restore = stubFetch(() => ({
    body: {
      data: { image_base64: ['data:image/png;base64,AAAA'] },
      base_resp: { status_code: 0 },
    },
  }));
  try {
    const results = await minimax.generateImages({
      apiKey: 'k',
      baseURL: 'https://api.minimax.cn',
      prompt: 'x',
    });
    assertEqual(results[0].base64, 'AAAA', '裸 base64');
  } finally {
    restore();
  }
});

await test('图片格式嗅探：PNG / JPEG / WebP / GIF', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assertEqual(minimax.sniffImageMediaType(png), 'image/png');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEqual(minimax.sniffImageMediaType(jpeg), 'image/jpeg');
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assertEqual(minimax.sniffImageMediaType(webp), 'image/webp');
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
  assertEqual(minimax.sniffImageMediaType(gif), 'image/gif');
  assertEqual(minimax.sniffImageMediaType(new Uint8Array([1, 2, 3])), undefined);
});

await test('模型候选名包含多种后缀，配置值优先', () => {
  const candidates = minimax.textModelCandidates('MiniMax-M3.1-Flash');
  assertEqual(candidates[0], 'MiniMax-M3.1-Flash', '配置值优先');
  assert(candidates.includes('MiniMax-M3.1-Flash-Preview'), '应包含 -Preview 候选');
});

// ---------------------------------------------------------------------------
// image.js
// ---------------------------------------------------------------------------

console.log('\n# image.js: 落盘与文件名净化');

const image = await import('../lib/image.js');

await test('attachments 可用时返回 attachment 引用', async () => {
  const saved = [];
  const persisted = await image.persistImage({
    attachments: {
      async saveImage(input) {
        saved.push(input);
        return {
          attachmentId: 'att-1',
          mediaType: input.mediaType,
          bytes: input.data.length,
          width: 1,
          height: 1,
        };
      },
    },
    cwd: process.cwd(),
    base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
    name: 'demo',
  });
  assertEqual(persisted.kind, 'attachment', '类型');
  assertEqual(persisted.ref.attachmentId, 'att-1', '引用 id');
  assertEqual(saved[0].name, 'demo.png', '文件名');
});

await test('attachments 拒绝时退回写工作区文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-'));
  try {
    const persisted = await image.persistImage({
      attachments: {
        async saveImage() {
          throw new Error('too large');
        },
      },
      cwd: dir,
      base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
      name: 'fallback',
    });
    assertEqual(persisted.kind, 'file', '类型');
    assertEqual(persisted.mediaType, 'image/jpeg', '格式');
    const bytes = await readFile(persisted.file);
    assertEqual(bytes.length, 12, '字节数');
    assert(persisted.file.includes('.minimax-images'), '应写入 .minimax-images');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test('文件名净化去掉分隔符、控制字符并折叠连字符', () => {
  assertEqual(image.sanitizeName('a/b\\c:d*e?"f'), 'a-b-c-d-e-f');
  assertEqual(image.sanitizeName('   '), undefined);
  assertEqual(image.sanitizeName('x'.repeat(80)).length, 48);
});

// ---------------------------------------------------------------------------
// index.js
// ---------------------------------------------------------------------------

console.log('\n# index.js: 插件注册契约与工具循环');

const plugin = await import('../lib/index.js');

await test('插件导出 name / inject / Config / apply', () => {
  assertEqual(plugin.name, 'minimax-mplan');
  assert(Array.isArray(plugin.inject), 'inject 应为数组');
  assert(plugin.inject.includes('tools'), 'inject 应含 tools');
  assert(plugin.inject.includes('credentials'), 'inject 应含 credentials');
  assertEqual(typeof plugin.apply, 'function', 'apply');
  assert(plugin.Config !== undefined, 'Config 必须存在');
});

await test('apply 注册三个工具，且 output 形态符合 dsh-tools 校验', () => {
  const ctx = createFakeCtx();
  plugin.apply(ctx, {});
  assertEqual(ctx.registered.size, 3, '工具数量');
  for (const toolName of ['minimax_delegate', 'minimax_generate_image', 'minimax_image_to_image']) {
    const definition = ctx.registered.get(toolName);
    assert(definition !== undefined, `应注册 ${toolName}`);
    assertEqual(typeof definition.description, 'string', `${toolName} description`);
    assertEqual(definition.parameters.type, 'object', `${toolName} parameters 必须是 object`);
    assert(definition.output !== undefined, `${toolName} 必须有 output`);
    assert(definition.output.schema.type === 'object', `${toolName} output.schema 必须是 object`);
    assertEqual(typeof definition.output.render, 'function', `${toolName} output.render`);
    assertEqual(typeof definition.execute, 'function', `${toolName} execute`);
  }
});

await test('tool schema 只使用 dsh-tools 支持的子集关键字', () => {
  const ctx = createFakeCtx();
  plugin.apply(ctx, {});
  const allowed = new Set([
    'type',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'description',
    'title',
    'default',
    'examples',
  ]);
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (!allowed.has(key)) throw new Error(`${path} 含不支持的 schema 关键字 "${key}"`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.properties.${key}`);
    }
    if (node.items) walk(node.items, `${path}.items`);
    for (const [index, child] of (node.oneOf ?? []).entries()) {
      walk(child, `${path}.oneOf[${index}]`);
    }
  };
  for (const [toolName, definition] of ctx.registered) {
    walk(definition.parameters, `${toolName}.parameters`);
    walk(definition.output.schema, `${toolName}.output.schema`);
  }
});

await test('缺少凭据时给出可操作错误，且不发起任何网络请求', async () => {
  const originalFetch = globalThis.fetch;
  let reachedNetwork = false;
  globalThis.fetch = async () => {
    reachedNetwork = true;
    throw new Error('不应发起网络请求');
  };
  const savedEnv = process.env.MINIMAX_CN_API_KEY;
  delete process.env.MINIMAX_CN_API_KEY;
  try {
    const ctx = createFakeCtx({ credentialsValue: null });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    const value = await tool.execute(
      { task: 'x' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(reachedNetwork, false, '凭据缺失时不应发起网络请求');
    assertEqual(value.ok, false, 'ok 应为 false');
    assert(value.result.includes('MINIMAX_CN_API_KEY'), `应点名凭据引用，实际：${value.result}`);
    assert(value.result.includes('未配置 MiniMax API Key'), `应是凭据缺失错误，实际：${value.result}`);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedEnv !== undefined) process.env.MINIMAX_CN_API_KEY = savedEnv;
  }
});

await test('配置里直接填 apiKey 时优先于凭据服务与环境变量', async () => {
  const savedEnv = process.env.MINIMAX_CN_API_KEY;
  process.env.MINIMAX_CN_API_KEY = 'sk-cp-from-env';
  let sentAuth;
  const restore = stubFetch(({ url, init }) => {
    if (url.includes('/anthropic/v1/messages')) {
      sentAuth = init?.headers?.Authorization;
      const body = JSON.parse(init.body);
      if (body.messages?.[0]?.content === 'ping') {
        return { body: { content: [{ type: 'text', text: 'pong' }], model: 'MiniMax-M3.1-Flash' } };
      }
      return { body: { content: [{ type: 'text', text: '完成' }], model: 'MiniMax-M3.1-Flash' } };
    }
    return { body: {} };
  });
  try {
    // 凭据服务给的是另一个值，配置里的 apiKey 必须赢。
    const ctx = createFakeCtx({ credentialsValue: 'sk-cp-from-credentials' });
    plugin.apply(ctx, { apiKey: 'sk-cp-from-config' });
    const tool = ctx.registered.get('minimax_delegate');
    const value = await tool.execute(
      { task: 'x' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, true, '应成功');
    assertEqual(sentAuth, 'Bearer sk-cp-from-config', '应使用配置里的 apiKey');
  } finally {
    restore();
    if (savedEnv === undefined) delete process.env.MINIMAX_CN_API_KEY;
    else process.env.MINIMAX_CN_API_KEY = savedEnv;
  }
});

await test('未填 apiKey 时回退到凭据服务', async () => {
  let sentAuth;
  const restore = stubFetch(({ url, init }) => {
    if (url.includes('/anthropic/v1/messages')) {
      sentAuth = init?.headers?.Authorization;
      const body = JSON.parse(init.body);
      if (body.messages?.[0]?.content === 'ping') {
        return { body: { content: [{ type: 'text', text: 'pong' }], model: 'MiniMax-M3.1-Flash' } };
      }
      return { body: { content: [{ type: 'text', text: '完成' }], model: 'MiniMax-M3.1-Flash' } };
    }
    return { body: {} };
  });
  try {
    const ctx = createFakeCtx({ credentialsValue: 'sk-cp-from-credentials' });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    await tool.execute({ task: 'x' }, { signal: new AbortController().signal, agent: { id: 'a' } });
    assertEqual(sentAuth, 'Bearer sk-cp-from-credentials', '应使用凭据服务的值');
  } finally {
    restore();
  }
});

await test('委派工具：无工具调用时返回模型文本', async () => {
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn' } };
    }
    return {
      body: {
        content: [{ type: 'text', text: '这是 MiniMax 的结论。' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    };
  });
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    const value = await tool.execute(
      { task: '写一句话' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, true, 'ok');
    assertEqual(value.result, '这是 MiniMax 的结论。', '结论文本');
    assertEqual(value.inputTokens, 10, '输入 token');
    assertEqual(value.outputTokens, 5, '输出 token');
  } finally {
    restore();
  }
});

await test('委派工具：tool_use 后回传 tool_result 并继续到结论', async () => {
  let call = 0;
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }] } };
    }
    call += 1;
    if (call === 1) {
      return {
        body: {
          content: [
            { type: 'thinking', thinking: '先看看目录' },
            { type: 'text', text: '我先列一下目录' },
            { type: 'tool_use', id: 'tu-1', name: 'list_dir', input: { path: '.' } },
          ],
          stop_reason: 'tool_use',
        },
      };
    }
    const last = body.messages.at(-1);
    const isToolResult =
      last?.role === 'user' &&
      Array.isArray(last.content) &&
      last.content[0]?.type === 'tool_result' &&
      last.content[0]?.tool_use_id === 'tu-1';
    return {
      body: {
        content: [
          { type: 'text', text: isToolResult ? '目录已查看，任务完成。' : 'MISSING_TOOL_RESULT' },
        ],
        stop_reason: 'end_turn',
      },
    };
  });
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    const value = await tool.execute(
      { task: '看看目录' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.result, '目录已查看，任务完成。', '应走完两轮');
    assertEqual(value.turns, 2, '轮数');
  } finally {
    restore();
  }
});

await test('委派工具：assistant 内容原样回传（含 thinking 块）', async () => {
  let call = 0;
  let sawThinking = false;
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }] } };
    }
    call += 1;
    if (call === 1) {
      return {
        body: {
          content: [
            { type: 'thinking', thinking: '推理内容' },
            { type: 'tool_use', id: 'tu-9', name: 'list_dir', input: {} },
          ],
          stop_reason: 'tool_use',
        },
      };
    }
    const assistant = body.messages.find((message) => message.role === 'assistant');
    sawThinking =
      Array.isArray(assistant?.content) &&
      assistant.content.some((block) => block.type === 'thinking');
    return { body: { content: [{ type: 'text', text: 'done' }] } };
  });
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    await tool.execute({ task: 'x' }, { signal: new AbortController().signal, agent: { id: 'a' } });
    assertEqual(sawThinking, true, 'assistant 内容必须原样回传含 thinking');
  } finally {
    restore();
  }
});

await test('出图工具：finalizeContent 把图片块并入 content', async () => {
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const restore = stubFetch(({ url }) => {
    if (!url.includes('/v1/image_generation')) return { body: {} };
    return {
      body: {
        data: { image_base64: [pngBytes.toString('base64')] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    };
  });
  try {
    const saved = [];
    const ctx = createFakeCtx({
      attachments: {
        async saveImage(input) {
          saved.push(input);
          return {
            attachmentId: 'att-9',
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 1,
            height: 1,
          };
        },
      },
    });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_generate_image');
    const value = await tool.execute(
      { prompt: '一只猫' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, true, 'ok');
    assertEqual(saved.length, 1, '应保存一张');
    const blocks = tool.finalizeContent(
      { agent: { id: 'a' }, signal: new AbortController().signal },
      { isError: false, value, content: tool.output.render({ prompt: 'x' }, value) },
    );
    assert(Array.isArray(blocks), 'finalizeContent 应返回数组');
    assert(
      blocks.some(
        (block) => block.type === 'image' && block.attachment?.attachmentId === 'att-9',
      ),
      '应包含 image 块',
    );
  } finally {
    restore();
  }
});

await test('出图工具：API 失败时返回 ok=false 而不是抛异常', async () => {
  const restore = stubFetch(() => ({
    body: { base_resp: { status_code: 1008, status_msg: 'balance' } },
  }));
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_generate_image');
    const value = await tool.execute(
      { prompt: 'x' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, false, 'ok');
    assert(value.summary.includes('1008'), `应包含平台码，实际：${value.summary}`);
  } finally {
    restore();
  }
});

await test('subagents 存在时注册名为 minimax 的提供方', () => {
  const providers = [];
  const ctx = createFakeCtx({ subagents: createFakeSubagents(providers) });
  plugin.apply(ctx, {});
  assertEqual(providers.length, 1, '提供方数量');
  assertEqual(providers[0].name, 'minimax', '名称');
  assertEqual(providers[0].inheritsParentContext, false, '不继承上下文');
  assertEqual(typeof providers[0].start, 'function', 'start');
  assertEqual(providers[0].capabilities.agentOptions, false, '不支持 agentOptions');
});

await test('registerSubagentProvider=false 时不注册提供方', () => {
  const providers = [];
  const ctx = createFakeCtx({ subagents: createFakeSubagents(providers) });
  plugin.apply(ctx, { registerSubagentProvider: false });
  assertEqual(providers.length, 0, '不应注册');
  assertEqual(ctx.registered.size, 3, '工具仍应注册');
});

await test('subagent 提供方的 start 返回 SubagentRun 形状', async () => {
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }] } };
    }
    return { body: { content: [{ type: 'text', text: '子代理完成' }] } };
  });
  try {
    const providers = [];
    const ctx = createFakeCtx({ subagents: createFakeSubagents(providers) });
    plugin.apply(ctx, {});
    const run = await providers[0].start({
      prompt: [{ type: 'text', text: '做点事' }],
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });
    assertEqual(typeof run.id, 'string', 'id');
    const result = await run.result;
    assertEqual(result.stopReason, 'completed', 'stopReason');
    assertEqual(result.output[0].text, '子代理完成', '输出文本');
    await run.dispose();
  } finally {
    restore();
  }
});

await test('系统提示只列出实际注册的工具', () => {
  const ctx = createFakeCtx();
  plugin.apply(ctx, {});
  assertEqual(ctx.sections.length, 1, '应有 1 个提示段');
  const text = ctx.sections[0].text({ scope: {} });
  assert(text.includes('minimax_delegate'), '包含委派工具');
  assert(text.includes('minimax_generate_image'), '包含出图工具');
});

await test('config 自定义工具名生效', () => {
  const ctx = createFakeCtx();
  plugin.apply(ctx, { delegateToolName: 'mm_run', imageToolName: 'mm_draw' });
  assert(ctx.registered.has('mm_run'), '自定义委派名');
  assert(ctx.registered.has('mm_draw'), '自定义出图名');
});

// ---------------------------------------------------------------------------
console.log('\n# 图生图：参考图解析与主体参考下发');

/** 一张最小 PNG（魔数够 sniff 用）。 */
function tinyPng() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
  ]);
}

/** 一张最小 WebP（用来验证「不支持的格式」被本地拦下）。 */
function tinyWebp() {
  return new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
  ]);
}

/** 伪造一个会话：只有最近一张图片附件。 */
function fakeSessionWithImage(attachmentId = 'att-user-1') {
  return {
    deriveMessages() {
      return [
        { role: 'user', content: [{ type: 'text', text: '这是参考图' }] },
        {
          role: 'user',
          content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png' } }],
        },
      ];
    },
  };
}

await test('图生图：工作区图片作为主体参考下发，且只发本地 data URL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
  await writeFile(join(dir, 'ref.png'), tinyPng());
  let sentBody;
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/v1/image_generation')) return { body: {} };
    sentBody = body;
    return {
      body: {
        data: { image_base64: [Buffer.from(tinyPng()).toString('base64')] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    };
  });
  try {
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: '同一个人站在海边', image_path: 'ref.png' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, true, `应成功：${JSON.stringify(value)}`);
    assert(sentBody !== undefined, '应发出图片请求');
    const reference = sentBody.subject_reference;
    assert(Array.isArray(reference) && reference.length === 1, '只发一张参考图');
    assertEqual(reference[0].type, 'character', '参考类型');
    assert(
      String(reference[0].image_file).startsWith('data:image/png;base64,'),
      `参考图应是本地 data URL，实际：${String(reference[0].image_file).slice(0, 60)}`,
    );
    assert(
      !String(reference[0].image_file).includes('http'),
      '参考图不得是远程 URL（会把图片暴露给第三方）',
    );
    assertEqual(sentBody.prompt, '同一个人站在海边', '提示词原样下发');
    assertEqual(sentBody.response_format, 'base64', '仍走 base64');
  } finally {
    restore();
    await rm(dir, { recursive: true, force: true });
  }
});

await test('图生图：不传 image_path 时用会话里最近一张图片', async () => {
  let sentBody;
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/v1/image_generation')) return { body: {} };
    sentBody = body;
    return {
      body: {
        data: { image_base64: [Buffer.from(tinyPng()).toString('base64')] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    };
  });
  try {
    const ctx = createFakeCtx({
      attachments: {
        async saveImage(input) {
          return {
            attachmentId: 'att-out',
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 1,
            height: 1,
          };
        },
        async readImage() {
          return tinyPng();
        },
      },
    });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: '把他画成水彩风' },
      {
        signal: new AbortController().signal,
        agent: { id: 'a', session: fakeSessionWithImage() },
      },
    );
    assertEqual(value.ok, true, `应成功：${JSON.stringify(value)}`);
    assert(sentBody?.subject_reference?.length === 1, '应带一张主体参考');
    assert(
      String(sentBody.subject_reference[0].image_file).startsWith('data:image/png;base64,'),
      '会话图片也应转成 data URL',
    );
    assert(value.reference.includes('会话'), `应说明参考图来源：${value.reference}`);
  } finally {
    restore();
  }
});

await test('图生图：没有可用参考图时给出可操作提示且不发请求', async () => {
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return { body: {} };
  });
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: 'x' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, false, 'ok');
    assertEqual(called, false, '不应发出请求');
    assert(value.summary.includes('参考图'), `应点名参考图，实际：${value.summary}`);
  } finally {
    restore();
  }
});

await test('图生图：use_last_image=false 且没给路径时直接拒绝', async () => {
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return { body: {} };
  });
  try {
    const ctx = createFakeCtx();
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: 'x', use_last_image: false },
      {
        signal: new AbortController().signal,
        agent: { id: 'a', session: fakeSessionWithImage() },
      },
    );
    assertEqual(value.ok, false, 'ok');
    assertEqual(called, false, '不应发出请求');
  } finally {
    restore();
  }
});

await test('图生图：路径越界被拒绝，且不读盘、不发请求', async () => {
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return { body: {} };
  });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: 'x', image_path: '../secret.png' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, false, 'ok');
    assertEqual(called, false, '不应发出请求');
    assert(value.summary.includes('越界') || value.summary.includes('工作目录'), `应说明越界：${value.summary}`);
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

await test('图生图：不支持的参考图格式在本地被拦下（不发请求）', async () => {
  let called = false;
  const restore = stubFetch(() => {
    called = true;
    return { body: {} };
  });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
    await writeFile(join(dir, 'ref.webp'), tinyWebp());
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: 'x', image_path: 'ref.webp' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, false, 'ok');
    assertEqual(called, false, '不应发出请求');
    assert(value.summary.includes('格式'), `应说明格式问题，实际：${value.summary}`);
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

await test('图生图：平台错误里回显的 API Key 会被打码，不进工具返回值', async () => {
  const secret = 'sk-cp-super-secret-value';
  const restore = stubFetch(() => ({
    body: { base_resp: { status_code: 1004, status_msg: `invalid api key ${secret}` } },
  }));
  try {
    const ctx = createFakeCtx({ credentialsValue: secret });
    plugin.apply(ctx, {});
    for (const toolName of ['minimax_generate_image', 'minimax_image_to_image']) {
      const tool = ctx.registered.get(toolName);
      const value = await tool.execute(
        { prompt: 'x' },
        { signal: new AbortController().signal, agent: { id: 'a' } },
      );
      assertEqual(value.ok, false, `${toolName} ok`);
      assert(!String(value.summary).includes(secret), `${toolName} 的返回值泄露了 API Key`);
    }
  } finally {
    restore();
  }
});

await test('图生图：请求体里只带 key 的 Authorization 头，URL 不含 key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
  await writeFile(join(dir, 'ref.png'), tinyPng());
  let seenUrl;
  let seenAuth;
  const restore = stubFetch(({ url, init }) => {
    if (!String(url).includes('/v1/image_generation')) return { body: {} };
    seenUrl = String(url);
    seenAuth = init?.headers?.Authorization;
    return {
      body: {
        data: { image_base64: [Buffer.from(tinyPng()).toString('base64')] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    };
  });
  try {
    const ctx = createFakeCtx({ workingDirectory: dir, credentialsValue: 'sk-cp-top-secret' });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_image_to_image');
    await tool.execute(
      { prompt: 'x', image_path: 'ref.png' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(seenAuth, 'Bearer sk-cp-top-secret', 'key 只在 Authorization 头');
    assert(!seenUrl.includes('sk-cp-top-secret'), 'URL 里不能出现 key');
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

await test('子代理的 generate_image 支持 image_path（子代理也能图生图）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
  await writeFile(join(dir, 'ref.png'), tinyPng());
  let sentBody;
  let call = 0;
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }] } };
    }
    call += 1;
    if (call === 1) {
      return {
        body: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-i2i',
              name: 'generate_image',
              input: { prompt: '同一个人', image_path: 'ref.png' },
            },
          ],
          stop_reason: 'tool_use',
        },
      };
    }
    return { body: { content: [{ type: 'text', text: '完成' }] } };
  });
  try {
    const originalFetch = globalThis.fetch;
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/v1/image_generation')) {
        sentBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            data: { image_base64: [Buffer.from(tinyPng()).toString('base64')] },
            metadata: { success_count: '1', failed_count: '0' },
            base_resp: { status_code: 0, status_msg: 'success' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(url, init);
    };
    await tool.execute(
      { task: '做张图' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assert(sentBody?.subject_reference?.length === 1, '子代理图生图应带主体参考');
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

await test('子代理的 read_file 拒绝把图片当文本读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
  await writeFile(join(dir, 'ref.png'), tinyPng());
  let call = 0;
  let toolResultText = '';
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/anthropic/v1/messages')) return { body: {} };
    if (body.messages?.[0]?.content === 'ping') {
      return { body: { content: [{ type: 'text', text: 'pong' }] } };
    }
    call += 1;
    if (call === 1) {
      return {
        body: {
          content: [
            { type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'ref.png' } },
          ],
          stop_reason: 'tool_use',
        },
      };
    }
    const last = body.messages.at(-1);
    toolResultText = last?.content?.[0]?.content?.[0]?.text ?? '';
    return { body: { content: [{ type: 'text', text: '完成' }] } };
  });
  try {
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, {});
    const tool = ctx.registered.get('minimax_delegate');
    await tool.execute(
      { task: '读文件' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assert(toolResultText.includes('图片'), `应提示是图片，实际：${toolResultText}`);
    assert(!toolResultText.includes('�'), '不应把二进制当文本回传');
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

await test('图生图工具名与其它工具撞车时只跳过它，不影响另外两个工具', () => {
  const ctx = createFakeCtx();
  plugin.apply(ctx, { imageToImageToolName: 'minimax_generate_image' });
  assert(ctx.registered.has('minimax_generate_image'), '文生图工具仍在');
  assert(ctx.registered.has('minimax_delegate'), '委派工具仍在');
  assertEqual(ctx.registered.size, 2, '图生图被跳过');
});

await test('插件卸载后三个工具全部注销（不残留作用域给别的插件）', () => {
  const ctx = createFakeCtx();
  const disposers = [];
  const originalEffect = ctx.effect;
  ctx.effect = (fn, label) => {
    const disposer = originalEffect(fn, label);
    disposers.push(disposer);
    return disposer;
  };
  plugin.apply(ctx, {});
  assertEqual(ctx.registered.size, 3, '注册后应有 3 个工具');
  for (const dispose of disposers) dispose();
  assertEqual(ctx.registered.size, 0, '卸载后应全部注销');
});

await test('图生图：image-01-live 报 2013 时自动退回 image-01 重试一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mplan-i2i-'));
  await writeFile(join(dir, 'ref.png'), tinyPng());
  const sentModels = [];
  const restore = stubFetch(({ url, body }) => {
    if (!url.includes('/v1/image_generation')) return { body: {} };
    sentModels.push(body.model);
    if (sentModels.length === 1) {
      return { body: { base_resp: { status_code: 2013, status_msg: 'invalid param' } } };
    }
    return {
      body: {
        data: { image_base64: [Buffer.from(tinyPng()).toString('base64')] },
        metadata: { success_count: '1', failed_count: '0' },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    };
  });
  try {
    const ctx = createFakeCtx({ workingDirectory: dir });
    plugin.apply(ctx, { imageModel: 'image-01-live' });
    const tool = ctx.registered.get('minimax_image_to_image');
    const value = await tool.execute(
      { prompt: 'x', image_path: 'ref.png' },
      { signal: new AbortController().signal, agent: { id: 'a' } },
    );
    assertEqual(value.ok, true, `应成功：${JSON.stringify(value)}`);
    assertEqual(sentModels.length, 2, '应重试一次');
    assertEqual(sentModels[0], 'image-01-live', '第一次用配置的模型');
    assertEqual(sentModels[1], 'image-01', '第二次退回 image-01');
    assert(value.summary.includes('image-01'), `应在摘要里说明降级：${value.summary}`);
    await rm(dir, { recursive: true, force: true });
  } finally {
    restore();
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
