#!/usr/bin/env node
/**
 * probe2.mjs — 补充探针：thinking+tool_use 组合、thinking 回传要求、协议头依赖、
 *              模型 id 大小写/回退、系统提示数组形态、tool_result 形态。
 * 运行：node verify/probe2.mjs  → verify/results2.json
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

async function call({ p, method = 'POST', body, headers = {}, timeoutMs = 90000, key = KEY }) {
  const url = p.startsWith('http') ? p : BASE + p;
  const h = { authorization: `Bearer ${key}`, 'anthropic-version': AV, 'content-type': 'application/json', ...headers };
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const t0 = performance.now();
  try {
    const res = await fetch(url, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, ms: ms(t0), text, json, headers: Object.fromEntries(res.headers) };
  } catch (e) { return { ok: false, status: 0, ms: ms(t0), text: '', json: null, headers: {}, error: `${e?.name}: ${e?.message}` }; }
}

const shape = (j) => j && typeof j === 'object' ? {
  topKeys: Object.keys(j),
  model: j.model, stop_reason: j.stop_reason,
  usageKeys: j.usage ? Object.keys(j.usage) : null,
  usage: j.usage,
  base_resp: j.base_resp,
  contentTypes: Array.isArray(j.content) ? j.content.map((b) => b.type) : null,
  blocks: Array.isArray(j.content) ? j.content.map((b) => ({
    type: b.type, keys: Object.keys(b),
    text_len: b.text?.length, thinking_len: b.thinking?.length,
    sig_len: b.signature?.length, id: b.id, name: b.name, input: b.input,
  })) : null,
  error: j.error ? { keys: Object.keys(j.error), type: j.error.type, code: j.error.code, message: clip(j.error.message, 300) } : undefined,
} : j;

const results = { startedAt: new Date().toISOString(), probes: {} };
const sections = {};
async function section(name, fn) {
  const t0 = performance.now();
  log(`\n=== [${name}] ===`);
  try { const r = await fn(); sections[name] = { ...r, elapsedMs: ms(t0) }; log(`    ok (${ms(t0)}ms)`); }
  catch (e) { sections[name] = { error: String(e?.stack || e), elapsedMs: ms(t0) }; log(`    FAILED ${e?.message}`); }
}

const TOOLS = [{
  name: 'get_weather',
  description: '查询指定城市的实时天气',
  input_schema: { type: 'object', properties: { city: { type: 'string', description: '城市名' } }, required: ['city'] },
}];
const USER1 = '请依次做两件事：1) 先仔细思考北京和上海哪个更热；2) 调用 get_weather 查询北京天气。';

// ===== A. 让 thinking 与 tool_use 同时出现 =====
await section('A_thinking_with_tools', async () => {
  const attempts = [];
  const variants = [
    { label: 'tools+effort=max', extra: { output_config: { effort: 'max' } } },
    { label: 'tools+effort=xhigh', extra: { output_config: { effort: 'xhigh' } } },
    { label: 'tools+thinking.enabled', extra: { thinking: { type: 'enabled', budget_tokens: 2048 } } },
    { label: 'tools+effort=high+hardPrompt', extra: { output_config: { effort: 'high' } }, prompt: '先分析这道题：37*24+19 等于多少？然后用 get_weather 查询北京天气。' },
  ];
  for (const v of variants) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 500, tools: TOOLS, messages: [{ role: 'user', content: v.prompt || USER1 }], ...v.extra } });
    const types = r.json?.content?.map((b) => b.type) || [];
    const rec = { label: v.label, status: r.status, ms: r.ms, contentTypes: types, stop_reason: r.json?.stop_reason, usage: r.json?.usage, thinkingTokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null };
    attempts.push(rec);
    log(`    ${v.label}: ${r.status} types=${JSON.stringify(types)} thinkingTokens=${rec.thinkingTokens} stop=${rec.stop_reason}`);
  }
  return { attempts };
});

// ===== B. thinking 回传要求（关键）=====
await section('B_thinking_replay', async () => {
  // 先构造一个确定含 thinking + tool_use 的回合
  let turn1 = null;
  const tries = [
    { model: PREVIEW, extra: { output_config: { effort: 'max' } } },
    { model: MODEL, extra: { output_config: { effort: 'max' } } },
    { model: MODEL, extra: { thinking: { type: 'enabled', budget_tokens: 4096 }, output_config: { effort: 'max' } } },
  ];
  for (const t of tries) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model: t.model, max_tokens: 800, tools: TOOLS, messages: [{ role: 'user', content: '请先深入思考北京和上海的气候差异，然后调用 get_weather 查询北京天气。' }], ...t.extra }, timeoutMs: 120000 });
    const types = r.json?.content?.map((b) => b.type) || [];
    log(`    try ${t.model} ${JSON.stringify(t.extra)}: ${r.status} types=${JSON.stringify(types)}`);
    if (types.includes('thinking') && types.includes('tool_use')) { turn1 = { r, model: t.model, extra: t.extra }; break; }
  }
  if (!turn1) {
    log('    !! 未能构造 thinking+tool_use 同时出现的回合');
    return { constructed: false, note: 'M3.1-Flash 在带 tools 的回合中未产生 thinking 块' };
  }
  const blocks = turn1.r.json.content;
  const thinking = blocks.find((b) => b.type === 'thinking');
  const toolUse = blocks.find((b) => b.type === 'tool_use');
  log(`    turn1 ok model=${turn1.model} thinkingLen=${thinking.thinking?.length} sigLen=${thinking.signature?.length} tool=${toolUse.name}`);

  const first = { role: 'user', content: '请先深入思考北京和上海的气候差异，然后调用 get_weather 查询北京天气。' };
  const asstFull = { role: 'assistant', content: blocks };
  const asstNoThinking = { role: 'assistant', content: blocks.filter((b) => b.type !== 'thinking') };
  const asstThinkingOnly = { role: 'assistant', content: blocks.filter((b) => b.type !== 'text') };
  const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '北京：晴，25°C' }] };
  const base = { model: turn1.model, max_tokens: 400, tools: TOOLS, ...turn1.extra };

  const run = async (label, messages) => {
    const r = await call({ p: '/anthropic/v1/messages', body: { ...base, messages }, timeoutMs: 120000 });
    const finalText = (r.json?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const rec = { label, status: r.status, ms: r.ms, contentTypes: r.json?.content?.map((b) => b.type) || [], stop_reason: r.json?.stop_reason, finalText: clip(finalText, 300), err: r.json?.error ? { type: r.json.error.type, message: clip(r.json.error.message, 400) } : undefined, rawClip: r.ok ? undefined : clip(r.text, 800) };
    log(`    ${label}: ${r.status} types=${JSON.stringify(rec.contentTypes)} ${rec.err ? 'err=' + clip(rec.err.message, 200) : 'text=' + clip(rec.finalText, 120)}`);
    return rec;
  };

  const fullReplay = await run('full(thinking+text+tool_use)', [first, asstFull, toolResult]);
  const noThinking = await run('no thinking block', [first, asstNoThinking, toolResult]);
  const noText = await run('thinking+tool_use only (去 text)', [first, asstThinkingOnly, toolResult]);
  const badSig = await run('thinking 签名被篡改', [first, { role: 'assistant', content: [{ ...thinking, signature: 'a'.repeat(64) }, ...blocks.filter((b) => b.type !== 'thinking')] }, toolResult]);

  // 第二轮完整结束（模拟真实 agent loop 的第二/三轮）
  const secondTurn = await call({ p: '/anthropic/v1/messages', body: { ...base, messages: [first, asstFull, toolResult, { role: 'assistant', content: fullReplay.status === 200 ? (await call({ p: '/anthropic/v1/messages', body: { ...base, messages: [first, asstFull, toolResult] }, timeoutMs: 120000 })).json.content : [] }] } });

  return {
    constructed: true, turn1Model: turn1.model, turn1Extra: turn1.extra,
    turn1: { status: turn1.r.status, shape: shape(turn1.r.json), rawClip: clip(turn1.r.text, 2000) },
    thinkingBlock: { keys: Object.keys(thinking), thinkingLen: thinking.thinking?.length, sigLen: thinking.signature?.length, sigHead: thinking.signature?.slice(0, 16) },
    toolUse: { id: toolUse.id, name: toolUse.name, input: toolUse.input },
    fullReplay, noThinking, noText, badSig,
  };
});

// ===== C. 协议头 / 请求体形态依赖 =====
await section('C_protocol_requirements', async () => {
  const BODY = { model: MODEL, max_tokens: 24, messages: [{ role: 'user', content: '只回答 ok' }] };
  const noVersion = await call({ p: '/anthropic/v1/messages', body: BODY, headers: { 'anthropic-version': undefined } });
  const noMaxTokens = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } });
  const sysArray = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 60, system: [{ type: 'text', text: '你只用英文回答，最多 5 个词。' }], messages: [{ role: 'user', content: '你好' }] } });
  const apiKeyHeader = await call({ p: '/anthropic/v1/messages', body: BODY, headers: { authorization: undefined, 'x-api-key': KEY } });
  const noAuth = await call({ p: '/anthropic/v1/messages', body: BODY, key: '', headers: { authorization: undefined } });
  const emptyMessages = await call({ p: '/anthropic/v1/messages', body: { model: MODEL, max_tokens: 10, messages: [] } });
  const badJson = await call({ p: '/anthropic/v1/messages', body: '{"model":', headers: {} });

  log(`    no anthropic-version: ${noVersion.status} ${clip(noVersion.text, 200)}`);
  log(`    no max_tokens:        ${noMaxTokens.status} ${clip(noMaxTokens.text, 240)}`);
  log(`    system as array:      ${sysArray.status} types=${JSON.stringify(sysArray.json?.content?.map((b) => b.type))}`);
  log(`    x-api-key header:     ${apiKeyHeader.status} ${clip(apiKeyHeader.text, 200)}`);
  log(`    no auth:              ${noAuth.status} ${clip(noAuth.text, 200)}`);
  log(`    empty messages:       ${emptyMessages.status} ${clip(emptyMessages.text, 240)}`);
  log(`    malformed json:       ${badJson.status} ${clip(badJson.text, 240)}`);

  return {
    noAnthropicVersion: { status: noVersion.status, body: clip(noVersion.text, 600) },
    noMaxTokens: { status: noMaxTokens.status, body: clip(noMaxTokens.text, 600) },
    systemAsArray: { status: sysArray.status, shape: shape(sysArray.json), rawClip: clip(sysArray.text, 800) },
    xApiKeyHeader: { status: apiKeyHeader.status, body: clip(apiKeyHeader.text, 400) },
    noAuth: { status: noAuth.status, body: clip(noAuth.text, 400) },
    emptyMessages: { status: emptyMessages.status, body: clip(emptyMessages.text, 600) },
    malformedJson: { status: badJson.status, body: clip(badJson.text, 600) },
  };
});

// ===== D. 模型 id：大小写与回退 =====
await section('D_model_id_resolution', async () => {
  const candidates = [
    'MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview', 'minimax-m3.1-flash',
    'MiniMax-M3.1-Flash-preview', 'MiniMax-M3', 'MiniMax-Not-Exist', 'claude-3-5-sonnet-20241022',
    '', 'MiniMax-M2.7-highspeed',
  ];
  const out = [];
  for (const model of candidates) {
    const r = await call({ p: '/anthropic/v1/messages', body: { model, max_tokens: 16, messages: [{ role: 'user', content: '只回答 ok' }] }, timeoutMs: 60000 });
    const rec = { requestModel: model || '(empty)', status: r.status, ms: r.ms, returnedModel: r.json?.model ?? null, resolved: r.json?.model === model, stop: r.json?.stop_reason, err: r.json?.error ? { type: r.json.error.type, message: clip(r.json.error.message, 240) } : undefined };
    out.push(rec);
    log(`    ${JSON.stringify(model)}: ${r.status} returned=${rec.returnedModel} err=${rec.err ? clip(rec.err.message, 160) : '-'}`);
  }
  return { candidates: out, silentFallback: out.some((o) => o.status === 200 && o.returnedModel && o.returnedModel !== o.requestModel) };
});

// ===== E. thinking.type 取值矩阵 =====
await section('E_thinking_type_matrix', async () => {
  const cases = [
    { label: 'adaptive', thinking: { type: 'adaptive' } },
    { label: 'adaptive+effort=high', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    { label: 'enabled budget 1', thinking: { type: 'enabled', budget_tokens: 1 } },
    { label: 'enabled budget 200000', thinking: { type: 'enabled', budget_tokens: 200000 } },
    { label: 'bogus type', thinking: { type: 'bogus' } },
  ];
  const out = {};
  for (const c of cases) {
    const body = { model: MODEL, max_tokens: 120, messages: [{ role: 'user', content: '计算 2+2' }], ...(c.thinking ? { thinking: c.thinking } : {}), ...(c.output_config ? { output_config: c.output_config } : {}) };
    const r = await call({ p: '/anthropic/v1/messages', body });
    out[c.label] = { status: r.status, ms: r.ms, thinkingTokens: r.json?.usage?.output_tokens_details?.thinking_tokens ?? null, contentTypes: r.json?.content?.map((b) => b.type) ?? null, err: r.json?.error ? clip(r.json.error.message, 300) : undefined };
    log(`    ${c.label}: ${r.status} thinkingTokens=${out[c.label].thinkingTokens} ${out[c.label].err ? 'err=' + clip(out[c.label].err, 200) : ''}`);
  }
  return out;
});

// ===== F. 图片：URL 时效 / 错误 key 的图片路径 / n 上限 =====
await section('F_image_extra', async () => {
  const bad = await call({ p: '/v1/image_generation', body: { model: 'image-01', prompt: 'x', n: 1 }, key: 'sk-bogus-000000000000' });
  const n9 = await call({ p: '/v1/image_generation', body: { model: 'image-01', prompt: '一朵花', n: 9, response_format: 'url', aspect_ratio: '1:1' }, timeoutMs: 180000 });
  const noModel = await call({ p: '/v1/image_generation', body: { prompt: '一朵花', n: 1, response_format: 'url', aspect_ratio: '1:1' }, timeoutMs: 120000 });
  log(`    bad key image: status=${bad.status} base_resp=${JSON.stringify(bad.json?.base_resp)}`);
  log(`    n=9: status=${n9.status} images=${n9.json?.data?.image_urls?.length ?? 'n/a'} base_resp=${JSON.stringify(n9.json?.base_resp)} metadata=${JSON.stringify(n9.json?.metadata)}`);
  log(`    no model: status=${noModel.status} base_resp=${JSON.stringify(noModel.json?.base_resp)} images=${noModel.json?.data?.image_urls?.length ?? 'n/a'}`);
  return {
    badKey: { status: bad.status, bodyClip: clip(bad.text, 600) },
    n9: { status: n9.status, ms: n9.ms, imageCount: n9.json?.data?.image_urls?.length ?? null, base_resp: n9.json?.base_resp ?? null, metadata: n9.json?.metadata ?? null, bodyClip: clip(n9.text, 600) },
    noModel: { status: noModel.status, ms: noModel.ms, imageCount: noModel.json?.data?.image_urls?.length ?? null, base_resp: noModel.json?.base_resp ?? null, bodyClip: clip(noModel.text, 900) },
  };
});

results.finishedAt = new Date().toISOString();
results.elapsedMs = ms(startAll);
results.probes = sections;
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(DIR, 'results2.json'), JSON.stringify(results, null, 2), 'utf8');
await fs.writeFile(path.join(OUT_DIR, 'probe2.log'), lines.join('\n') + '\n', 'utf8');
log(`\n=== probe2 DONE ${(results.elapsedMs / 1000).toFixed(1)}s ===`);
