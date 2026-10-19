#!/usr/bin/env node
/**
 * probe.mjs — MiniMax M Plan 订阅 Key 真实 API 契约独立验证器
 *
 * 独立实现：不依赖被测插件的任何代码，仅使用 Node 24 内置 fetch。
 * 凭据：只读解析 C:\Users\Amnesia\.dsh\.credentials.yaml 中 refs.MINIMAX_CN_API_KEY，
 *       全程不打印、不落盘。
 * 运行：node verify/probe.mjs
 * 输出：verify/results.json（结构化证据）+ 控制台摘要
 *
 * 每一步都有 AbortSignal.timeout，整体预算约 6 分钟。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------- 配置
const DIR = import.meta.dirname;
const OUT_DIR = path.join(DIR, 'out');
const BASE = 'https://api.minimax.cn';
const CRED_PATH = 'C:/Users/Amnesia/.dsh/.credentials.yaml';
const ANTHROPIC_VERSION = '2023-06-01';

const MODEL = 'MiniMax-M3.1-Flash';
const MODEL_PREVIEW = 'MiniMax-M3.1-Flash-Preview';
const IMAGE_MODEL = 'image-01';

const startAll = performance.now();
const results = {
  startedAt: new Date().toISOString(),
  base: BASE,
  node: process.version,
  probes: {},
};
const sections = {};
const consoleLines = [];
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  consoleLines.push(line);
  console.log(line);
};
const clip = (s, n = 600) => {
  if (s === undefined || s === null) return String(s);
  if (typeof s !== 'string') s = JSON.stringify(s) ?? String(s);
  return s.length <= n ? s : `${s.slice(0, n)}…[+${s.length - n} chars]`;
};
const ms = (t0) => Math.round(performance.now() - t0);
const elapsed = () => ms(startAll);

// ---------------------------------------------------------------- 凭据
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
  throw new Error('MINIMAX_CN_API_KEY 未在 credentials refs 中找到');
}

// ---------------------------------------------------------------- HTTP 基础
function baseHeaders(key, withBody) {
  const h = { authorization: `Bearer ${key}`, 'anthropic-version': ANTHROPIC_VERSION };
  if (withBody) h['content-type'] = 'application/json';
  return h;
}

async function call({ p, method = 'POST', body, key, timeoutMs = 60000, extraHeaders = {} }) {
  const url = p.startsWith('http') ? p : BASE + p;
  const k = key ?? KEY;
  const headers = { ...baseHeaders(k, body !== undefined), ...extraHeaders };
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
      ok: res.ok, status: res.status, ms: ms(t0), url, method,
      headers: Object.fromEntries(res.headers), text, json,
    };
  } catch (e) {
    return {
      ok: false, status: 0, ms: ms(t0), url, method, headers: {},
      text: '', json: null, error: `${e?.name || 'Error'}: ${e?.message || e}`,
    };
  }
}

// ---------------------------------------------------------------- SSE 流式
function parseSSEBlock(raw) {
  let event = null;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!event && dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data = dataStr;
  if (dataStr !== '[DONE]') {
    try { data = JSON.parse(dataStr); } catch { /* keep string */ }
  }
  return { event, data };
}

