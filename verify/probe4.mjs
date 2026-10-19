#!/usr/bin/env node
/**
 * probe4.mjs — 收尾探针：参数支持面、tool_choice、并行工具、多 tool_result、
 *              models 响应结构、图片 URL 有效期、input_json_delta 分片。
 * 运行：node verify/probe4.mjs → verify/results4.json
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

async function call({ p, method = 'POST', body, timeoutMs = 90000, headers = {} }) {
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
const contentTypes = (j) => (j?.content || []).map((b) => b.type);

const results = { startedAt: new Date().toISOString(), probes: {} };
const sections = {};
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try { const r = await fn(); sections[name] = { ...r, elapsedMs: ms(t0) }; log(`    ok (${ms(t0)}ms)`); }
  catch (e) { sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) }; log(`    FAILED ${e?.message}`); }
}

// ===== K. models 响应结构 =====
await section('K_models_shape', async () => {
  const r = await call({ p: '/anthropic/v1/models?limit=1000', method: 'GET' });
  const noQ = await call({ p: '/anthropic/v1/models', method: 'GET' });
  const badLimit = await call({ p: '/anthropic/v1/models?limit=abc', method: 'GET' });
  log(`    topKeys=${JSON.stringify(Object.keys(r.json || {}))} count=${r.json?.data?.length}`);
  log(`    itemKeys=${JSON.stringify(Object.keys(r.json?.data?.[0] || {}))}`);
  log(`    no limit param: ${noQ.status} count=${noQ.json?.data?.length}`);
  log(`    limit=abc: ${badLimit.status} count=${badLimit.json?.data?.length}`);
  return {
    status: r.status, topKeys: Object.keys(r.json || {}), has_more: r.json?.has_more ?? null,
    first_id: r.json?.first_id ?? null, last_id: r.json?.last_id ?? null,
    itemKeys: Object.keys(r.json?.data?.[0] || {}),
    count: r.json?.data?.length,
    noLimit: { status: noQ.status, count: noQ.json?.data?.length ?? null },
    badLimit: { status: badLimit.status, count: badLimit.json?.data?.length ?? null, bodyClip: clip(badLimit.text, 300) },
  };
});

// ===== L. 采样参数支持面 =====
await section('L_sampling_params', async () => {
  const cases = [
    { label: 'temperature=0.2', extra: { temperature: 0.2 } },
    { label: 'temperature=2.0', extra: { temperature: 2.0 } },
    { label: 'temperature=5.0(越界)', extra: { temperature: 5.0 } },
    { label: 'top_p=0.5', extra: { top_p: 0.5 } },
    { label: 'top_k=5', extra: { top_k: 5 } },
    { label: 'stop_sequences', extra: { stop_sequences: ['STOP'] } },
    { label: 'metadata', extra: { metadata: { user_id: 'verify' } } },
    { label: 'max_tokens=0', extra: {}, maxOver: 0 },
    { label: 'max_tokens=64000', extra: {}, maxOver: 64000 },
    { label: 'max_tokens 缺省', extra: {}, maxOver: undefined },
  ];
  const out = [];
  for (const c of cases) {
    const body = { model: MODEL, max_tokens: c.maxOver === undefined ? undefined : c.maxOver, messages: [{ role: 'user', content: '只回答数字 1' }], ...c.extra };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
    const r = await call({ p: '/anthropic/v1/messages', body, timeoutMs: 120000 });
    const rec = { label: c.label, status: r.status, ms: r.ms, stop: r.json?.stop_reason, usage: r.json?.usage, err: r.json?.error ? clip(r.json.error.message, 240) : undefined, bodyClip: r.ok ? undefined : clip(r.text, 300) };
    out.push(rec);
    log(`    ${c.label}: ${r.status} stop=${rec.stop} out=${rec.usage?.output_tokens} ${rec.err ? 'err=' + clip(rec.err, 200) : ''}`);
  }
  return { cases: out };
});

// ===== M. tool_choice / 并行工具 / 多 tool_result =====
await section('M_tool_semantics', async () => {
  const T2 = [
    { name: 'get_weather', description: '查询指定城市的实时天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { name: 'get_time', description: '查询指定城市的当前时间', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  ];
  const PROMPT = '请同时查询北京和上海两个城市的天气（两个城市都要查）。';

  const auto = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 500, tools: T2, messages: [{ role: 'user', content: PROMPT }] } });
  const toolCounts = (j) => (j?.content || []).filter((b) => b.type === 'tool_use');
  log(`    auto: ${auto.status} types=${JSON.stringify(contentTypes(auto.json))} toolUses=${toolCounts(auto.json).length}`);

  const any = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 300, tools: T2, tool_choice: { type: 'any' }, messages: [{ role: 'user', content: '北京天气' }] } });
  log(`    tool_choice=any: ${any.status} types=${JSON.stringify(contentTypes(any.json))} err=${clip(any.text, 200)}`);

  const forced = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 300, tools: T2, tool_choice: { type: 'tool', name: 'get_time' }, messages: [{ role: 'user', content: '北京现在几点？' }] } });
  log(`    tool_choice=tool(get_time): ${forced.status} tools=${JSON.stringify(toolCounts(forced.json).map((t) => t.name))} err=${clip(forced.text, 160)}`);

  const noTools = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 40, tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: 'hi' }] } });
  log(`    tool_choice 但无 tools: ${noTools.status} ${clip(noTools.text, 200)}`);

  // 多 tool_result 一次回传
  const uses = toolCounts(auto.json);
  let multiResult = null;
  if (uses.length >= 2) {
    const r = await call({
      p: '/anthropic/v1/messages',
      body: {
        model: MODEL, max_tokens: 500, tools: T2,
        messages: [
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: auto.json.content },
          { role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: `${u.input.city}：晴，25°C` })) },
        ],
      },
      timeoutMs: 120000,
    });
    multiResult = { status: r.status, types: contentTypes(r.json), stop: r.json?.stop_reason, text: clip((r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 200), err: clip(r.text, 400) };
    log(`    多 tool_result 回传: ${r.status} types=${JSON.stringify(multiResult.types)} text=${clip(multiResult.text, 160)}`);
  } else {
    log(`    只产生 ${uses.length} 个 tool_use，跳过并行回传`);
  }

  // tool_result 用 is_error
  let errResult = null;
  if (uses.length >= 1) {
    const r = await call({
      p: '/anthropic/v1/messages',
      body: {
        model: MODEL, max_tokens: 300, tools: T2,
        messages: [
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: auto.json.content },
          { role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: '工具执行失败：网络超时', is_error: true })) },
        ],
      },
    });
    errResult = { status: r.status, types: contentTypes(r.json), stop: r.json?.stop_reason, text: clip((r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 240), err: clip(r.text, 300) };
    log(`    is_error=true: ${r.status} types=${JSON.stringify(errResult.types)} text=${clip(errResult.text, 160)}`);
  }

  // tool_result 的 content 用数组形态
  let contentArray = null;
  if (uses.length >= 1) {
    const r = await call({
      p: '/anthropic/v1/messages',
      body: {
        model: MODEL, max_tokens: 300, tools: T2,
        messages: [
          { role: 'user', content: PROMPT },
          { role: 'assistant', content: auto.json.content },
          { role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: [{ type: 'text', text: '晴，25°C' }] })) },
        ],
      },
    });
    contentArray = { status: r.status, types: contentTypes(r.json), text: clip((r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 160), err: clip(r.text, 300) };
    log(`    tool_result content 数组: ${r.status} types=${JSON.stringify(contentArray.types)}`);
  }

  return {
    parallel: { status: auto.status, types: contentTypes(auto.json), toolUses: uses.map((u) => ({ id: u.id, name: u.name, input: u.input })), rawClip: clip(auto.text, 1600) },
    toolChoiceAny: { status: any.status, types: contentTypes(any.json), bodyClip: clip(any.text, 500) },
    toolChoiceForced: { status: forced.status, tools: toolCounts(forced.json).map((t) => ({ name: t.name, input: t.input })), bodyClip: clip(forced.text, 400) },
    toolChoiceNoTools: { status: noTools.status, bodyClip: clip(noTools.text, 400) },
    multiToolResult: multiResult,
    isErrorResult: errResult,
    contentArrayResult: contentArray,
  };
});

// ===== N. input_json_delta 分片（大参数）=====
await section('N_input_json_chunking', async () => {
  const tool = {
    name: 'write_file',
    description: '把内容写入文件',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } },
      required: ['path', 'content'],
    },
  };
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      model: PREVIEW, max_tokens: 1200, stream: true, tools: [tool],
      messages: [{ role: 'user', content: '请调用 write_file 工具，path 设为 "notes/todo.md"，content 写一篇约 400 字的关于杭州的短文，lines 传入 5 条短句。' }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await res.text();
  const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
  let jsonDeltaCount = 0; let accumulated = '';
  const deltas = [];
  for (const b of blocks) {
    const evm = b.match(/^event:\s*(.+)$/m);
    const dm = b.match(/^data:\s*(.+)$/m);
    if (!dm) continue;
    let d; try { d = JSON.parse(dm[1]); } catch { continue; }
    if (evm?.[1] === 'content_block_delta' && d.delta?.type === 'input_json_delta') {
      jsonDeltaCount++;
      accumulated += d.delta.partial_json;
      deltas.push(d.delta.partial_json);
    }
    if (evm?.[1] === 'content_block_start' && d.content_block?.type === 'tool_use') {
      log(`    tool_use start content_block=${JSON.stringify(d.content_block)}`);
    }
  }
  if (!jsonDeltaCount) {
    // 未触发工具调用，重试一次更强提示
    log(`    !! 未产生 input_json_delta（本次未调用工具）`);
  }
  let parsed = null; try { parsed = JSON.parse(accumulated); } catch (e) { parsed = { parseError: String(e) }; }
  log(`    input_json_delta 分片数=${jsonDeltaCount} 累计长度=${accumulated.length} 拼接后 parse ${parsed?.parseError ? 'FAIL' : 'OK'}`);
  log(`    分片前 6=${JSON.stringify(deltas.slice(0, 6))}`);
  log(`    parsed keys=${JSON.stringify(parsed && !parsed.parseError ? Object.keys(parsed) : null)} content.len=${parsed?.content?.length} lines=${JSON.stringify(parsed?.lines)}`);
  return {
    status: res.status, contentType: res.headers.get('content-type'),
    inputJsonDeltaCount: jsonDeltaCount, accumulatedLength: accumulated.length,
    chunksHead: deltas.slice(0, 10), joinedParseOk: !parsed?.parseError, parsed,
  };
});

// ===== O. 图片 URL 有效期 =====
await section('O_image_url_expiry', async () => {
  const r = await call({ p: '/v1/image_generation', body: { model: 'image-01', prompt: '一片樱花', n: 1, response_format: 'url', aspect_ratio: '1:1' }, timeoutMs: 150000 });
  const url = r.json?.data?.image_urls?.[0];
  let expires = null, nowSec = null, ttlSec = null, host = null, queryKeys = [];
  if (url) {
    const u = new URL(url);
    host = u.host;
    queryKeys = [...u.searchParams.keys()];
    const e = Number(u.searchParams.get('Expires'));
    nowSec = Math.floor(Date.now() / 1000);
    if (Number.isFinite(e)) { expires = e; ttlSec = e - nowSec; }
  }
  log(`    status=${r.status} ms=${r.ms} host=${host} queryKeys=${JSON.stringify(queryKeys)} ttlSec=${ttlSec} (${ttlSec ? (ttlSec / 3600).toFixed(1) + 'h' : '?'})`);
  return { status: r.status, ms: r.ms, host, queryKeys, expires, nowSec, ttlSec, ttlHours: ttlSec ? +(ttlSec / 3600).toFixed(2) : null, urlSansQuery: url ? `${new URL(url).origin}${new URL(url).pathname}` : null };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results4.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe4.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe4 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
