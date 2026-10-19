#!/usr/bin/env node
/**
 * probe7.mjs — 针对被测实现的假设做交叉验证：
 *   1) effort / thinking 在旧模型（会静默回退到 MiniMax-M3）上是否报错
 *   2) image_generation 的 aigc_watermark / seed / prompt 长度上限
 *   3) max_tokens 较小时 content 为空数组的情形
 *   4) thinking 块跨轮次、跨模型回传
 * 运行：node verify/probe7.mjs → verify/results7.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = import.meta.dirname;
const OUT_DIR = path.join(DIR, 'out');
const BASE = 'https://api.minimax.cn';
const CRED_PATH = 'C:/Users/Amnesia/.dsh/.credentials.yaml';
const AV = '2023-06-01';
const MODEL = 'MiniMax-M3.1-Flash';

const startAll = performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const lines = [];
const log = (...a) => { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); lines.push(s); console.log(s); };
const clip = (s, n = 500) => { if (typeof s !== 'string') s = JSON.stringify(s); return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n}]`; };

async function loadKey() {
  const txt = await fs.readFile(CRED_PATH, 'utf8');
  let inRefs = false;
  for (const line of txt.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) inRefs = false;
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/);
    if (m && m[1] === 'MINIMAX_CN_API_KEY') return m[2].replace(/^['"]|['"]$/g, '');
  }
  throw new Error('key not found');
}
const KEY = await loadKey();

async function call({ p, method = 'POST', body, timeoutMs = 180000, headers = {}, key = KEY }) {
  const url = p.startsWith('http') ? p : BASE + p;
  const h = { authorization: `Bearer ${key}`, 'anthropic-version': AV, 'content-type': 'application/json', ...headers };
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, ms: ms(t0), text, json, headers: Object.fromEntries(res.headers) };
  } catch (e) { return { ok: false, status: 0, ms: ms(t0), text: '', json: null, headers: {}, error: `${e?.name}: ${e?.message}` }; }
}
const ctypes = (j) => (j?.content || []).map((b) => b.type);

const results = { startedAt: new Date().toISOString(), probes: {} };
const sections = {};
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try { const r = await fn(); sections[name] = { ...r, elapsedMs: ms(t0) }; log(`    ok (${ms(t0)}ms)`); }
  catch (e) { sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) }; log(`    FAILED ${e?.message}`); }
}

// ===== AA. effort / thinking 在旧模型上的行为（静默回退目标）=====
await section('AA_effort_on_old_models', async () => {
  const out = {};
  const models = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2', 'MiniMax-M3.1-Flash'];
  for (const model of models) {
    for (const extra of [{}, { output_config: { effort: 'high' } }, { thinking: { type: 'disabled' } }, { thinking: { type: 'enabled', budget_tokens: 1024 } }]) {
      const label = `${model} ${JSON.stringify(extra)}`;
      const r = await call({ p: '/anthropic/v1/messages', body: { model, max_tokens: 200, messages: [{ role: 'user', content: '计算 2+2，只给结果' }], ...extra } });
      const rec = {
        status: r.status, effectiveModel: r.json?.model ?? null, types: ctypes(r.json), stop: r.json?.stop_reason,
        thinkingTokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null,
        err: r.json?.error ? clip(r.json.error.message, 260) : undefined,
      };
      out[label] = rec;
      log(`    ${label}: HTTP ${r.status} eff=${rec.effectiveModel} types=${JSON.stringify(rec.types)} think=${rec.thinkingTokens} ${rec.err ? 'err=' + clip(rec.err, 160) : ''}`);
    }
  }
  return out;
});

// ===== BB. 图片参数：aigc_watermark / seed / prompt 长度 =====
await section('BB_image_optional_params', async () => {
  const out = {};
  const cases = [
    { label: 'aigc_watermark=false', body: { model: 'image-01', prompt: '一朵白云', n: 1, response_format: 'url', aspect_ratio: '1:1', aigc_watermark: false } },
    { label: 'aigc_watermark=true', body: { model: 'image-01', prompt: '一朵白云', n: 1, response_format: 'url', aspect_ratio: '1:1', aigc_watermark: true } },
    { label: 'seed=42', body: { model: 'image-01', prompt: '一朵白云', n: 1, response_format: 'url', aspect_ratio: '1:1', seed: 42 } },
    { label: 'prompt_optimizer=false', body: { model: 'image-01', prompt: '一朵白云', n: 1, response_format: 'url', aspect_ratio: '1:1', prompt_optimizer: false } },
    { label: 'prompt 1501 字符', body: { model: 'image-01', prompt: '云'.repeat(1501), n: 1, response_format: 'url', aspect_ratio: '1:1' } },
    { label: 'aigc_watermark 非法值', body: { model: 'image-01', prompt: '一朵白云', n: 1, response_format: 'url', aspect_ratio: '1:1', aigc_watermark: 'yes' } },
  ];
  for (const c of cases) {
    const r = await call({ p: '/v1/image_generation', body: c.body, timeoutMs: 180000 });
    const n = r.json?.data?.image_urls?.length ?? null;
    out[c.label] = { status: r.status, ms: r.ms, images: n, base_resp: r.json?.base_resp ?? null, err: r.ok && n ? undefined : clip(r.text, 400) };
    log(`    ${c.label}: HTTP ${r.status} images=${n} base_resp=${JSON.stringify(r.json?.base_resp)}`);
  }
  return out;
});

// ===== CC. 小 max_tokens 下 content 形态 =====
await section('CC_tiny_max_tokens_content', async () => {
  const rows = [];
  for (const mt of [1, 2, 3, 8]) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: '你好' }] } });
    const rec = {
      max_tokens: mt, status: r.status, stop: r.json?.stop_reason,
      contentTypeIsArray: Array.isArray(r.json?.content),
      contentLen: r.json?.content?.length ?? null,
      types: ctypes(r.json),
      output_tokens: r.json?.usage?.output_tokens,
      thinking_tokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null,
      hasTextBlock: (r.json?.content || []).some((b) => b.type === 'text'),
    };
    rows.push(rec);
    log(`    max_tokens=${mt}: content.isArray=${rec.contentTypeIsArray} len=${rec.contentLen} types=${JSON.stringify(rec.types)} out=${rec.output_tokens} think=${rec.thinking_tokens} hasText=${rec.hasTextBlock}`);
  }
  return rows;
});

// ===== DD. thinking 跨模型回传 =====
await section('DD_thinking_cross_model', async () => {
  // 用 Preview 拿到 thinking+tool_use，然后用 Flash 回传
  const TOOLS = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const first = '请先深入思考北京和上海气候差异，然后调用 get_weather 查询北京天气。';
  const r1 = await call({ p: '/anthropic/v1/messages', body: { model: 'MiniMax-M3.1-Flash-Preview', max_tokens: 800, tools: TOOLS, output_config: { effort: 'xhigh' }, messages: [{ role: 'user', content: first }] } });
  const blocks = r1.json?.content || [];
  const thinking = blocks.find((b) => b.type === 'thinking');
  const toolUse = blocks.find((b) => b.type === 'tool_use');
  log(`    源回合: ${r1.json?.model} types=${JSON.stringify(blocks.map((b) => b.type))} hasThinking=${!!thinking}`);
  if (!thinking || !toolUse) return { constructed: false };

  const messages = [
    { role: 'user', content: first },
    { role: 'assistant', content: blocks },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '北京晴 25°C' }] },
  ];
  const out = {};
  for (const model of ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M3']) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model, max_tokens: 300, tools: TOOLS, messages }, timeoutMs: 150000 });
    out[model] = { status: r.status, effective: r.json?.model ?? null, types: ctypes(r.json), stop: r.json?.stop_reason, text: clip((r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 160), err: r.ok ? undefined : clip(r.text, 400) };
    log(`    回传到 ${model}: HTTP ${r.status} eff=${out[model].effective} types=${JSON.stringify(out[model].types)} ${out[model].err ? 'err=' + clip(out[model].err, 200) : ''}`);
  }
  return { constructed: true, sourceModel: r1.json?.model, thinkingSigLen: thinking.signature?.length, out };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results7.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe7.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe7 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