async function streamCall({ body, key, timeoutMs = 150000 }) {
  const t0 = performance.now();
  const url = `${BASE}/anthropic/v1/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...baseHeaders(key ?? KEY, true), accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const out = { status: res.status, ms0: ms(t0), headers: Object.fromEntries(res.headers), events: [], rawClip: '' };
    if (!res.ok) {
      out.text = clip(await res.text(), 2000);
      return out;
    }
    out.contentType = res.headers.get('content-type');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const events = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      out.rawClip = clip(buf, 4000);
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const ev = parseSSEBlock(raw);
        if (ev) events.push({ ...ev, tMs: ms(t0) });
      }
    }
    out.events = events;
    out.totalMs = ms(t0);
    return out;
  } catch (e) {
    return { status: 0, ms0: ms(t0), events: [], error: `${e?.name || 'Error'}: ${e?.message || e}` };
  }
}

function summarizeStream(s) {
  if (!s || !s.events) return { status: s?.status, error: s?.error };
  const seq = s.events.map((e) => e.event);
  const counts = {};
  for (const n of seq) counts[n] = (counts[n] || 0) + 1;

  const deltaKeys = {};
  const blockStartByIndex = {};
  const deltaOrderByIndex = {};
  let text = '';
  let thinking = '';
  let signature = '';
  let partialJson = '';
  const messageStart = {};
  let messageDelta = null;
  let messageStop = null;

  for (const e of s.events) {
    const d = e.data;
    if (e.event === 'message_start' && d && typeof d === 'object') {
      messageStart.keys = Object.keys(d);
      messageStart.messageKeys = d.message ? Object.keys(d.message) : null;
      messageStart.usage = d.message?.usage;
      messageStart.model = d.message?.model;
    }
    if (e.event === 'content_block_start' && d && typeof d === 'object') {
      blockStartByIndex[d.index] = { type: d.content_block?.type, keys: Object.keys(d.content_block || {}) };
    }
    if (e.event === 'content_block_delta' && d && typeof d === 'object') {
      const dt = d.delta?.type || '(none)';
      deltaKeys[dt] = deltaKeys[dt] || new Set();
      for (const k of Object.keys(d.delta || {})) deltaKeys[dt].add(k);
      (deltaOrderByIndex[d.index] ||= []).push(dt);
      if (dt === 'text_delta') text += d.delta.text ?? '';
      else if (dt === 'thinking_delta') thinking += d.delta.thinking ?? '';
      else if (dt === 'signature_delta') signature += d.delta.signature ?? '';
      else if (dt === 'input_json_delta') partialJson += d.delta.partial_json ?? '';
    }
    if (e.event === 'message_delta' && d && typeof d === 'object') {
      messageDelta = { keys: Object.keys(d), deltaKeys: d.delta ? Object.keys(d.delta) : null, delta: d.delta, usage: d.usage };
    }
    if (e.event === 'message_stop' && d && typeof d === 'object') {
      messageStop = { keys: Object.keys(d), data: d };
    }
  }
  const deltaKeyPlain = {};
  for (const [k, v] of Object.entries(deltaKeys)) deltaKeyPlain[k] = [...v];

  let parsedToolInput = null;
  if (partialJson) { try { parsedToolInput = JSON.parse(partialJson); } catch (err) { parsedToolInput = { parseError: String(err) }; } }

  return {
    status: s.status,
    contentType: s.contentType,
    totalMs: s.totalMs,
    eventCount: s.events.length,
    sequence: seq,
    counts,
    messageStart,
    blockStartByIndex,
    deltaOrderByIndex,
    deltaKeys: deltaKeyPlain,
    messageDelta,
    messageStop,
    assembled: {
      textLen: text.length, textHead: clip(text, 300),
      thinkingLen: thinking.length, thinkingHead: clip(thinking, 300),
      signatureLen: signature.length, signatureHead: clip(signature, 80),
      partialJsonLen: partialJson.length, partialJsonHead: clip(partialJson, 400), parsedToolInput,
    },
    rawClip: s.rawClip,
  };
}

// ---------------------------------------------------------------- 通用形状提取
function msgShape(j) {
  if (!j || typeof j !== 'object') return j;
  return {
    topKeys: Object.keys(j),
    id: j.id, type: j.type, role: j.role, model: j.model,
    stop_reason: j.stop_reason, stop_sequence: j.stop_sequence,
    usage: j.usage,
    base_resp: j.base_resp,
    contentTypes: Array.isArray(j.content) ? j.content.map((b) => b.type) : null,
    content: Array.isArray(j.content) ? j.content.map((b) => {
      if (b.type === 'text') return { type: 'text', keys: Object.keys(b), textLen: (b.text || '').length, textHead: clip(b.text, 200) };
      if (b.type === 'thinking') return { type: 'thinking', keys: Object.keys(b), thinkingLen: (b.thinking || '').length, thinkingHead: clip(b.thinking, 200), hasSignature: typeof b.signature === 'string', signatureLen: (b.signature || '').length };
      if (b.type === 'tool_use') return { type: 'tool_use', keys: Object.keys(b), id: b.id, name: b.name, input: b.input };
      return { type: b.type, keys: Object.keys(b), raw: clip(b, 400) };
    }) : null,
    error: j.error ? { keys: Object.keys(j.error), type: j.error.type, code: j.error.code, message: clip(j.error.message, 300) } : undefined,
  };
}

function errShape(r) {
  return {
    status: r.status, ms: r.ms,
    headersClip: Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => /content-type|retry|ratelimit|minimax|request-id|trace/i.test(k))),
    bodyKeys: r.json ? Object.keys(r.json) : null,
    bodyClip: clip(r.text, 1200),
    parsedError: r.json?.error ? {
      keys: Object.keys(r.json.error),
      type: r.json.error.type, code: r.json.error.code,
      message: clip(r.json.error.message, 300),
      typeOfCode: typeof r.json.error.code,
    } : r.json?.base_resp ? { base_resp: r.json.base_resp } : 'no error object',
  };
}

// ---------------------------------------------------------------- section 包装
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try {
    const r = await fn();
    sections[name] = { ...r, elapsedMs: ms(t0) };
    log(`    ok (${ms(t0)}ms)`);
  } catch (e) {
    sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) };
    log(`    FAILED: ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------- 主流程
const KEY = await loadKey();
log(`key loaded (len=${KEY.length}, prefix=${KEY.slice(0, 6)}), node=${process.version}`);
await fs.mkdir(OUT_DIR, { recursive: true });

// ===== 1. 非流式 messages 结构 =====
await section('1_nonstream_messages', async () => {
  const plain = await call({
    p: '/anthropic/v1/messages',
    body: { model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: '用一句话解释什么是二分查找。' }] },
  });
  log(`    plain: ${plain.status} ${plain.ms}ms`);
  const preview = await call({
    p: '/anthropic/v1/messages',
    body: { model: MODEL_PREVIEW, max_tokens: 60, messages: [{ role: 'user', content: '回答：ok' }] },
  });
  log(`    preview: ${preview.status} ${preview.ms}ms`);

  const sys = await call({
    p: '/anthropic/v1/messages',
    body: {
      model: MODEL, max_tokens: 80,
      system: '你是一个只用英文回答的助手，回答不超过 5 个词。',
      messages: [{ role: 'user', content: '用中文说你好' }],
    },
  });
  log(`    system(string): ${sys.status} ${sys.ms}ms -> ${clip(sys.json?.content?.[1]?.text || sys.json?.content?.[0]?.text || sys.text, 120)}`);

  const toolCall = await call({
    p: '/anthropic/v1/messages',
    body: {
      model: MODEL, max_tokens: 400,
      tools: [{
        name: 'get_weather',
        description: '查询指定城市的实时天气',
        input_schema: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
      }],
      messages: [{ role: 'user', content: '北京今天天气怎么样？请调用 get_weather 工具查询。' }],
    },
  });
  log(`    tool_call: ${toolCall.status} ${toolCall.ms}ms types=${JSON.stringify(toolCall.json?.content?.map((b) => b.type))}`);

  return {
    base: { status: plain.status, headersClip: Object.fromEntries(Object.entries(plain.headers).filter(([k]) => /content-type|minimax|request-id|trace|ratelimit/i.test(k))) },
    plain: { status: plain.status, ms: plain.ms, shape: msgShape(plain.json), rawClip: clip(plain.text, 2500) },
    preview: { status: preview.status, ms: preview.ms, shape: msgShape(preview.json), rawClip: clip(preview.text, 1200) },
    modelAvailability: {
      [MODEL]: plain.status === 200,
      [MODEL_PREVIEW]: preview.status === 200,
      'MiniMax-M3.1-Flash': plain.json?.model === MODEL,
    },
    systemString: { status: sys.status, ms: sys.ms, shape: msgShape(sys.json), rawClip: clip(sys.text, 1200) },
    toolCall: { status: toolCall.status, ms: toolCall.ms, shape: msgShape(toolCall.json), rawClip: clip(toolCall.text, 2500) },
  };
});

