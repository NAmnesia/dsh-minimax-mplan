/**
 * 真实端点冒烟测试：用插件真实代码跑一次「出图」与「委派」。
 * 会消耗 M Plan 额度（约 1 张图 + 1 次短对话），仅在手动验收时运行。
 *
 * 运行：node test/live-smoke.mjs
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';
import { sniffImageMediaType } from '../lib/minimax.js';

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');

/** 从 DSH 凭据文件读取密钥（只读，不打印）。 */
async function loadKey() {
  const fromEnv = process.env.MINIMAX_CN_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const text = await readFile(join(DSH_HOME, '.credentials.yaml'), 'utf8');
  const match = /^\s{2}MINIMAX_CN_API_KEY:\s*(\S+)\s*$/mu.exec(text.replace(/\r\n/gu, '\n'));
  if (!match) throw new Error('未在凭据文件中找到 MINIMAX_CN_API_KEY');
  return match[1];
}

const apiKey = await loadKey();
console.log(`密钥已加载（前缀 ${apiKey.slice(0, 6)}…，长度 ${apiKey.length}）`);

const workdir = await mkdtemp(join(tmpdir(), 'mplan-live-'));
const savedImages = [];

/** 与插件内部一致的假 Context，但 attachments 用真实落盘模拟。 */
function createCtx() {
  const registered = new Map();
  return {
    registered,
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
            async resolve() {
              return { value: apiKey, source: 'live-smoke' };
            },
          };
        case 'attachments':
          return {
            async saveImage(input) {
              const mediaType = sniffImageMediaType(input.data) ?? input.mediaType;
              savedImages.push({ name: input.name, bytes: input.data.length, mediaType });
              return {
                attachmentId: `live-${savedImages.length}`,
                mediaType,
                bytes: input.data.length,
                width: 1024,
                height: 1024,
              };
            },
          };
        case 'workingDirectory':
          return {
            async ensure() {
              return workdir;
            },
          };
        case 'systemPrompt':
          return undefined;
        default:
          return undefined;
      }
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      get(name) {
        return registered.get(name);
      },
    },
  };
}

const ctx = createCtx();
plugin.apply(ctx, {});
console.log(`已注册工具：${[...ctx.registered.keys()].join(', ')}`);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// ---------------------------------------------------------------------------
console.log('\n[1] 出图工具（真实调用 MiniMax /v1/image_generation）');
const imageTool = ctx.registered.get('minimax_generate_image');
const t0 = Date.now();
const imageValue = await imageTool.execute(
  { prompt: '一只戴耳机的橘猫坐在窗台上，扁平插画风格，柔和的午后光线', aspect_ratio: '1:1', count: 1 },
  { signal: new AbortController().signal, agent: { id: 'smoke' } },
);
const imageMs = Date.now() - t0;
console.log(`  耗时 ${imageMs}ms，返回值：${JSON.stringify(imageValue)}`);
check('出图返回 ok', imageValue.ok === true);
check('至少保存一张图片', savedImages.length >= 1, `${savedImages.length} 张`);
if (savedImages.length > 0) {
  const first = savedImages[0];
  check(
    '图片格式被正确识别',
    ['image/jpeg', 'image/png', 'image/webp'].includes(first.mediaType),
    `${first.mediaType} ${first.bytes} 字节`,
  );
  check('图片字节数合理（>10KB）', first.bytes > 10_000, `${first.bytes} 字节`);
  check('图片走的是 attachment 通道（可进会话）', imageValue.summary.includes('生成'));
}

const blocks = imageTool.finalizeContent(
  { agent: { id: 'smoke' } },
  { isError: false, value: imageValue, content: imageTool.output.render({ prompt: 'x' }, imageValue) },
);
check(
  'finalizeContent 产出 image 块',
  Array.isArray(blocks) && blocks.some((block) => block.type === 'image'),
  `${Array.isArray(blocks) ? blocks.length : 0} 个块`,
);

// ---------------------------------------------------------------------------
console.log('\n[2] 委派工具（真实调用 MiniMax 文本 + 工具循环）');
const delegateTool = ctx.registered.get('minimax_delegate');
const t1 = Date.now();
const delegateValue = await delegateTool.execute(
  {
    task:
      '请完成两件小事：(1) 用一句话说明"指数退避重试"是什么；(2) 在工作目录创建 notes.md，' +
      '写入三行内容：标题、指数退避的定义、以及一句你给出的适用场景。完成后简短汇报。',
    max_turns: 4,
  },
  { signal: new AbortController().signal, agent: { id: 'smoke' } },
);
const delegateMs = Date.now() - t1;
console.log(`  耗时 ${delegateMs}ms，返回值：${JSON.stringify(delegateValue).slice(0, 1200)}`);
check('委派返回 ok', delegateValue.ok === true);
check('委派有结论文本', typeof delegateValue.result === 'string' && delegateValue.result.length > 10);
check('模型名已确认', typeof delegateValue.model === 'string' && delegateValue.model.length > 0, delegateValue.model);
check('发生了 token 统计', typeof delegateValue.inputTokens === 'number');

// 验证子代理确实写了文件（说明工具循环真的执行了）
try {
  const notes = await readFile(join(workdir, 'notes.md'), 'utf8');
  check('子代理通过 write_file 真的写了文件', notes.length > 10, `${notes.length} 字符`);
  console.log(`  notes.md 内容：\n${notes.split('\n').map((line) => `    | ${line}`).join('\n')}`);
} catch (error) {
  check('子代理通过 write_file 真的写了文件', false, `读取失败：${error.message}`);
}

// ---------------------------------------------------------------------------
console.log('\n[3] 工具循环真实执行了内置工具（list_dir）');
const listValue = await delegateTool.execute(
  {
    task: '请调用 list_dir 列出当前工作目录的内容，然后用一句话告诉我里面有什么文件。',
    max_turns: 3,
  },
  { signal: new AbortController().signal, agent: { id: 'smoke' } },
);
check('list_dir 委派成功', listValue.ok === true);
check(
  '子代理读到了 notes.md（证明工具结果被正确回传）',
  listValue.result.includes('notes.md'),
  listValue.result.slice(0, 200),
);

// ---------------------------------------------------------------------------
console.log('\n[4] 错误路径：错误密钥');
const badCtx = createCtx();
Object.defineProperty(badCtx, 'get', {
  value(name) {
    if (name === 'credentials') {
      return { async resolve() { return { value: 'sk-cp-invalid', source: 'bad' }; } };
    }
    if (name === 'workingDirectory') {
      return { async ensure() { return workdir; } };
    }
    if (name === 'attachments') {
      return { async saveImage() { throw new Error('should not reach'); } };
    }
    return undefined;
  },
});
plugin.apply(badCtx, {});
const badTool = badCtx.registered.get('minimax_generate_image');
const badValue = await badTool.execute(
  { prompt: 'x' },
  { signal: new AbortController().signal, agent: { id: 'bad' } },
);
console.log(`  返回值：${JSON.stringify(badValue)}`);
check('错误密钥返回 ok=false', badValue.ok === false);
check(
  '错误信息含鉴权/密钥提示',
  /鉴权|密钥|1004|1008|2049|401/u.test(badValue.summary),
  badValue.summary,
);

// ---------------------------------------------------------------------------
await rm(workdir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
