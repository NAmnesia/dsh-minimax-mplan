#!/usr/bin/env node
/**
 * probe6.mjs — 最后补充：并发 60 压力、视觉输入边界、SSE keep-alive 心跳、
 *              tool_result 省略、cache 前缀提示、model 列表分页。
 * 运行：node verify/probe6.mjs → verify/results6.json
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

// ===== V. 并发 60 =====
await section('V_burst_60', async () => {
  const t0 = performance.now();
  const N = 60;
  const jobs = Array.from({ length: N }, (_, i) => call({ p: '/anthropic/v1/messages', timeoutMs: 180000, body: { model: MODEL, max_tokens: 6, messages: [{ role: 'user', content: `${i}` }] } }).then((r) => ({ i, status: r.status, ms: r.ms, err: r.ok ? null : clip(r.json?.error?.message || r.text, 200) })));
  const settled = await Promise.all(jobs);
  const byStatus = {};
  for (const s of settled) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  const non200 = settled.filter((s) => s.status !== 200);
  log(`    并发 ${N}: wall=${ms(t0)}ms statuses=${JSON.stringify(byStatus)} non200=${non200.length} maxLatency=${Math.max(...settled.map((s) => s.ms))}ms`);
  if (non200.length) log(`    samples=${JSON.stringify(non200.slice(0, 3))}`);
  return { concurrency: N, wallMs: ms(t0), byStatus, non200Samples: non200.slice(0, 5), latency: { min: Math.min(...settled.map((s) => s.ms)), max: Math.max(...settled.map((s) => s.ms)) } };
});

// ===== W. 视觉输入边界 =====
await section('W_vision_edges', async () => {
  const png1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const cases = [
    { label: 'image(base64 png)', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png1x1 } }, { type: 'text', text: '什么颜色？' }] },
    { label: 'image(坏 base64)', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-valid-base64!!!' } }, { type: 'text', text: '什么颜色？' }] },
    { label: 'image(url 形态)', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }, { type: 'text', text: '什么颜色？' }] },
    { label: 'document 块', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' } }, { type: 'text', text: '这是什么？' }] },
  ];
  const out = {};
  for (const c of cases) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 100, messages: [{ role: 'user', content: c.content }] }, timeoutMs: 90000 });
    const txt = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    out[c.label] = { status: r.status, types: ctypes(r.json), text: clip(txt, 160), base_resp: r.json?.base_resp ?? null, err: r.ok ? null : clip(r.text, 400) };
    log(`    ${c.label}: ${r.status} types=${JSON.stringify(out[c.label].types)} ${out[c.label].err ? 'err=' + clip(out[c.label].err, 200) : 'text=' + clip(txt, 100)}`);
  }
  return out;
});

// ===== X. SSE 心跳与长思考期间的事件间隔 =====
await section('X_sse_heartbeat', async () => {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL, max_tokens: 800, stream: true, output_config: { effort: 'max' }, messages: [{ role: 'user', content: '请详细分析：为什么地球上存在四季？请从黄赤交角、公转轨道、太阳高度角等方面给出不少于 6 段的分析。' }] }),
    signal: AbortSignal.timeout(180000),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const raw = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
      const ev = (raw.match(/^event:\s*(.+)$/m) || [])[1];
      if (ev) events.push({ ev, t: ms(t0) });
    }
  }
  const gaps = [];
  for (let i = 1; i < events.length; i++) gaps.push(events[i].t - events[i - 1].t);
  const pings = events.filter((e) => e.ev === 'ping').length;
  log(`    events=${events.length} pings=${pings} totalMs=${ms(t0)} maxGap=${Math.max(...gaps)}ms firstEventAt=${events[0]?.t}ms`);
  log(`    seq=${JSON.stringify(events.map((e) => e.ev))}`);
  return { eventCount: events.length, pingCount: pings, totalMs: ms(t0), maxGapMs: Math.max(...gaps), gapsMs: gaps, firstEventAtMs: events[0]?.t, seq: events.map((e) => e.ev) };
});

// ===== Y. tool_result 省略 / 无对应 tool_use =====
await section('Y_tool_result_edges', async () => {
  const tool = { name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
  const r1 = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 300, tools: [tool], messages: [{ role: 'user', content: '北京天气' }] } });
  const toolUse = (r1.json?.content || []).find((b) => b.type === 'tool_use');
  // 直接给一个不存在的 tool_use_id
  const orphan = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 120, tools: [tool], messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_not_exist_123', content: 'x' }] }] } });
  // 省略 tool_result 直接结束对话（assistant 末尾是 tool_use，但下一条是普通 user 文本）
  const skipped = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 120, tools: [tool], messages: [{ role: 'user', content: '北京天气' }, { role: 'assistant', content: r1.json.content }, { role: 'user', content: '算了，直接告诉我吧' }] } });
  log(`    孤立 tool_use_id: HTTP ${orphan.status} types=${JSON.stringify(ctypes(orphan.json))} ${orphan.ok ? '' : clip(orphan.text, 300)}`);
  log(`    跳过 tool_result: HTTP ${skipped.status} types=${JSON.stringify(ctypes(skipped.json))} text=${clip((skipped.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 140)}`);
  return {
    toolUseId: toolUse?.id ?? null,
    orphanToolResult: { status: orphan.status, types: ctypes(orphan.json), bodyClip: clip(orphan.text, 600) },
    skippedToolResult: { status: skipped.status, types: ctypes(skipped.json), text: clip((skipped.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 300), bodyClip: clip(skipped.text, 600) },
  };
});

// ===== Z. models 分页 =====
await section('Z_models_pagination', async () => {
  const q = [];
  for (const p of ['/anthropic/v1/models', '/anthropic/v1/models?limit=1000', '/anthropic/v1/models?limit=9&after=MiniMax-M3', '/v1/models']) {
    const r = await call({ p, method: 'GET', timeoutMs: 30000 });
    q.push({ path: p, status: r.status, count: r.json?.data?.length ?? null, ids: (r.json?.data || []).map((m) => m.id), has_more: r.json?.has_more ?? null, bodyClip: r.ok ? undefined : clip(r.text, 300) });
    log(`    ${p}: ${r.status} count=${q.at(-1).count} has_more=${q.at(-1).has_more}`);
  }
  return { queries: q };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results6.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe6.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe6 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