// ===== 2. 流式 SSE =====
await section('2_sse_stream', async () => {
  const textStream = await streamCall({
    body: { model: MODEL, max_tokens: 300, stream: true, messages: [{ role: 'user', content: '用两句话介绍杭州。' }] },
  });
  const textSum = summarizeStream(textStream);
  log(`    text stream: ${textSum.status} events=${textSum.eventCount} seq=${textSum.sequence?.slice(0, 12).join(',')}`);

  const toolStream = await streamCall({
    body: {
      model: MODEL, max_tokens: 400, stream: true,
      tools: [{
        name: 'get_weather',
        description: '查询指定城市的实时天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } }, required: ['city'] },
      }],
      messages: [{ role: 'user', content: '北京天气如何？调用 get_weather，用摄氏度。' }],
    },
  });
  const toolSum = summarizeStream(toolStream);
  log(`    tool stream: ${toolSum.status} events=${toolSum.eventCount} deltas=${JSON.stringify(toolSum.deltaKeys)}`);
  log(`    parsedToolInput=${clip(toolSum.assembled?.parsedToolInput, 200)}`);

  return { text: textSum, tool: toolSum };
});

// ===== 3. 多轮工具调用 + thinking 回传 =====
await section('3_tool_loop_thinking_replay', async () => {
  const TOOLS = [{
    name: 'get_weather',
    description: '查询指定城市的实时天气',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }];
  const FIRST = '请先深入思考北京和上海的气候差异（至少 3 点），然后调用 get_weather 查询北京天气。';
  // thinking + tool_use 同回合需要足够的预算 + 较高 effort；带 tools 的普通回合常常不产 thinking。
  // 依次尝试，直到拿到同时含 thinking 与 tool_use 的回合（配方见 REPORT.md §5.4）。
  const RECIPES = [
    { model: MODEL_PREVIEW, extra: { output_config: { effort: 'max' } }, maxTokens: 1200 },
    { model: MODEL_PREVIEW, extra: { output_config: { effort: 'xhigh' } }, maxTokens: 900 },
    { model: MODEL, extra: { output_config: { effort: 'xhigh' } }, maxTokens: 900 },
    { model: MODEL, extra: {}, maxTokens: 900 }, // 兜底：可能无 thinking
  ];
  let turn1 = null; let recipe = null;
  for (const r of RECIPES) {
    const res = await call({
      p: '/anthropic/v1/messages',
      body: { model: r.model, max_tokens: r.maxTokens, tools: TOOLS, messages: [{ role: 'user', content: FIRST }], ...r.extra },
      timeoutMs: 150000,
    });
    const types = (res.json?.content || []).map((b) => b.type);
    log(`    turn1 try ${r.model} ${JSON.stringify(r.extra)} -> ${res.status} types=${JSON.stringify(types)}`);
    if (types.includes('thinking') && types.includes('tool_use')) { turn1 = res; recipe = r; break; }
    turn1 ??= res; // 保留第一次结果作为兜底
  }
  const blocks = turn1.json?.content || [];
  const thinkingBlock = blocks.find((b) => b.type === 'thinking');
  const toolUse = blocks.find((b) => b.type === 'tool_use');
  log(`    turn1: ${turn1.status} blocks=${JSON.stringify(blocks.map((b) => b.type))} toolUse=${toolUse ? toolUse.name : 'none'} stop=${turn1.json?.stop_reason}`);

  const toolResult = toolUse ? {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '晴，25°C，西北风 2 级' }],
  } : null;

  // 变体 A：完整回传 thinking + tool_use
  // 回放沿用 turn1 的 model 与 effort（M3.1-Flash 上 thinking 相关参数必须一致才不 400）
  const replayBase = { model: turn1.json?.model ?? recipe.model, max_tokens: 300, tools: TOOLS, ...(recipe?.extra ?? {}) };
  const variantA = toolUse ? await call({
    p: '/anthropic/v1/messages',
    body: {
      ...replayBase,
      messages: [
        { role: 'user', content: FIRST },
        { role: 'assistant', content: thinkingBlock ? [thinkingBlock, toolUse] : [toolUse] },
        toolResult,
      ],
    },
  }) : { status: -1 };
  log(`    A(full replay): ${variantA.status} -> ${clip(variantA.json?.content?.filter((b) => b.type === 'text').map((b) => b.text).join(''), 160)}`);

  // 变体 B：只回传 tool_use，不回传 thinking
  const variantB = toolUse ? await call({
    p: '/anthropic/v1/messages',
    body: {
      ...replayBase,
      messages: [
        { role: 'user', content: FIRST },
        { role: 'assistant', content: [toolUse] },
        toolResult,
      ],
    },
  }) : { status: -1 };
  log(`    B(no thinking): ${variantB.status} err=${clip(variantB.json?.error?.message || variantB.text, 200)}`);

  // 变体 C：回传 thinking 但签名被破坏
  let variantC = { status: -1 };
  if (thinkingBlock && toolUse) {
    variantC = await call({
      p: '/anthropic/v1/messages',
      body: {
        ...replayBase,
        messages: [
          { role: 'user', content: FIRST },
          { role: 'assistant', content: [{ ...thinkingBlock, signature: 'deadbeef'.repeat(8) }, toolUse] },
          toolResult,
        ],
      },
    });
  }
  log(`    C(bad signature): ${variantC.status} err=${clip(variantC.json?.error?.message || variantC.text, 200)}`);

  return {
    turn1: { status: turn1.status, ms: turn1.ms, model: turn1.json?.model, recipe: recipe ? { model: recipe.model, extra: recipe.extra, maxTokens: recipe.maxTokens } : null, stop_reason: turn1.json?.stop_reason, shape: msgShape(turn1.json), rawClip: clip(turn1.text, 2500) },
    toolUse: toolUse ? { id: toolUse.id, name: toolUse.name, input: toolUse.input, keys: Object.keys(toolUse) } : null,
    thinkingBlock: thinkingBlock ? { keys: Object.keys(thinkingBlock), signatureLen: thinkingBlock.signature?.length ?? 0, thinkingLen: thinkingBlock.thinking?.length ?? 0 } : null,
    variantA_fullReplay: { status: variantA.status, ms: variantA.ms, shape: msgShape(variantA.json), rawClip: clip(variantA.text, 1800) },
    variantB_noThinking: { status: variantB.status, ms: variantB.ms, err: errShape(variantB) },
    variantC_badSignature: { status: variantC.status, ms: variantC.ms, err: errShape(variantC) },
    note: thinkingBlock ? undefined : '本轮未产生 thinking 块（带 tools 的回合常见），故变体 C 未测',
  };
});

