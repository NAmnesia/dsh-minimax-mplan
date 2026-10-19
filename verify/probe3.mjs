#!/usr/bin/env node
/**
 * probe3.mjs — 关键补充：完整 thinking+text+tool_use 单流 SSE 事件序列、
 *              effort 真实信号（多次采样）、流式错误形态、chat/completions 形态。
 * 运行：node verify/probe3.mjs → verify/results3.json
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

async function call({ p, method = 'POST', body, timeoutMs = 90000, headers = {}, key = KEY }) {
  const url = p.startsWith('http') ? p : BASE + p;
  const h = { authorization: `Bearer ${key}`, 'anthropic-version': AV, 'content-type': 'application/json', ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, ms: ms(t0), text, json, headers: Object.fromEntries(res.headers) };
  } catch (e) { return { ok: false, status: 0, ms: ms(t0), text: '', json: null, headers: {}, error: `${e?.name}: ${e?.message}` }; }
}

const results = { startedAt: new Date().toISOString(), probes: {} };
const sections = {};
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try { const r = await fn(); sections[name] = { ...r, elapsedMs: ms(t0) }; log(`    ok (${ms(t0)}ms)`); }
  catch (e) { sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) }; log(`    FAILED ${e?.message}`); }
}

const parseBlock = (raw) => {
  let event = null; const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  const ds = data.join('\n');
  let j = ds; if (ds !== '[DONE]') { try { j = JSON.parse(ds); } catch {} }
  return { event, data: j };
};

async function streamCapture({ body, timeoutMs = 180000 }) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = { status: res.status, ms0: ms(t0), contentType: res.headers.get('content-type'), events: [], rawEvents: [] };
  if (!res.ok) { out.errorBody = clip(await res.text(), 1500); out.totalMs = ms(t0); return out; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const p = parseBlock(raw);
      if (p && (p.event || p.data !== '')) { out.events.push({ ...p, tMs: ms(t0) }); out.rawEvents.push(raw); }
    }
  }
  out.totalMs = ms(t0);
  return out;
}

// ===== G. thinking+text+tool_use 单流完整序列 =====
const TOOLS = [{
  name: 'get_weather',
  description: '查询指定城市的实时天气',
  input_schema: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } }, required: ['city'] },
}];

await section('G_full_sse_sequence', async () => {
  const req = {
    model: PREVIEW, max_tokens: 800, stream: true, tools: TOOLS,
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: '请先深入思考北京与上海的气候差异（至少 4 个方面），然后调用 get_weather 查询北京天气，摄氏度。' }],
  };
  const s = await streamCapture({ body: req });
  const perBlock = {};
  let text = '', thinking = '', signature = '', partialJson = '';
  const order = [];
  for (const e of s.events) {
    const d = e.data;
    order.push(e.event);
    if (e.event === 'content_block_start') {
      perBlock[d.index] = { startKeys: Object.keys(d), blockKeys: Object.keys(d.content_block || {}), blockType: d.content_block?.type, blockTextVal: d.content_block?.text, blockThinkingVal: d.content_block?.thinking, deltas: [] };
    }
    if (e.event === 'content_block_delta') {
      perBlock[d.index] ??= { deltas: [] };
      perBlock[d.index].deltas.push({ deltaType: d.delta?.type, deltaKeys: Object.keys(d.delta || {}) });
      if (d.delta?.type === 'text_delta') text += d.delta.text ?? '';
      if (d.delta?.type === 'thinking_delta') thinking += d.delta.thinking ?? '';
      if (d.delta?.type === 'signature_delta') signature += d.delta.signature ?? '';
      if (d.delta?.type === 'input_json_delta') partialJson += d.delta.partial_json ?? '';
    }
    if (e.event === 'content_block_stop') perBlock[d.index] && (perBlock[d.index].stopDataKeys = Object.keys(d));
  }
  let toolInput = null; try { toolInput = JSON.parse(partialJson); } catch (e) { toolInput = { parseError: String(e) }; }
  const counts = {}; for (const n of order) counts[n] = (counts[n] || 0) + 1;
  const msgDelta = s.events.find((e) => e.event === 'message_delta')?.data;
  const msgStart = s.events.find((e) => e.event === 'message_start')?.data;
  log(`    status=${s.status} events=${s.events.length} counts=${JSON.stringify(counts)}`);
  log(`    perBlock types=${JSON.stringify(Object.entries(perBlock).map(([i, b]) => [i, b.blockType, b.deltas.map((x) => x.deltaType)]))}`);
  log(`    text.len=${text.length} thinking.len=${thinking.length} signature.len=${signature.length} partialJson=${clip(partialJson, 160)}`);
  log(`    message_delta=${JSON.stringify({ delta: msgDelta?.delta, usageKeys: Object.keys(msgDelta?.usage || {}) })}`);

  const rawSample = s.rawEvents.join('\n\n').slice(0, 3000);
  // 每类事件的字段名清单（去重）
  const fieldMap = {};
  for (const e of s.events) {
    const key = e.event + (e.data?.delta?.type ? `:${e.data.delta.type}` : '');
    fieldMap[key] ??= new Set();
    for (const k of Object.keys(e.data || {})) fieldMap[key].add(k);
    if (e.data?.delta) for (const k of Object.keys(e.data.delta)) fieldMap[key].add(`delta.${k}`);
    if (e.data?.content_block) for (const k of Object.keys(e.data.content_block)) fieldMap[key].add(`content_block.${k}`);
  }
  const fieldMapArr = Object.fromEntries(Object.entries(fieldMap).map(([k, v]) => [k, [...v]]));

  return {
    request: req, status: s.status, contentType: s.contentType, totalMs: s.totalMs,
    counts, order, perBlock, fieldMap: fieldMapArr,
    assembled: { textLen: text.length, textHead: clip(text, 200), thinkingLen: thinking.length, signatureLen: signature.length, partialJsonLen: partialJson.length, toolInput },
    messageStart: msgStart, messageDelta: msgDelta,
    rawSseClip: rawSample,
  };
});

// ===== H. effort 真实信号（多次采样）=====
await section('H_effort_signal', async () => {
  const PROMPT = '一个水池有甲乙两个进水管和一个排水管。甲管单独注满需 6 小时，乙管单独注满需 8 小时，排水管单独排空满池需 12 小时。三管同时打开，多久能注满？请给出完整推理。';
  const sample = async (effort, i) => {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 1500, output_config: { effort }, messages: [{ role: 'user', content: PROMPT }] }, timeoutMs: 150000 });
    return {
      effort, i, status: r.status, ms: r.ms,
      thinkingTokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null,
      outputTokens: r.json?.usage?.output_tokens ?? null,
      thinkingLen: (r.json?.content || []).filter((b) => b.type === 'thinking').map((b) => b.thinking).join('').length,
      answerLen: (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').length,
      stop: r.json?.stop_reason,
    };
  };
  const rows = [];
  for (const effort of ['low', 'max']) {
    for (let i = 0; i < 3; i++) rows.push(await sample(effort, i));
  }
  const agg = {};
  for (const e of ['low', 'max']) {
    const rs = rows.filter((r) => r.effort === e);
    const avg = (k) => Math.round(rs.reduce((s, r) => s + (r[k] || 0), 0) / rs.length);
    agg[e] = { samples: rs.length, avgThinkingTokens: avg('thinkingTokens'), avgThinkingLen: avg('thinkingLen'), avgOutputTokens: avg('outputTokens'), avgMs: avg('ms'), statuses: rs.map((r) => r.status) };
  }
  log(`    low: ${JSON.stringify(agg.low)}`);
  log(`    max: ${JSON.stringify(agg.max)}`);
  log(`    thinkingTokens: low=${JSON.stringify(rows.filter((r) => r.effort === 'low').map((r) => r.thinkingTokens))} max=${JSON.stringify(rows.filter((r) => r.effort === 'max').map((r) => r.thinkingTokens))}`);
  return { prompt: PROMPT, rows, aggregate: agg };
});

// ===== I. 流式错误形态 =====
await section('I_streaming_error_shape', async () => {
  const badParamStream = await streamCapture({ body: { model: MODEL, max_tokens: 50, stream: true, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] } });
  const badModelStream = await streamCapture({ body: { model: MODEL, max_tokens: 200, stream: true, output_config: { effort: 'ultra' }, messages: [{ role: 'user', content: 'hi' }] } });
  const okStream500 = await streamCapture({ body: { model: MODEL, max_tokens: 500, stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  log(`    thinking=disabled + stream: HTTP ${badParamStream.status} ct=${badParamStream.contentType} errBody=${clip(badParamStream.errorBody, 300)}`);
  log(`    effort=ultra + stream:      HTTP ${badModelStream.status} ct=${badModelStream.contentType} errBody=${clip(badModelStream.errorBody, 300)}`);
  log(`    normal stream: HTTP ${okStream500.status} ct=${okStream500.contentType} events=${okStream500.events.length} seq=${JSON.stringify(okStream500.events.map((e) => e.event))}`);
  const usageInStart = okStream500.events.find((e) => e.event === 'message_start')?.data?.message?.usage;
  log(`    message_start.usage=${JSON.stringify(usageInStart)}`);
  return {
    thinkingDisabledWithStream: { httpStatus: badParamStream.status, contentType: badParamStream.contentType, errorBody: badParamStream.errorBody, headers: Object.fromEntries(Object.entries(badParamStream.headers || {}).filter(([k]) => /content-type|request-id|trace/i.test(k))) },
    invalidEffortWithStream: { httpStatus: badModelStream.status, contentType: badModelStream.contentType, errorBody: badModelStream.errorBody },
    normalStream: { httpStatus: okStream500.status, contentType: okStream500.contentType, eventCount: okStream500.events.length, seq: okStream500.events.map((e) => e.event), messageStartUsage: usageInStart, messageDeltaUsage: okStream500.events.find((e) => e.event === 'message_delta')?.data?.usage },
  };
});

// ===== J. 附录：chat/completions（OpenAI 兼容面）=====
await section('J_chat_completions', async () => {
  const r = await call({ p: '/v1/chat/completions', body: { model: MODEL, max_tokens: 60, messages: [{ role: 'user', content: '只回答 ok' }] } });
  const j = r.json;
  log(`    ${r.status} topKeys=${JSON.stringify(j ? Object.keys(j) : null)} model=${j?.model} finish=${j?.choices?.[0]?.finish_reason} base_resp=${JSON.stringify(j?.base_resp)}`);
  const toolsR = await call({ p: '/v1/chat/completions', body: { model: MODEL, max_tokens: 300, tools: [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }], messages: [{ role: 'user', content: '北京天气怎样？调用 get_weather。' }] } });
  log(`    tools: ${toolsR.status} finish=${toolsR.json?.choices?.[0]?.finish_reason} tool_calls=${JSON.stringify(toolsR.json?.choices?.[0]?.message?.tool_calls?.map((t) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments })))}`);
  // 流式（OpenAI 风格 data: [DONE]）
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, max_tokens: 30, stream: true, messages: [{ role: 'user', content: '数到 3' }] }), signal: AbortSignal.timeout(60000) });
    const txt = await res.text();
    const chunks = txt.split(/\r?\n\r?\n/).filter(Boolean);
    log(`    stream: ${res.status} ct=${res.headers.get('content-type')} chunks=${chunks.length} hasDone=${txt.includes('[DONE]')} head=${clip(txt, 240)}`);
    return {
      shape: { status: r.status, topKeys: j ? Object.keys(j) : null, model: j?.model, choiceKeys: j?.choices?.[0] ? Object.keys(j.choices[0]) : null, messageKeys: j?.choices?.[0]?.message ? Object.keys(j.choices[0].message) : null, finish_reason: j?.choices?.[0]?.finish_reason, usage: j?.usage, base_resp: j?.base_resp },
      tools: { status: toolsR.status, finish_reason: toolsR.json?.choices?.[0]?.finish_reason, tool_calls: toolsR.json?.choices?.[0]?.message?.tool_calls },
      stream: { status: res.status, contentType: res.headers.get('content-type'), chunkCount: chunks.length, hasDone: txt.includes('[DONE]'), head: clip(txt, 600) },
    };
  } catch (e) {
    return { shape: { status: r.status, topKeys: j ? Object.keys(j) : null }, tools: { status: toolsR.status }, stream: { error: `${e?.name}: ${e?.message}` } };
  }
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results3.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe3.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe3 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
