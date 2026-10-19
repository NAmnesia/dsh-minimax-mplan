#!/usr/bin/env node
/**
 * probe5.mjs — 收尾：max_tokens 精确性、图片参数边界、chat 错误形态、
 *              限流压力、SSE 是否带 [DONE]、视觉输入、base_resp 出现规律。
 * 运行：node verify/probe5.mjs → verify/results5.json
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

async function call({ p, method = 'POST', body, timeoutMs = 120000, headers = {}, key = KEY }) {
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

// ===== P. max_tokens 精确性 =====
await section('P_max_tokens_precision', async () => {
  const out = [];
  for (const mt of [1, 5, 20, 100]) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: mt, messages: [{ role: 'user', content: '请详细解释快速排序算法的原理、复杂度与实现细节。' }] } });
    const rec = { max_tokens: mt, status: r.status, stop: r.json?.stop_reason, output_tokens: r.json?.usage?.output_tokens, thinking_tokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null, types: ctypes(r.json), err: r.json?.error ? clip(r.json.error.message, 200) : undefined };
    out.push(rec);
    log(`    max_tokens=${mt}: ${r.status} stop=${rec.stop} out=${rec.output_tokens} think=${rec.thinking_tokens} types=${JSON.stringify(rec.types)}`);
  }
  // base_resp 出现频率抽样
  const withBase = [];
  for (let i = 0; i < 4; i++) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 24, messages: [{ role: 'user', content: '只回答 ok' }] } });
    withBase.push({ hasBaseResp: !!r.json?.base_resp, base_resp: r.json?.base_resp ?? null, topKeys: Object.keys(r.json || {}), hasServiceTier: !!r.json?.usage?.service_tier, service_tier: r.json?.usage?.service_tier ?? null });
  }
  log(`    base_resp 抽样: ${JSON.stringify(withBase.map((x) => x.hasBaseResp))} service_tier=${JSON.stringify(withBase.map((x) => x.service_tier))}`);
  return { precision: out, baseRespSampling: withBase };
});

// ===== Q. 图片参数边界 =====
await section('Q_image_param_edges', async () => {
  const cases = [
    { label: 'response_format=invalid', body: { model: 'image-01', prompt: '花', n: 1, response_format: 'png' } },
    { label: 'prompt_optimizer 缺省', body: { model: 'image-01', prompt: '花', n: 1, response_format: 'url' } },
    { label: 'n=0', body: { model: 'image-01', prompt: '花', n: 0, response_format: 'url' } },
    { label: 'n=10', body: { model: 'image-01', prompt: '花', n: 10, response_format: 'url' } },
    { label: '缺 prompt', body: { model: 'image-01', n: 1, response_format: 'url' } },
    { label: 'aspect_ratio=21:9', body: { model: 'image-01', prompt: '花', n: 1, response_format: 'url', aspect_ratio: '21:9' } },
  ];
  const out = {};
  for (const c of cases) {
    const r = await call({ p: '/v1/image_generation', body: c.body, timeoutMs: 180000 });
    const n = r.json?.data?.image_urls?.length ?? r.json?.data?.image_base64?.length ?? null;
    out[c.label] = { status: r.status, ms: r.ms, images: n, base_resp: r.json?.base_resp ?? null, metadata: r.json?.metadata ?? null, bodyClip: r.ok && n ? undefined : clip(r.text, 400) };
    log(`    ${c.label}: HTTP ${r.status} images=${n} base_resp=${JSON.stringify(r.json?.base_resp)} ${n ? '' : clip(r.text, 200)}`);
  }
  return out;
});

// ===== R. chat/completions 错误形态 + 订阅 key 可用性 =====
await section('R_chat_error_and_models', async () => {
  const badKey = await call({ p: '/v1/chat/completions', key: 'sk-bogus-chat-000000', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } });
  const badModel = await call({ p: '/v1/chat/completions', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 20 } });
  // chat 的非流式 usage 与 content 结构
  const ok = await call({ p: '/v1/chat/completions', body: { model: MODEL, max_tokens: 40, messages: [{ role: 'system', content: '只回答 ok' }, { role: 'user', content: '你好' }] } });
  log(`    bad key: HTTP ${badKey.status} body=${clip(badKey.text, 300)}`);
  log(`    bad model(gpt-4o): HTTP ${badModel.status} returned=${badModel.json?.model} base_resp=${JSON.stringify(badModel.json?.base_resp)}`);
  log(`    ok: HTTP ${ok.status} msgKeys=${JSON.stringify(Object.keys(ok.json?.choices?.[0]?.message || {}))} hasReasoning=${!!ok.json?.choices?.[0]?.message?.reasoning_content} len=${ok.json?.choices?.[0]?.message?.reasoning_content?.length ?? 0}`);
  return {
    badKey: { status: badKey.status, headers: Object.fromEntries(Object.entries(badKey.headers || {}).filter(([k]) => /content-type|request-id|trace/i.test(k))), bodyClip: clip(badKey.text, 600) },
    badModel: { status: badModel.status, model: badModel.json?.model ?? null, base_resp: badModel.json?.base_resp ?? null, bodyClip: clip(badModel.text, 500) },
    ok: { status: ok.status, choiceKeys: Object.keys(ok.json?.choices?.[0] || {}), messageKeys: Object.keys(ok.json?.choices?.[0]?.message || {}), reasoningLen: ok.json?.choices?.[0]?.message?.reasoning_content?.length ?? 0, text: clip(ok.json?.choices?.[0]?.message?.content, 120), usage: ok.json?.usage },
  };
});

// ===== S. 限流压力（并发 20）=====
await section('S_rate_limit_burst', async () => {
  const t0 = performance.now();
  const N = 20;
  const jobs = Array.from({ length: N }, (_, i) => call({ p: '/anthropic/v1/messages', timeoutMs: 120000, body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: `${i}` }] } }).then((r) => ({ i, status: r.status, ms: r.ms, err: r.ok ? null : clip(r.json?.error?.message || r.text, 180), baseResp: r.json?.base_resp ?? null })));
  const settled = await Promise.all(jobs);
  const byStatus = {};
  for (const s of settled) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  const non200 = settled.filter((s) => s.status !== 200);
  log(`    并发 ${N}: wall=${ms(t0)}ms statuses=${JSON.stringify(byStatus)} 非200=${non200.length}`);
  if (non200.length) log(`    非200 样本: ${JSON.stringify(non200.slice(0, 3))}`);
  // 单独打一次并抓全部响应头
  const probe = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '1' }] } });
  log(`    响应头全集: ${JSON.stringify(probe.headers)}`);
  return { concurrency: N, wallMs: ms(t0), byStatus, non200Samples: non200.slice(0, 5), allHeaders: probe.headers, headersWithRateInfo: Object.fromEntries(Object.entries(probe.headers).filter(([k]) => /rate|limit|quota|retry/i.test(k))) };
});

// ===== T. SSE 格式细节：event 行/ data 行 / 是否 [DONE] =====
await section('T_sse_format_details', async () => {
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL, max_tokens: 60, stream: true, messages: [{ role: 'user', content: '说一句话' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const everyHasEvent = blocks.every((b) => /^event:/.test(b));
  const everyHasData = blocks.every((b) => /^data:/.test(b));
  const hasDone = raw.includes('[DONE]');
  const hasComment = raw.split('\n').some((l) => l.startsWith(':'));
  const eofNewlines = raw.endsWith('\n\n');
  const crlf = raw.includes('\r\n');
  const eventNames = [...new Set(blocks.map((b) => (b.match(/^event:\s*(.+)$/m) || [])[1]).filter(Boolean))];
  // data 中的 type 是否与 event 名一致
  const typeMatchesEvent = blocks.every((b) => {
    const ev = (b.match(/^event:\s*(.+)$/m) || [])[1];
    const dm = b.match(/^data:\s*(.+)$/m);
    if (!ev || !dm) return false;
    try { return JSON.parse(dm[1]).type === ev; } catch { return false; }
  });
  log(`    blocks=${blocks.length} everyHasEvent=${everyHasEvent} everyHasData=${everyHasData} hasDone=${hasDone} hasComment=${hasComment} crlf=${crlf} eofNewlines=${eofNewlines}`);
  log(`    eventNames=${JSON.stringify(eventNames)} dataType==event: ${typeMatchesEvent}`);
  log(`    raw head=${clip(raw, 300)}`);
  return { blocks: blocks.length, everyHasEvent, everyHasData, hasDone, hasComment, crlf, eofNewlines, eventNames, typeMatchesEvent, rawHead: clip(raw, 800) };
});

// ===== U. 视觉输入（图片 block）=====
await section('U_vision_input', async () => {
  // 1x1 红色 PNG
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await call({
    p: '/anthropic/v1/messages',
    body: {
      model: MODEL, max_tokens: 120,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png1x1 } }, { type: 'text', text: '这张图主要是什么颜色？' }] }],
    },
  });
  const txt = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  log(`    视觉输入: HTTP ${r.status} types=${JSON.stringify(ctypes(r.json))} text=${clip(txt, 200)} err=${r.ok ? '-' : clip(r.text, 300)}`);
  return { status: r.status, types: ctypes(r.json), text: clip(txt, 300), err: r.ok ? null : clip(r.text, 500), usage: r.json?.usage ?? null };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results5.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe5.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe5 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