// ===== 4. 思考深度 / thinking 开关 =====
await section('4_effort_and_thinking', async () => {
  const PROMPT = '请计算 37*24+19 并简要说明步骤。';
  const run = async (label, extra) => {
    const r = await call({
      p: '/anthropic/v1/messages',
      body: { model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: PROMPT }], ...extra },
      timeoutMs: 120000,
    });
    const types = r.json?.content?.map((b) => b.type) || [];
    const u = r.json?.usage;
    const rec = {
      label, status: r.status, ms: r.ms, contentTypes: types,
      stop_reason: r.json?.stop_reason,
      usage: u,
      thinkingTokens: u?.output_tokens_details?.thinking_tokens ?? null,
      outputTokens: u?.output_tokens ?? null,
      hasThinkingBlock: types.includes('thinking'),
      errText: r.ok ? undefined : clip(r.text, 500),
    };
    log(`    ${label}: status=${rec.status} ms=${rec.ms} thinking=${rec.thinkingTokens} out=${rec.outputTokens} types=${JSON.stringify(types)}${rec.errText ? ` err=${clip(rec.errText, 160)}` : ''}`);
    return rec;
  };

  const out = { effort: {}, thinking: {} };
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    out.effort[effort] = await run(`effort=${effort}`, { output_config: { effort } });
  }
  out.effort.__invalid = await run('effort=ultra(非法)', { output_config: { effort: 'ultra' } });
  out.thinking.disabled = await run('thinking=disabled', { thinking: { type: 'disabled' } });
  out.thinking.enabled1024 = await run('thinking=enabled(1024)', { thinking: { type: 'enabled', budget_tokens: 1024 } });
  out.comparison = Object.fromEntries(
    Object.entries(out.effort).map(([k, v]) => [k, { status: v.status, thinkingTokens: v.thinkingTokens, outputTokens: v.outputTokens, ms: v.ms }]),
  );
  return out;
});

