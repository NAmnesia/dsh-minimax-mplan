/**
 * 契约验证：确认插件导出能被 Cordis 的加载契约接受。
 * 覆盖 Config['~standard'].validate、apply 签名、工具注册的 schema 子集。
 *
 * 运行：node test/contract.mjs
 */

import { createRequire } from 'node:module';

import * as plugin from '../lib/index.js';

const require = createRequire(import.meta.url);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
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

// ---------------------------------------------------------------------------
console.log('\n# Cordis 插件导出契约');

test('导出 name / inject / apply / Config', () => {
  assert(typeof plugin.name === 'string' && plugin.name.length > 0, 'name 必须是非空字符串');
  assert(Array.isArray(plugin.inject), 'inject 必须是数组');
  assert(typeof plugin.apply === 'function', 'apply 必须是函数');
  assert(plugin.Config !== undefined, 'Config 必须存在');
});

test('inject 只包含硬依赖（可选服务不得进入）', () => {
  const optional = ['attachments', 'subagents', 'systemPrompt', 'workingDirectory'];
  for (const name of optional) {
    assert(!plugin.inject.includes(name), `${name} 是可选服务，不应出现在 inject 中`);
  }
  assert(plugin.inject.includes('tools'), 'tools 应为硬依赖');
  assert(plugin.inject.includes('credentials'), 'credentials 应为硬依赖');
});

// ---------------------------------------------------------------------------
console.log('\n# Config 必须通过 Cordis 的 standard-schema 校验');

test('Config 暴露 ~standard.validate', () => {
  const standard = plugin.Config['~standard'];
  assert(standard !== undefined, 'Config 必须有 ~standard');
  assert(typeof standard.validate === 'function', '~standard.validate 必须是函数');
});

test('空配置被补全为全部默认值', () => {
  const result = plugin.Config['~standard'].validate({});
  assert(!('then' in result), '校验必须同步（Cordis 不支持异步校验）');
  assert(result.issues === undefined, `不应有 issues：${JSON.stringify(result.issues)}`);
  const value = result.value;
  assert(value.apiKey === '', 'apiKey 默认为空');
  assert(value.apiKeyEnv === 'MINIMAX_CN_API_KEY', 'apiKeyEnv 默认值');
  assert(value.baseURL === 'https://api.minimax.cn', 'baseURL 默认值');
  assert(value.textModel === 'MiniMax-M3.1-Flash', 'textModel 默认值');
  assert(value.imageModel === 'image-01', 'imageModel 默认值');
  assert(value.reasoningEffort === 'max', 'reasoningEffort 默认值');
  assert(value.maxTokens === 32768, 'maxTokens 默认值');
  assert(value.maxTurns === 12, 'maxTurns 默认值');
  assert(value.delegateToolName === 'minimax_delegate', 'delegateToolName 默认值');
  assert(value.imageToolName === 'minimax_generate_image', 'imageToolName 默认值');
  assert(value.registerSubagentProvider === true, 'registerSubagentProvider 默认值');
  assert(value.allowWorkspaceWrites === true, 'allowWorkspaceWrites 默认值');
});

test('Config 不静态 import 宿主包（避免 profile 解析失败）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  const staticImports = source
    .split('\n')
    .filter((line) => /^\s*import\s/u.test(line) && line.includes('@deepseek-ai/'));
  assert(
    staticImports.length === 0,
    `lib/index.js 不得静态 import 宿主包，实际有：${staticImports.join(' | ')}`,
  );
});

test('Config 是原生 schemastery schema（设置界面可配置的前提）', () => {
  const config = plugin.Config;
  // dsh-app-boot 的 isNativeConfigSchema 要求这三条同时成立。
  assert(Reflect.get(config, Symbol.for('schemastery')) === true, '缺少 Symbol.for("schemastery") 标记');
  assert(typeof Reflect.get(config, 'type') === 'string', 'type 必须是字符串');
  const meta = Reflect.get(config, 'meta');
  assert(meta !== null && typeof meta === 'object', 'meta 必须是对象');
});

