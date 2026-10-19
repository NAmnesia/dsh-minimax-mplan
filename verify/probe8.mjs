#!/usr/bin/env node
/**
 * probe8.mjs — 最终确认：
 *   1) thinking 块回传是否真的可省略（多次重复，避免单次偶然）
 *   2) max_tokens=1 时 content 的确切形态
 *   3) effort 在回退模型上是否安全（重复确认不报错）
 *   4) 构造 thinking+tool_use 的可靠配方（供 agent loop 参考）
 * 运行：node verify/probe8.mjs → verify/results8.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const DIR = import.meta.dirname;
const OUT_DIR = path.join(DIR, 'out');
const BASE = 'https://api.minimax.cn';
const CRED_PATH = 'C:/Users/Amnesia/.dsh/.credentials.yaml';
const AV = '2023-06-01';
const MODEL = 'MiniMax-M3.1-Flash';
const PREVIEW = 'MiniMax-M3.1-Flash-Preview';

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

async function call({ p, method = 'POST', body, timeoutMs = 180000, headers = {} }) {
  const url = p.startsWith('http') ? p : BASE + p;
  const h = { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', ...headers };
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

const TOOLS = [{ name: 'get_weather', description: '查询指定城市的实时天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
const FIRST = '请先深入思考北京和上海的气候差异（至少 3 点），然后调用 get_weather 查询北京天气。';

/** 反复尝试直到拿到 thinking + tool_use 同回合 */
async function buildThinkingToolTurn(maxTries = 5) {
  const recipes = [
    { model: PREVIEW, extra: { output_config: { effort: 'xhigh' } }, max_tokens: 900 },
    { model: PREVIEW, extra: { output_config: { effort: 'max' } }, max_tokens: 1200 },
    { model: MODEL, extra: { output_config: { effort: 'xhigh' } }, max_tokens: 900 },
    { model: MODEL, extra: { thinking: { type: 'enabled', budget_tokens: 2048 } }, max_tokens: 1200 },
    { model: PREVIEW, extra: {}, max_tokens: 900 },
  ];
  for (let t = 0; t < maxTries; t++) {
    for (const r of recipes) {
      const res = await call({ p: '/anthropic/v1/messages', body: { ...r.body, model: r.model, max_tokens: r.max_tokens, tools: TOOLS, messages: [{ role: 'user', content: FIRST }], ...r.extra } });
      const blocks = res.json?.content || [];
      const hasT = blocks.some((b) => b.type === 'thinking');
      const hasU = blocks.some((b) => b.type === 'tool_use');
      log(`      try[${t}] ${r.model} ${JSON.stringify(r.extra)} -> ${res.status} types=${JSON.stringify(blocks.map((b) => b.type))} stop=${res.json?.stop_reason}`);
      if (hasT && hasU) return { ok: true, res, recipe: r, blocks };
    }
  }
  return { ok: false };
}

// ===== EE. thinking 回传省略实验（多次重复）=====
await section('EE_thinking_replay_omission', async () => {
  const built = await buildThinkingToolTurn();
  if (!built.ok) return { constructed: false };
  const blocks = built.blocks;
  const thinking = blocks.find((b) => b.type === 'thinking');
  const toolUse = blocks.find((b) => b.type === 'tool_use');
  log(`    构造成功 model=${built.res.model} types=${JSON.stringify(blocks.map((b) => b.type))}`);

  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '北京：晴，25°C' }] };
  const base = { model: built.res.json.model, max_tokens: 300, tools: TOOLS, ...built.recipe.extra };

  const variants = {
    full: blocks,
    'no-thinking': blocks.filter((b) => b.type !== 'thinking'),
    'thinking-no-text': blocks.filter((b) => b.type !== 'text'),
    'bad-signature': blocks.map((b) => (b.type === 'thinking' ? { ...b, signature: 'f'.repeat(64) } : b)),
    'no-signature-field': blocks.map((b) => (b.type === 'thinking' ? { thinking: b.thinking, type: 'thinking' } : b)),
    'text-only': blocks.filter((b) => b.type === 'text'),
  };
  const out = {};
  for (const [label, content] of Object.entries(variants)) {
    const repeats = [];
    for (let i = 0; i < 2; i++) {
      const r = await call({ p: '/anthropic/v1/messages', body: { ...base, messages: [{ role: 'user', content: FIRST }, { role: 'assistant', content }, toolResult] }, timeoutMs: 150000 });
      repeats.push({ status: r.status, types: ctypes(r.json), stop: r.json?.stop_reason, err: r.ok ? undefined : clip(r.text, 240) });
      await new Promise((res) => setTimeout(res, 300));
    }
    out[label] = repeats;
    log(`    ${label}: statuses=${JSON.stringify(repeats.map((x) => x.status))} errs=${JSON.stringify(repeats.map((x) => x.err ? clip(x.err, 120) : null))}`);
  }
  return { constructed: true, sourceModel: built.res.json.model, sourceTypes: blocks.map((b) => b.type), sigLen: thinking.signature?.length, thinkingLen: thinking.thinking?.length, variants: out };
});

// ===== FF. max_tokens=1 的 content 确切形态 =====
await section('FF_content_shape_tiny', async () => {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    for (const mt of [1, 2]) {
      const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: '你好' }] } });
      rows.push({
        max_tokens: mt, status: r.status,
        contentType: Array.isArray(r.json?.content) ? 'array' : typeof r.json?.content,
        contentRaw: JSON.stringify(r.json?.content),
        topKeys: Object.keys(r.json || {}),
        stop: r.json?.stop_reason, output_tokens: r.json?.usage?.output_tokens,
      });
    }
  }
  for (const row of rows) log(`    max_tokens=${row.max_tokens}: content=${row.contentType} raw=${clip(row.contentRaw, 120)} stop=${row.stop} out=${row.output_tokens}`);
  return rows;
});

// ===== GG. effort 对回退模型是否安全（重复）=====
await section('GG_effort_safe_on_fallback', async () => {
  const out = {};
  for (const model of ['MiniMax-M3', 'MiniMax-M2.7']) {
    for (const effort of ['low', 'max']) {
      const r = await call({ p: '/anthropic/v1/messages', body: { model, max_tokens: 80, output_config: { effort }, messages: [{ role: 'user', content: '只回答 ok' }] } });
      out[`${model}/${effort}`] = { status: r.status, effective: r.json?.model ?? null, types: ctypes(r.json), err: r.ok ? undefined : clip(r.text, 240), base_resp: r.json?.base_resp ?? null };
      log(`    ${model}/${effort}: HTTP ${r.status} eff=${out[`${model}/${effort}`].effective} types=${JSON.stringify(out[`${model}/${effort}`].types)}`);
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  return out;
});

// ===== HH. 流式：无 thinking 块时的序列（effort 生效后可能无 thinking）=====
await section('HH_stream_without_thinking', async () => {
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, stream: true, output_config: { effort: 'low' }, messages: [{ role: 'user', content: '只回答：1' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const seq = blocks.map((b) => (b.match(/^event:\s*(.+)$/m) || [])[1]);
  const counts = {}; for (const s of seq) counts[s] = (counts[s] || 0) + 1;
  log(`    低 effort 流式: ${res.status} counts=${JSON.stringify(counts)}`);
  log(`    seq=${JSON.stringify(seq)}`);
  return { status: res.status, counts, seq, rawHead: clip(raw, 600) };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results8.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe8.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe8 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