// ===== 5. 图片生成 =====
const sniff = (buf) => {
  const h = buf.subarray(0, 12).toString('hex');
  let fmt = 'unknown';
  if (h.startsWith('89504e470d0a1a0a')) fmt = 'png';
  else if (h.startsWith('ffd8ff')) fmt = 'jpeg';
  else if (buf.subarray(0, 4).toString() === 'RIFF') fmt = 'webp';
  else if (h.startsWith('47494638')) fmt = 'gif';
  return { fmt, hex: h };
};

async function saveB64(name, b64) {
  const buf = Buffer.from(b64, 'base64');
  const s = sniff(buf);
  const file = path.join(OUT_DIR, `${name}.${s.fmt}`);
  await fs.writeFile(file, buf);
  return { bytes: buf.length, format: s.fmt, magicHex: s.hex, savedTo: path.relative(DIR, file) };
}

await section('5_image_generation', async () => {
  const prompt = '一只橘猫坐在木窗台上看向窗外，水彩画风格';
  const imgCall = async (label, extra, timeoutMs = 120000) => {
    const r = await call({
      p: '/v1/image_generation',
      body: { model: IMAGE_MODEL, prompt, ...extra },
      timeoutMs,
    });
    return r;
  };

  // 5a base64
  const b64r = await imgCall('base64', { aspect_ratio: '1:1', response_format: 'base64', n: 1, prompt_optimizer: true });
  const b64Json = b64r.json;
  let b64Image = null;
  const b64str = b64Json?.data?.image_base64?.[0];
  if (b64str) {
    const fileInfo = await saveB64('img-base64-1x1', b64str);
    b64Image = {
      type: typeof b64str,
      length: b64str.length,
      startsWithDataUri: b64str.startsWith('data:'),
      first40: b64str.slice(0, 40),
      validBase64Chars: /^[A-Za-z0-9+/=\r\n]+$/.test(b64str.slice(0, 200)),
      ...fileInfo,
    };
  }
  log(`    5a base64: status=${b64r.status} ms=${b64r.ms} img=${JSON.stringify(b64Image)}`);
  log(`        bodyKeys=${JSON.stringify(b64Json ? Object.keys(b64Json) : null)} dataKeys=${JSON.stringify(b64Json?.data ? Object.keys(b64Json.data) : null)} metadata=${JSON.stringify(b64Json?.metadata)} base_resp=${JSON.stringify(b64Json?.base_resp)}`);

  const metaTypes = b64Json?.metadata ? Object.fromEntries(
    Object.entries(b64Json.metadata).map(([k, v]) => [k, { value: v, type: typeof v }]),
  ) : null;

  // 5b url
  const urlr = await imgCall('url', { aspect_ratio: '16:9', response_format: 'url', n: 1, prompt_optimizer: true });
  const urlJson = urlr.json;
  const url0 = urlJson?.data?.image_urls?.[0];
  let urlImage = null;
  if (url0) {
    const t0 = performance.now();
    try {
      const fres = await fetch(url0, { signal: AbortSignal.timeout(60000) });
      const ab = await fres.arrayBuffer();
      const buf = Buffer.from(ab);
      const s = sniff(buf);
      urlImage = {
        httpStatus: fres.status, bytes: buf.length, format: s.fmt, magicHex: s.hex,
        urlPrefix: url0.slice(0, 60), fetchMs: ms(t0), contentType: fres.headers.get('content-type'),
        savedTo: await (async () => { const f = path.join(OUT_DIR, `img-url-16x9.${s.fmt}`); await fs.writeFile(f, buf); return path.relative(DIR, f); })(),
      };
    } catch (e) {
      urlImage = { fetchError: `${e?.name}: ${e?.message}`, urlPrefix: url0.slice(0, 60) };
    }
  }
  log(`    5b url: status=${urlr.status} ms=${urlr.ms} urlImage=${JSON.stringify(urlImage)}`);
  log(`        bodyKeys=${JSON.stringify(urlJson ? Object.keys(urlJson) : null)} dataKeys=${JSON.stringify(urlJson?.data ? Object.keys(urlJson.data) : null)}`);

  // 5c n=2
  const n2r = await imgCall('n2', { aspect_ratio: '4:3', response_format: 'base64', n: 2, prompt_optimizer: false });
  const n2Json = n2r.json;
  const n2arr = n2Json?.data?.image_base64 || [];
  const n2details = [];
  for (let i = 0; i < n2arr.length; i++) {
    n2details.push(await saveB64(`img-n2-${i}`, n2arr[i]));
  }
  log(`    5c n=2: status=${n2r.status} ms=${n2r.ms} images=${n2arr.length} success_count=${JSON.stringify(n2Json?.metadata?.success_count)} details=${JSON.stringify(n2details.map((d) => ({ bytes: d.bytes, format: d.format })))}`);

  // 5d aspect_ratio 枚举边界（非法值）
  const badAspect = await imgCall('badAspect', { aspect_ratio: '5:4', response_format: 'base64', n: 1 }, 90000);
  const badAspectJson = badAspect.json;
  log(`    5d aspect=5:4(非法): status=${badAspect.status} base_resp=${JSON.stringify(badAspectJson?.base_resp)} dataImages=${badAspectJson?.data?.image_base64?.length ?? 'n/a'}`);

  return {
    model: IMAGE_MODEL,
    base64: {
      request: { model: IMAGE_MODEL, aspect_ratio: '1:1', response_format: 'base64', n: 1, prompt_optimizer: true },
      status: b64r.status, ms: b64r.ms,
      topKeys: b64Json ? Object.keys(b64Json) : null,
      dataKeys: b64Json?.data ? Object.keys(b64Json.data) : null,
      metadata: b64Json?.metadata ?? null,
      metadataTypes: metaTypes,
      base_resp: b64Json?.base_resp ?? null,
      base_resp_status_type: typeof b64Json?.base_resp?.status_code,
      image: b64Image,
      rawClip: clip(b64r.text, 1200),
    },
    url: {
      request: { model: IMAGE_MODEL, aspect_ratio: '16:9', response_format: 'url', n: 1, prompt_optimizer: true },
      status: urlr.status, ms: urlr.ms,
      topKeys: urlJson ? Object.keys(urlJson) : null,
      dataKeys: urlJson?.data ? Object.keys(urlJson.data) : null,
      imageUrlCount: urlJson?.data?.image_urls?.length ?? 0,
      base_resp: urlJson?.base_resp ?? null,
      downloaded: urlImage,
      rawClip: clip(urlr.text, 1200),
    },
    n2: {
      request: { model: IMAGE_MODEL, aspect_ratio: '4:3', response_format: 'base64', n: 2, prompt_optimizer: false },
      status: n2r.status, ms: n2r.ms,
      imageCount: n2arr.length,
      metadata: n2Json?.metadata ?? null,
      metadataTypes: n2Json?.metadata ? Object.fromEntries(Object.entries(n2Json.metadata).map(([k, v]) => [k, typeof v])) : null,
      base_resp: n2Json?.base_resp ?? null,
      images: n2details,
    },
    badAspectRatio: { request: '5:4', status: badAspect.status, ms: badAspect.ms, base_resp: badAspectJson?.base_resp ?? null, bodyClip: clip(badAspect.text, 800) },
  };
});