test('全部字段都标了 volatile（否则设置界面看不到）', () => {
  const dict = plugin.Config.dict ?? {};
  const keys = Object.keys(dict);
  assert(keys.length > 0, 'schema 应至少有一个字段');
  const missing = keys.filter((key) => dict[key]?.meta?.volatile !== true);
  assert(missing.length === 0, `以下字段缺少 volatile 标记：${missing.join(', ')}`);
});

test('apiKey 字段标记为 secret（读回时脱敏）', () => {
  const dict = plugin.Config.dict ?? {};
  assert(dict.apiKey !== undefined, 'schema 应含 apiKey');
  assert(dict.apiKey.meta?.role === 'secret', 'apiKey 必须标记 role=secret');
});

test('每个字段都有 description（设置界面要显示说明）', () => {
  const dict = plugin.Config.dict ?? {};
  const missing = Object.entries(dict)
    .filter(([, node]) => typeof node?.meta?.description !== 'string')
    .map(([key]) => key);
  assert(missing.length === 0, `以下字段缺少说明：${missing.join(', ')}`);
});

test('未知配置字段被透传但不影响已知字段（schemastery 的既定行为）', () => {
  // schemastery 会保留用户多写的键，但所有已知字段仍被正确补默认值。
  const result = plugin.Config['~standard'].validate({ apiKeyEnvNmae: 'typo' });
  assert(result.issues === undefined, `不应因未知字段报错：${JSON.stringify(result.issues)}`);
  assert(result.value.apiKeyEnv === 'MINIMAX_CN_API_KEY', '已知字段仍取默认值');
  assert(result.value.apiKey === '', '已知字段仍取默认值');
});

test('未配置任何内容时，全部字段回落到默认值', () => {
  const result = plugin.Config['~standard'].validate({});
  assert(result.issues === undefined, '空配置必须通过');
  const expected = {
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
  for (const [key, want] of Object.entries(expected)) {
    assert(result.value[key] === want, `${key} 默认值应为 ${JSON.stringify(want)}`);
  }
});

test('apiKey 接受字符串，用于在配置里直接填 Key', () => {
  const result = plugin.Config['~standard'].validate({ apiKey: 'sk-cp-test-value' });
  assert(result.issues === undefined, `不应有 issues：${JSON.stringify(result.issues)}`);
  assert(result.value.apiKey === 'sk-cp-test-value', 'apiKey 应原样保留');
});

test('cordis.patch.yml 中的示例配置可通过校验', async () => {
  const { readFile } = await import('node:fs/promises');
  const yaml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const sample = {
    apiKeyEnv: 'MINIMAX_CN_API_KEY',
    baseURL: 'https://api.minimax.cn',
    textModel: 'MiniMax-M3.1-Flash',
    imageModel: 'image-01',
    reasoningEffort: 'max',
    maxTokens: 32768,
    maxTurns: 12,
    registerSubagentProvider: true,
  };
  for (const key of Object.keys(sample)) {
    assert(yaml.includes(key), `patch 应包含 ${key}`);
  }
  const result = plugin.Config['~standard'].validate(sample);
  assert(result.issues === undefined, `示例配置应通过：${JSON.stringify(result.issues)}`);
});

test('package.json 声明的名称与 patch 中的 name 一致', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const yaml = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert(pkg.name === 'dsh-minimax-mplan', `包名应为 dsh-minimax-mplan，实际 ${pkg.name}`);
  assert(yaml.includes(`name: '${pkg.name}'`), 'patch 的 name 必须与 package.json 一致');
  assert(pkg.dsh?.bundle?.patch === './cordis.patch.yml', '必须声明 dsh.bundle.patch');
  assert(pkg.exports?.['./locale/*.json'] !== undefined, '必须导出 locale');
  assert(pkg.exports?.['./icon'] !== undefined, '必须导出 icon');
  assert(pkg.files.includes('cordis.patch.yml'), 'files 必须包含 patch');
  assert(pkg.files.includes('locale/*.json'), 'files 必须包含 locale');
});

