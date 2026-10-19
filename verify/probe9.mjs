#!/usr/bin/env node
/**
 * probe9.mjs — 收尾细节：
 *   1) stop_reason 全取值（stop_sequences 命中）
 *   2) 流式响应是否携带 base_resp / usage 的 service_tier
 *   3) max_tokens=1 时 content 的确切 JSON 表示
 *   4) 非流式成功响应的 base_resp 稳定性（10 次）
 * 运行：node verify/probe9.mjs → verify/results9.json
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

async function call({ p, method = 'POST', body, timeoutMs = 120000, headers = {} }) {
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

const results = { startedAt: new Date().toISOString(), probes: {} };
const sections = {};
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try { const r = await fn(); sections[name] = { ...r, elapsedMs: ms(t0) }; log(`    ok (${ms(t0)}ms)`); }
  catch (e) { sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) }; log(`    FAILED ${e?.message}`); }
}

// ===== II. stop_reason 全取值 =====
await section('II_stop_reasons', async () => {
  const cases = [
    { label: 'end_turn', body: { model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: '只回答 ok' }] } },
    { label: 'max_tokens', body: { model: MODEL, max_tokens: 4, messages: [{ role: 'user', content: '详细解释相对论' }] } },
    { label: 'stop_sequence 命中', body: { model: MODEL, max_tokens: 200, stop_sequences: ['STOP'], messages: [{ role: 'user', content: '请输出 AAA 然后输出 STOP 然后输出 BBB' }] } },
    { label: 'tool_use', body: { model: MODEL, max_tokens: 300, tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }], messages: [{ role: 'user', content: '北京天气？调用工具。' }] } },
  ];
  const out = {};
  for (const c of cases) {
    const r = await call({ p: '/anthropic/v1/messages', body: c.body });
    out[c.label] = { status: r.status, stop_reason: r.json?.stop_reason, stop_sequence: r.json?.stop_sequence ?? null, types: (r.json?.content || []).map((b) => b.type), text: clip((r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), 120) };
    log(`    ${c.label}: stop_reason=${out[c.label].stop_reason} stop_sequence=${JSON.stringify(out[c.label].stop_sequence)}`);
  }
  return out;
});

// ===== JJ. 流式是否带 base_resp / service_tier =====
await section('JJ_stream_has_base_resp', async () => {
  const res = await fetch(`${BASE}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'anthropic-version': AV, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: 'user', content: '说一句话' }] }),
    signal: AbortSignal.timeout(90000),
  });
  const raw = await res.text();
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim());
  const parsed = blocks.map((b) => {
    const dm = b.match(/^data:\s*(.+)$/m);
    try { return JSON.parse(dm[1]); } catch { return null; }
  }).filter(Boolean);
  const anyBaseResp = parsed.some((p) => p.base_resp !== undefined);
  const anyServiceTier = raw.includes('service_tier');
  const usageKeyUnion = [...new Set(parsed.flatMap((p) => Object.keys(p.usage || {})))];
  const msgStartUsageKeys = Object.keys(parsed.find((p) => p.type === 'message_start')?.message?.usage || {});
  log(`    流式含 base_resp=${anyBaseResp} 含 service_tier=${anyServiceTier}`);
  log(`    usage 键并集=${JSON.stringify(usageKeyUnion)} message_start.usage 键=${JSON.stringify(msgStartUsageKeys)}`);
  log(`    原始包含 'base_resp': ${raw.includes('base_resp')}`);
  return { anyBaseResp, anyServiceTier, usageKeyUnion, msgStartUsageKeys, rawHasBaseResp: raw.includes('base_resp') };
});

// ===== KK. max_tokens=1 的确切 JSON =====
await section('KK_content_null_case', async () => {
  const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 1, messages: [{ role: 'user', content: '你好' }] } });
  log(`    HTTP ${r.status} 原始 body=${clip(r.text, 800)}`);
  log(`    content 是否为 null: ${r.json?.content === null} ; 键是否存在: ${r.json ? Object.prototype.hasOwnProperty.call(r.json, 'content') : null}`);
  return { status: r.status, rawBody: r.text, contentIsNull: r.json?.content === null, hasContentKey: r.json ? Object.prototype.hasOwnProperty.call(r.json, 'content') : null, contentType: r.json ? typeof r.json.content : null, keys: Object.keys(r.json || {}) };
});

// ===== LL. 非流式 base_resp 稳定性 =====
await section('LL_base_resp_stability', async () => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 12, messages: [{ role: 'user', content: `回答 ${i}` }] } });
    rows.push({ i, status: r.status, hasBaseResp: r.json?.base_resp !== undefined, base_resp: r.json?.base_resp ?? null, hasServiceTier: r.json?.usage?.service_tier !== undefined, usageKeys: Object.keys(r.json?.usage || {}) });
    await new Promise((res) => setTimeout(res, 120));
  }
  const allHave = rows.every((r) => r.hasBaseResp);
  const anyServiceTier = rows.some((r) => r.hasServiceTier);
  log(`    10 次全部含 base_resp=${allHave} 任一次含 usage.service_tier=${anyServiceTier}`);
  log(`    usage 键并集=${JSON.stringify([...new Set(rows.flatMap((r) => r.usageKeys))])}`);
  return { allHaveBaseResp: allHave, anyServiceTier, usageKeyUnion: [...new Set(rows.flatMap((r) => r.usageKeys))], rows };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results9.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe9.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe9 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