// ===== 6. 错误路径 =====
await section('6_error_paths', async () => {
  const BAD = 'sk-invalid-verification-key-000000000000';
  const badMsg = await call({
    p: '/anthropic/v1/messages',
    key: BAD, timeoutMs: 30000,
    body: { model: MODEL, max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] },
  });
  const badImg = await call({
    p: '/v1/image_generation',
    key: BAD, timeoutMs: 30000,
    body: { model: IMAGE_MODEL, prompt: 'test', n: 1 },
  });
  const badModel = await call({
    p: '/anthropic/v1/messages', timeoutMs: 30000,
    body: { model: 'MiniMax-Not-Exist', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] },
  });
  const badImgModel = await call({
    p: '/v1/image_generation', timeoutMs: 30000,
    body: { model: 'image-999', prompt: 'test', n: 1 },
  });
  log(`    badKey messages: ${badMsg.status} ${clip(badMsg.text, 220)}`);
  log(`    badKey image:    ${badImg.status} ${clip(badImg.text, 260)}`);
  log(`    badModel:        ${badModel.status} ${clip(badModel.text, 220)}`);
  log(`    badImageModel:   ${badImgModel.status} ${clip(badImgModel.text, 260)}`);

  return {
    badKeyMessages: errShape(badMsg),
    badKeyImage: errShape(badImg),
    badModel: errShape(badModel),
    badImageModel: errShape(badImgModel),
  };
});