test('非法枚举值被拒绝', () => {
  const result = plugin.Config['~standard'].validate({ reasoningEffort: 'none' });
  assert(result.issues !== undefined && result.issues.length > 0, 'effort=none 应被拒绝');
});

test('非法图片模型被拒绝', () => {
  const result = plugin.Config['~standard'].validate({ imageModel: 'image-99' });
  assert(result.issues !== undefined, '未知图片模型应被拒绝');
});

// ---------------------------------------------------------------------------
console.log('\n# 工具 schema 与 dsh-tools 注册契约一致');

/** 与 dsh-tools assertSupportedJsonSchema 允许的关键字保持一致。 */
const ALLOWED = new Set([
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
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function checkSchema(node, path) {
  assert(node !== null && typeof node === 'object', `${path} 必须是对象`);
  for (const key of Object.keys(node)) {
    assert(ALLOWED.has(key), `${path} 含不支持的 schema 关键字 "${key}"`);
  }
  if (node.type !== undefined) {
    assert(TYPES.has(node.type), `${path}.type 非法：${node.type}`);
  }
  if (node.type === 'object') {
    assert(node.properties !== undefined || node.additionalProperties !== undefined,
      `${path} 是 object 却既无 properties 也无 additionalProperties`);
  }
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    checkSchema(child, `${path}.properties.${key}`);
  }
  if (node.items !== undefined) checkSchema(node.items, `${path}.items`);
  for (const [index, child] of (node.oneOf ?? []).entries()) {
    checkSchema(child, `${path}.oneOf[${index}]`);
  }
}

function fakeCtx() {
  const registered = new Map();
  return {
    registered,
    effect: (fn) => {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get: (name) => {
      if (name === 'credentials') {
        return { async resolve(ref) { return { value: 'sk-cp-x', source: ref }; } };
      }
      return undefined;
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      get: (name) => registered.get(name),
    },
  };
}

const ctx = fakeCtx();
// 用 Cordis 校验后的配置调用 apply，模拟真实加载路径。
const validated = plugin.Config['~standard'].validate({}).value;
plugin.apply(ctx, validated);

test('两个工具都已注册', () => {
  assert(ctx.registered.size === 2, `应有 2 个工具，实际 ${ctx.registered.size}`);
  assert(ctx.registered.has('minimax_delegate'), '缺少 minimax_delegate');
  assert(ctx.registered.has('minimax_generate_image'), '缺少 minimax_generate_image');
});

test('每个工具的 parameters / output.schema 都在支持子集内', () => {
  for (const [toolName, definition] of ctx.registered) {
    checkSchema(definition.parameters, `${toolName}.parameters`);
    checkSchema(definition.output.schema, `${toolName}.output.schema`);
    assert(definition.output.schema.type === 'object', `${toolName}.output.schema 必须以 object 为根`);
    assert(typeof definition.output.render === 'function', `${toolName}.output.render 必须是函数`);
    assert(typeof definition.execute === 'function', `${toolName}.execute 必须是函数`);
  }
});

test('render 返回 ContentBlock[] 而不是字符串', () => {
  for (const [toolName, definition] of ctx.registered) {
    // 用一个符合各自 output schema 的最小样例调用 render。
    const sample = toolName === 'minimax_delegate'
      ? { ok: true, result: '示例结果' }
      : { ok: true, summary: '生成 1 张图片' };
    const blocks = definition.output.render({}, sample);
    assert(Array.isArray(blocks), `${toolName}.render 必须返回数组`);
    assert(blocks.length > 0, `${toolName}.render 不应返回空数组`);
    for (const block of blocks) {
      assert(typeof block.type === 'string', `${toolName}.render 的每个块必须有 type`);
    }
  }
});

test('timeoutMs 是正有限数', () => {
  for (const [toolName, definition] of ctx.registered) {
    if (definition.timeoutMs === undefined) continue;
    assert(
      Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0,
      `${toolName}.timeoutMs 必须是正有限数`,
    );
  }
});

test('工具名不是保留名 run_code', () => {
  for (const toolName of ctx.registered.keys()) {
    assert(toolName !== 'run_code', 'run_code 是保留名');
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