// ===== 7. 并发/限流 =====
await section('7_concurrency_rate_limit', async () => {
  const t0 = performance.now();
  const jobs = Array.from({ length: 5 }, (_, i) => call({
    p: '/anthropic/v1/messages', timeoutMs: 90000,
    body: { model: MODEL, max_tokens: 16, messages: [{ role: 'user', content: `只回答数字：${i}+1=?` }] },
  }).then((r) => ({
    i, status: r.status, ms: r.ms,
    err: r.ok ? undefined : clip(r.json?.error?.message || r.text, 200),
    retryAfter: r.headers?.['retry-after'],
    rateLimitHeaders: Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => /ratelimit|retry|quota|limit/i.test(k))),
    requestId: r.headers?.['minimax-request-id'] || r.headers?.['x-request-id'],
  })));
  const settled = await Promise.all(jobs);
  const statuses = settled.map((s) => s.status);
  const any429 = statuses.includes(429);
  const any1002 = settled.some((s) => /1002/.test(s.err || ''));
  const rateHeadersSeen = settled.some((s) => Object.keys(s.rateLimitHeaders || {}).length > 0);
  log(`    statuses=${JSON.stringify(statuses)} wallMs=${ms(t0)} any429=${any429} any1002=${any1002} rateLimitHeaders=${rateHeadersSeen}`);
  return {
    wallMs: ms(t0), statuses, any429, any1002, rateHeadersSeen,
    perRequest: settled,
    headerProbe: settled[0]?.rateLimitHeaders,
  };
});

// ===== 8. 模型列表 =====
await section('8_models_list', async () => {
  const r = await call({ p: '/anthropic/v1/models?limit=1000', method: 'GET', timeoutMs: 30000 });
  const r20 = await call({ p: '/anthropic/v1/models?limit=20', method: 'GET', timeoutMs: 30000 });
  const list = Array.isArray(r.json?.data) ? r.json.data : [];
  const ids = list.map((m) => m.id);
  log(`    limit=1000: ${r.status} count=${list.length} ids=${JSON.stringify(ids)}`);
  log(`    limit=20:   ${r20.status} count=${r20.json?.data?.length}`);
  return {
    status: r.status, ms: r.ms, topKeys: r.json ? Object.keys(r.json) : null,
    count: list.length,
    ids,
    models: list.map((m) => ({ id: m.id, type: m.type, display_name: m.display_name, created_at: m.created_at })),
    limit20: { status: r20.status, count: r20.json?.data?.length ?? null, ids: (r20.json?.data || []).map((m) => m.id) },
    trimmedForLimit: r.json?.has_more ?? null,
    rawClip: clip(r.text, 3000),
  };
});

// ---------------------------------------------------------------- 落盘
results.finishedAt = new Date().toISOString();
results.elapsedMs = elapsed();
results.probes = sections;
await fs.writeFile(path.join(DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe.log'), consoleLines.join('\n') + '\n', 'utf8');
log(`\n=== DONE in ${(results.elapsedMs / 1000).toFixed(1)}s -> ${path.join(DIR, 'results.json')} ===`);
