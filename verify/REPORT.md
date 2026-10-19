# MiniMax M Plan 真实 API 契约验证报告

> 独立验收器产物。全部结论来自对 `https://api.minimax.cn` 的真实请求，不依赖被测插件的任何代码。
>
> - 环境：Windows / Node **v24.16.0** / 内置 `fetch`（PowerShell `Invoke-RestMethod`、`curl.exe` 在本机 TLS 异常，全程未使用）
> - 凭据：`C:\Users\Amnesia\.dsh\.credentials.yaml` → `refs.MINIMAX_CN_API_KEY`（`sk-cp-` 前缀，M Plan 订阅 Key，长度 125）。只读解析，未打印、未落盘。
> - 时间：2026-10-19（Asia/Shanghai）
> - 证据：`results.json` … `results9.json`（原始结构化响应）、`out/probe*.log`（运行日志）、`out/img-*.jpeg`（真实生成图，可用魔数复核）
> - 复跑：`node verify/probe.mjs`（实测 82–165s，图片耗时波动大）、`node verify/probe2.mjs` … `probe9.mjs`（各自独立可跑，全部只读不写工作区）
> - 全部 9 个脚本均通过 `node --check`，`probe.mjs` 已在收尾后重跑验证 8 节全绿

---

## 0. 结论摘要（TL;DR）

| # | 结论 | 影响 |
|---|---|---|
| 1 | **对未知模型名不报错，静默回退到 `MiniMax-M3`** | 必须靠响应回显的 `model` 字段核验实际模型 |
| 2 | **`/v1/image_generation` 的 HTTP 状态恒为 200**，错误藏在 `base_resp.status_code` | 不能用 `response.ok` 判成功 |
| 3 | `image_generation.metadata.success_count` / `failed_count` 是**字符串** | 必须 `Number()` 后比较 |
| 4 | `image_base64` 是**裸 base64**（无 `data:` 前缀），实际格式为 **JPEG** | 解码后需嗅探魔数 |
| 5 | 单张图生成**耗时可达 100s+** | 超时必须 ≥180s，60s 会误判失败 |
| 6 | `max_tokens: 1` 时 `content` 为 **`null`**（不是 `[]`） | 必须 `Array.isArray()` 守卫 |
| 7 | 流式 `message_start.usage` 的 `input_tokens`/`output_tokens` **恒为 0**，真实用量只在 `message_delta` | 统计要取后者 |
| 8 | `thinking:{type:"disabled"}` 在 M3.1-Flash 上**确实 400** | 不要下发 disabled |
| 9 | `thinking` 块回传**非必需**（省略 / 篡改签名均 200） | 但不能丢 `tool_use` 块 |
| 10 | 并发 60 无 429、无 `1002`、**无任何 rate-limit 响应头** | 无法做基于响应头的自适应退避 |

---

## 1. 端点与鉴权

| 端点 | 方法 | 必需头 | 备注 |
|---|---|---|---|
| `/anthropic/v1/messages` | POST | `Authorization: Bearer <key>` | `anthropic-version` **可省**（省略仍 200）|
| `/anthropic/v1/models` | GET | `Authorization: Bearer <key>` | 查询参数基本被忽略 |
| `/v1/image_generation` | POST | `Authorization: Bearer <key>` | 不需要 `anthropic-version` |
| `/v1/chat/completions` | POST | `Authorization: Bearer <key>` | OpenAI 兼容面（附录）|

### 实测的鉴权细节

- `x-api-key: <key>` **同样可用**（返回 200），说明网关对两种头都接受。
- **完全不带头** → `HTTP 401`。
- ⚠️ **401 的报错文案会误导人**：它说要把 Key 放 `X-Api-Key`，但你其实发的是 `Authorization`。不要按这句话去改代码。

```json
// 错误 Key / 无 Key 调 /anthropic/v1/messages → HTTP 401
{"type":"error",
 "error":{"type":"authentication_error",
          "message":"login fail: Please carry the API secret key in the 'X-Api-Key' field of the request header"},
 "request_id":"07252bbd24c8560e8352d27ccf73e2a5"}
```

注意 `error` 对象**只有 `type` 和 `message`，没有 `code` 字段**——`error.code` 恒为 `undefined`。

---

## 2. 文本模型：id 与静默回退（最关键的一条）

### 2.1 完整模型列表

`GET /anthropic/v1/models?limit=1000` → `200`，`{"data":[...],"first_id":...,"last_id":...,"has_more":false}`，共 **9** 个：

| id（大小写敏感地记录） | created_at |
|---|---|
| `MiniMax-M3.1-Flash-Preview` | 2026-10-10T08:11:38Z |
| `MiniMax-M3` | 2026-06-01T00:00:00Z |
| `MiniMax-M2.7` | 2026-03-18T02:00:00Z |
| `MiniMax-M2.7-highspeed` | 2026-03-18T02:00:00Z |
| `MiniMax-M2.5` | 2026-02-13T02:00:00Z |
| `MiniMax-M2.5-highspeed` | 2026-02-13T02:00:00Z |
| `MiniMax-M2.1` | 2025-12-23T02:00:00Z |
| `MiniMax-M2.1-highspeed` | 2025-12-23T02:00:00Z |
| `MiniMax-M2` | 2025-10-27T02:00:00Z |

列表项字段：`{id, type:"model", display_name, created_at}`。

> ⚠️ **列表里没有 `MiniMax-M3.1-Flash`（只有 `-Preview`），但 `MiniMax-M3.1-Flash` 是可调用的**，且响应会原样回显 `"model":"MiniMax-M3.1-Flash"`。**模型列表不是"可用模型"的权威来源。**

`limit` 参数实测被忽略：`limit=1000`→9、`limit=20`→9、不传→9、`?limit=9&after=...`→9；`has_more` 恒为 `false`。`limit=abc` → `400`。

### 2.2 模型名解析矩阵（`D_model_id_resolution`）

| 请求的 model | HTTP | 响应回显 `model` | 判定 |
|---|---|---|---|
| `MiniMax-M3.1-Flash` | 200 | `MiniMax-M3.1-Flash` | ✅ 命中 |
| `MiniMax-M3.1-Flash-Preview` | 200 | `MiniMax-M3.1-Flash-Preview` | ✅ 命中 |
| `minimax-m3.1-flash`（全小写） | 200 | `MiniMax-M3.1-Flash` | ✅ 大小写不敏感 |
| `MiniMax-M3.1-Flash-preview` | 200 | `MiniMax-M3.1-Flash-Preview` | ✅ 大小写不敏感 |
| `MiniMax-M3` | 200 | `MiniMax-M3` | ✅ |
| `MiniMax-M2.7-highspeed` | 200 | `MiniMax-M2.7-highspeed` | ✅ |
| `MiniMax-Not-Exist` | **200** | **`MiniMax-M3`** | ❌ **静默回退** |
| `claude-3-5-sonnet-20241022` | **200** | **`MiniMax-M3`** | ❌ **静默回退** |
| `""`（空串） | **200** | **`MiniMax-M3`** | ❌ **静默回退** |

**结论（lead 已实测确认，本次复现一致）**：平台对未知模型名**既不报错也不拒绝**，直接回退到 `MiniMax-M3` 并正常返回内容。因此：

> **绝不能靠"调用失败再换名字"来做模型协商**——因为永远不会有"调用失败"。
> 正确做法：发一次最小请求，读响应里的 `model` 字段，规范化（`trim().toLowerCase()`）后与请求名比对；不一致说明发生了回退，继续试下一个候选；全部候选都回显成别的模型时，接受平台实际给出的模型并**如实上报**。

**反向证据（重要对照）**：`/v1/chat/completions` 面**会**拒绝未知模型——
`{"model":"gpt-4o"}` → `HTTP 400` `{"error":{"type":"bad_request_error","message":"invalid params, unknown model 'gpt-4o' (2013)","http_code":"400"}}`。
两个面行为**不对称**，不能把 chat 面的经验套到 anthropic 面。

---

## 3. 非流式 `/anthropic/v1/messages` 响应结构

请求最小体：`{model, max_tokens, messages[...]}`。`max_tokens` 可省（省略仍 200），`system` 支持**字符串**或**数组**（`[{type:"text",text:"..."}]`）两种形态，均 200。

真实响应（截断）：

```json
{
  "id": "07252b1b733c3be8fb5803abe5126dcd",
  "type": "message",
  "role": "assistant",
  "model": "MiniMax-M3.1-Flash",
  "content": [
    {"thinking": "We need answer Chinese, one sentence explain binary search...",
     "signature": "5dbdfad1c0404ddfc25c3b34f0ddd1ce321c5f6f48231e26c8ad43bb72266eb9",
     "type": "thinking"},
    {"text": "二分查找是一种在有序数组中不断将搜索范围缩小一半，从而快速定位目标元素的查找算法。",
     "type": "text"}
  ],
  "usage": {
    "input_tokens": 14, "output_tokens": 49,
    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 195,
    "output_tokens_details": {"thinking_tokens": 28}
  },
  "stop_reason": "end_turn",
  "base_resp": {"status_code": 0, "status_msg": ""}
}
```

### 3.1 顶层字段（固定 8 个）

`id` / `type:"message"` / `role:"assistant"` / `model` / `content` / `usage` / `stop_reason` / `base_resp`

`base_resp` 在**非流式成功响应中稳定存在**（连续 10 次抽样 10/10 命中，`status_code: 0`）。

### 3.2 `content` 块类型（大小写敏感，`type` 为判别字段）

| type | 字段 | 说明 |
|---|---|---|
| `thinking` | `thinking`, `signature`, `type` | `signature` 恒为 **64 位 hex**（实测长度 64）|
| `text` | `text`, `type` | 纯文本 |
| `tool_use` | `type`, `id`, `name`, `input` | `input` 是**已解析的对象**（非流式） |

`tool_use.id` 实测两种形态：`call_function_s47jyvylvhfp_1`、`call_b692a445e22b4539bba7f2aa`。

### 3.3 `usage` 字段名

`input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens_details.thinking_tokens`

- `output_tokens_details.thinking_tokens` **仅在真的产生了 thinking 时出现**；无 thinking 时该键整体缺失（不是 0）。
- `usage.service_tier` **偶尔出现**（观察到 `"service_tier":"standard"` 一次），**不稳定，不要依赖**。

### 3.4 `stop_reason` 取值

| 场景 | `stop_reason` | `stop_sequence` |
|---|---|---|
| 正常结束 | `end_turn` | `null` |
| 撞到 max_tokens | `max_tokens` | `null` |
| 触发工具调用 | `tool_use` | `null` |
| `stop_sequences` 命中 | **`end_turn`** | **`null`** ⚠️ |

⚠️ **`stop_sequences` 未被强制执行**：请求里传 `stop_sequences:["STOP"]`、提示词要求依次输出 `AAA` / `STOP` / `BBB`，实际返回的 `text` 是 **`"AAA\nSTOP\nBBB"`**——生成**越过了**停止词继续输出，且 `stop_reason` 仍是 `end_turn`、`stop_sequence` 是 `null`。

> **结论：不要依赖 `stop_sequences` 做输出约束，也不要依赖 `stop_sequence` 字段判断截断。** 如需裁剪，请在客户端自己做。

⚠️ **`max_tokens` 会被 thinking 吃光**：M3.1-Flash 强制自适应思考，小 `max_tokens` 会全部消耗在 thinking 上——

| `max_tokens` | `content` 形态 | `output_tokens` | `thinking_tokens` |
|---|---|---|---|
| 1 | **`null`**（键存在，值为 null）| 1 | — |
| 2 | `[{type:"thinking"}]` | 2 | — |
| 5 | `[{type:"thinking"}]` | 5 | 5 |
| 8 | `[{type:"thinking"}]` | 8 | 8 |
| 20 | `[{type:"thinking"}]` | 20 | 20 |
| 100 | `[{type:"thinking"}]` | 100 | 100 |

真实原文（`max_tokens: 1`）：

```json
{"id":"07252e706dcedbfa923cb3676ade2167","type":"message","role":"assistant",
 "model":"MiniMax-M3.1-Flash","content":null,
 "usage":{"input_tokens":8,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":195},
 "stop_reason":"max_tokens","base_resp":{"status_code":0,"status_msg":""}}
```

> **实践建议**：`max_tokens` 至少给 1000～2000，否则很可能只拿到 thinking、拿不到任何 `text` 块。

---

## 4. 流式 SSE 契约

`{stream:true}` → `200`，`content-type: text/event-stream; charset=utf-8`。

### 4.1 格式细节

| 特征 | 实测值 |
|---|---|
| 分隔符 | `\n\n`（**纯 LF，无 CRLF**）|
| `event:` 行 | 每个事件都有 |
| `data:` 行 | 每个事件都有（JSON，**不是**多行 data）|
| `event` 名与 `data.type` | **恒等**（13/13 块验证通过）|
| `[DONE]` 结束标记 | **没有**（这是 Anthropic 风格；`/v1/chat/completions` 才有 `[DONE]`）|
| 注释行（`:` 开头）| 无 |
| 结束 | 以 `\n\n` 结尾，切分后会得到一个空尾块（正常）|
| `base_resp` | **流式中完全不出现**（`raw.includes("base_resp") === false`）|

### 4.2 完整事件名序列（thinking + text + tool_use 全齐时，42 个事件）

```
message_start (×1)
ping (×1)                                    ← 紧跟在 message_start 之后
content_block_start (×3)                     ← index 0=thinking, 1=text, 2=tool_use
content_block_delta (×32)                    ← 全是 delta
content_block_stop (×3)
message_delta (×1)                           ← 携带 stop_reason + 真实 usage
message_stop (×1)
```

实测各块内的 delta 分布：
`index 0 (thinking)` → 28×`thinking_delta` + 1×`signature_delta`（签名永远在 thinking 块**最后**一次性给出）
`index 1 (text)` → 2×`text_delta`
`index 2 (tool_use)` → 1×`input_json_delta`

### 4.3 每种事件的**精确**字段名（`G_full_sse_sequence.fieldMap`）

| event | 顶层字段 | 嵌套字段 |
|---|---|---|
| `message_start` | `type`, `message` | `message.{id,type,role,content,model,stop_reason,stop_sequence,usage}` |
| `ping` | `type` | — |
| `content_block_start` | `type`, `index`, `content_block` | `content_block.{type,thinking\|text\|id,name,input}` |
| `content_block_delta` | `type`, `index`, `delta` | 见下表 |
| `content_block_stop` | `type`, `index` | — |
| `message_delta` | `type`, `delta`, `usage` | `delta.stop_reason` |
| `message_stop` | `type` | — |

**`delta` 的四种形态（核心）**：

| `delta.type` | `delta` 内字段 | 拼接方式 |
|---|---|---|
| `thinking_delta` | `delta.thinking` | 字符串直接 `+=` |
| `signature_delta` | `delta.signature` | 字符串直接 `+=`（或直接赋值）|
| `text_delta` | `delta.text` | 字符串直接 `+=` |
| `input_json_delta` | `delta.partial_json` | **先全部字符串 `+=`，最后一次性 `JSON.parse`** |

真实原始片段：

```
event: message_start
data: {"type":"message_start","message":{"id":"07252c7ac4ce25188694427b64816ec1","type":"message","role":"assistant","content":[],"model":"MiniMax-M3.1-Flash-Preview","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user wants me to"}}

...

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_...","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":\"北京\",\"unit\":\"c\"}"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":476,"output_tokens":179,"output_tokens_details":{"thinking_tokens":126}}}

event: message_stop
data: {"type":"message_stop"}
```

### 4.4 三个极易踩的流式陷阱

1. **`content_block_start.content_block.input` 恒为 `{}`**。真实参数全部来自 `input_json_delta.partial_json` 的累加。**千万不要读 start 事件里的 `input`**。
2. **`message_start.message.usage` 的 token 计数全是 0**（实测 `input_tokens:0, output_tokens:0`；仅 `cache_*_input_tokens` 有值）。真实 usage 只在 `message_delta.usage` 里。做计费/统计必须取后者。
3. **`input_json_delta` 可能只有 1 个分片**（本次大参数实测 `542` 字符一个分片直达）。所以不能假设"一定分多片"，也不能假设"每个分片是合法 JSON 片段"——**只能整体拼接后解析**。

补充实测：`message_start.usage` 含 `cache_creation_input_tokens` / `cache_read_input_tokens`；`message_delta.usage` 的键并集为 `input_tokens / output_tokens / cache_read_input_tokens / output_tokens_details`（**`cache_creation_input_tokens` 可能不出现**）。

### 4.5 可复用的解析伪代码

```js
// ── 累积器 ────────────────────────────────────────────────
const blocks = [];          // 按 index 归档
let stopReason = null, usage = null, model = null;

function onEvent(eventName, d) {
  switch (eventName) {
    case 'message_start':
      model = d.message.model;                       // 用于核验是否被静默回退
      break;

    case 'content_block_start': {
      const cb = d.content_block;
      blocks[d.index] = {
        type: cb.type,
        text: '', thinking: '', signature: '', partialJson: '',
        id: cb.id, name: cb.name,                    // tool_use 才有
        // 注意：cb.input 恒为 {} —— 忽略它
      };
      break;
    }

    case 'content_block_delta': {
      const b = blocks[d.index], dl = d.delta;
      switch (dl.type) {
        case 'text_delta':        b.text       += dl.text;        break;
        case 'thinking_delta':    b.thinking   += dl.thinking;    break;
        case 'signature_delta':   b.signature  += dl.signature;   break;
        case 'input_json_delta':  b.partialJson += dl.partial_json; break;
        default: /* 未知 delta 类型：忽略，别抛错 */ break;
      }
      break;
    }

    case 'content_block_stop': {
      const b = blocks[d.index];
      if (b.type === 'tool_use') {
        try { b.input = JSON.parse(b.partialJson || '{}'); }
        catch { b.input = undefined; b.parseError = true; }   // 容错：交由上层判失败
        delete b.partialJson;
      }
      break;
    }

    case 'message_delta':
      stopReason = d.delta?.stop_reason ?? stopReason;
      usage = d.usage ?? usage;                       // ← 真实 usage 在这里
      break;

    case 'message_stop':
      // 收尾：无 data 语义，仅结束信号
      break;

    case 'ping':
    case 'error':                                     // 保留：若出现 error 事件则上抛
      break;
  }
}

// ── 传输层：按 \n\n 切块，逐块解析 "event:" / "data:" ──────
let buf = '';
for await (const chunk of response.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    let ev = null; const dataLines = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!ev && dataLines.length === 0) continue;      // 空尾块，正常
    let data; try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
    onEvent(ev, data);
  }
}
// 注意：Anthropic 面没有 [DONE]；不要等它，靠流结束（done）收尾。
```

---

## 5. 多轮工具调用与 thinking 回传

### 5.1 工具定义与并行调用

```json
{"name":"get_weather","description":"查询指定城市的实时天气",
 "input_schema":{"type":"object",
   "properties":{"city":{"type":"string"}},
   "required":["city"]}}
```

- 单次响应可返回**多个 `tool_use` 块**（实测 2 个并行，一次问两个城市）。
- `tool_choice` 三种形态均可用（200）：`{"type":"auto"}`、`{"type":"any"}`、`{"type":"tool","name":"get_time"}`。
- `tool_choice` 但**不给 tools** → 200，模型只是忽略它（不报错）。

### 5.2 `tool_result` 回传形态

三种都可用（均 200）：

```jsonc
// (a) content 为字符串
{"type":"tool_result","tool_use_id":"call_...","content":"晴，25°C"}

// (b) content 为块数组
{"type":"tool_result","tool_use_id":"call_...","content":[{"type":"text","text":"晴，25°C"}]}

// (c) 标记错误
{"type":"tool_result","tool_use_id":"call_...","content":"工具执行失败：网络超时","is_error":true}
```

**多结果一次回传**（一个 user 消息里放多个 `tool_result`）→ 200，模型能正确归纳两个城市。

### 5.3 ⚠️ 严格的配对约束（违反即 400）

| 违规 | HTTP | 错误文案 |
|---|---|---|
| 跳过 `tool_result`（assistant 以 `tool_use` 结尾，下一条直接是普通 user 文本）| **400** | `invalid params, tool call result does not follow tool call (2013)` |
| `tool_use_id` 不存在（孤儿结果）| **400** | `invalid params, tool result's tool id(call_not_exist_123) not found (2013)` |
| 回放时**丢掉 `tool_use` 块**、只留 text | **400** | `invalid params, tool result's tool id(call_...) not found (2013)` |

→ **agent loop 必须保证**：每个 `tool_use` 都恰有一个与之配对的 `tool_result`，且 `tool_use` 块必须原样回放在 assistant 轮里。

### 5.4 thinking 块回传要求（关键结论）

构造一个真实含 `thinking + text + tool_use` 的回合（配方：`MiniMax-M3.1-Flash-Preview` + `output_config:{effort:"max"}` + `max_tokens:1200` + 强诱导"先深入思考……然后调用工具"），然后对 assistant 回合做 6 种变形回放，**每种重复 2 次**：

> 📌 该配方已写进 `probe.mjs` 第 3 节（多配方依次尝试，直到同时拿到 `thinking` 与 `tool_use`），可稳定复现：`types: ["thinking","text","tool_use"]`、`signature` 长度 64。

| 回放形态 | 结果（2/2 一致）| 结论 |
|---|---|---|
| `thinking + text + tool_use`（完整）| **200** | 基准 |
| **去掉 `thinking`** | **200** | ✅ **thinking 可省略，不报错** |
| `thinking + tool_use`（去掉 text）| **200** | ✅ text 也可省 |
| `thinking` 的 `signature` **篡改成 64 个 `f`** | **200** | ✅ **签名不做校验（至少客户端侧不校验）** |
| `thinking` 块**整个去掉 `signature` 字段** | **200** | ✅ 同上 |
| **只留 text、丢掉 `tool_use`** | **400** | ❌ 违反配对约束 |

**结论**：MiniMax M Plan 的 anthropic 兼容面**不强制 thinking 回传**，也不校验签名。这意味着：

- ✅ **不需要**为了兼容去做"必须原样回传 thinking"的复杂逻辑；
- ✅ 简单起见可以**只回传 `text` + `tool_use`**（更省 token，`cache_read` 命中也不受影响）；
- ⚠️ 但**绝不能丢 `tool_use`**——那是硬约束；
- ⚠️ 反之也不能假设"省略 thinking 一定安全"：这是**当前版本的行为**，如果未来上了严格校验，会造成 400。**建议保留 thinking 块**（成本低、向前兼容），或至少在 400 时降级重试一次。

### 5.5 一个容易误判的现象

**带 `tools` 的回合常常不产生 `thinking` 块**（首轮 `content: ["text","tool_use"]`）。这不是 thinking 被关闭，而是模型判断该轮无需深思。同理 `output_config.effort` 生效后，简单 prompt 也可能只返回 `[{type:"text"}]`。

> **不要用"有没有 thinking 块"反推 thinking 是否开启。**

---

## 6. `output_config.effort` 与 `thinking` 矩阵

### 6.1 effort 合法值与校验

- 合法值：**`low` / `medium` / `high` / `xhigh` / `max`**（全部 200）。
- 非法值（如 `ultra`）→ **HTTP 400**：

```json
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, invalid reasoning_effort: \"ultra\" (allowed: low, medium, high, xhigh, max) (2013)"},
 "request_id":"..."}
```

### 6.2 effort 是否"真的生效"——是，有可测量差异

同一道需要推理的题（水池注水问题），每档采样 3 次（`max_tokens:1500`）：

| effort | avg thinking_tokens | avg thinking 字数 | avg output_tokens | avg 耗时 |
|---|---|---|---|---|
| `low` | **75** | 223 | 287 | 2867 ms |
| `max` | **151** | 529 | 387 | 4355 ms |

原始 thinking_tokens 样本：
`low = [72, 84, 69]` vs `max = [143, 179, 132]` —— **两组完全无重叠，effort 确实生效**。

（单轮快速对照 `low→max` 曾得到 33 / 24 / 38 / 61 / 33 的近似值，因 prompt 太简单而噪声大；**用复杂 prompt 才能测出稳定差异**。）

### 6.3 `thinking` 参数矩阵

| 请求 | M3.1-Flash | MiniMax-M3 | M2.7 / M2 |
|---|---|---|---|
| 不传 `thinking`（默认）| 200，有 thinking | 200，无 thinking | 200，有 thinking |
| `{type:"adaptive"}` | 200 | — | — |
| `{type:"adaptive"}` + `effort:high` | 200 | — | — |
| `{type:"enabled", budget_tokens:1024/2048/200000}` | 200 | 200 | 200 |
| `{type:"disabled"}` | **400** ⚠️ | **200** | **200** |
| `{type:"bogus"}`（乱写）| **200**（静默忽略）| — | — |

`disabled` 的 400 原文：

```json
{"type":"error","error":{"type":"invalid_request_error",
 "message":"invalid params, model \"MiniMax-M3.1-Flash\" requires adaptive thinking; thinking.type=\"disabled\" (including reasoning.effort=none) is not allowed (2013)"},
 "request_id":"..."}
```

**结论**：

- ✅ **M3.1-Flash 上确实不能关 thinking**（lead 的假设成立）；
- ✅ 该 400 是 **M3.1-Flash 专属**：回退到 `MiniMax-M3`/`M2.7`/`M2` 时 `disabled` 不报错 → **同一份代码在回退后会"行为不一致"**；
- ⚠️ `thinking.type` **不做枚举校验**（乱写的 `bogus` 也 200），不要靠它探测能力；
- ⚠️ `output_config.effort` 在回退模型上**安全**（M3 / M2.7 加 `low`/`max` 均 200），可以作为"无脑透传"参数。

---

## 7. 图片接口 `/v1/image_generation`

请求：

```json
{"model":"image-01","prompt":"一只橘猫坐在木窗台上看向窗外，水彩画风格",
 "aspect_ratio":"1:1","response_format":"base64","n":1,"prompt_optimizer":true}
```

### 7.1 ⚠️ 最重要的坑：HTTP 状态恒为 200

实测**所有**错误（鉴权失败、非法参数、非法模型）**HTTP 状态码都是 `200`**，错误只体现在 `base_resp.status_code`。

```json
// 错误 Key → HTTP 200 ！！
{"base_resp":{"status_code":1004,"status_msg":"login fail: Please carry the API secret key in the 'Authorization' field of the request header"}}

// n=10 → HTTP 200 ！！
{"id":"...","data":null,"base_resp":{"status_code":2013,"status_msg":"invalid params, n must be between 1 and 9"}}
```

> **判定成功的唯一正确方式**：`response.ok && json.base_resp.status_code === 0 && data 非 null`。

### 7.2 `response_format: "base64"`

```json
{"id":"...","data":{"image_base64":["/9j/4AAQSkZJRgABAQAAAQABAAD/4QTsRXhpZgAA..."]},
 "metadata":{"failed_count":"0","success_count":"1"},
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

| 检查项 | 实测结果 |
|---|---|
| 是否裸 base64 | ✅ **裸 base64，无 `data:` 前缀**（`startsWith("data:") === false`）|
| 首 40 字符 | `/9j/4AAQSkZJRgABAQAAAQABAAD/4QTsRXhpZgAA` |
| 解码后字节数 | **493153**（1×1 比例，800×800 级别）|
| 魔数（前 12 字节）| `ffd8ffe000104a4649460001` → **JPEG**（不是 PNG）|
| 字符集 | 纯 base64 合法字符 |
| 图片数组字段 | `data.image_base64`（**数组**，即使 n=1）|

> ⚠️ 虽然本次是裸 base64，仍建议解码前**防御性剥掉** `data:*;base64,` 前缀（网关换实现时可能出现）。
> ⚠️ **不要用扩展名或 `Content-Type` 猜格式**——必须嗅探魔数（本次就与直觉不符：给的是 JPEG）。

**实际输出分辨率**（从 JPEG 的 SOF 段解析得出，`out/image-dims.json`）：

| 请求 `aspect_ratio` | 实际像素 | 格式 | 字节数 |
|---|---|---|---|
| `1:1` | **1024 × 1024** | JPEG | 493153 |
| `4:3` | **1152 × 864** | JPEG | 373410 / 421687（n=2 两张） |
| `16:9` | **1280 × 720** | JPEG | 400432 |

> 三种比例的长边都约在 1024–1280，说明输出分辨率由平台按比例选择，**不可通过请求指定像素尺寸**（无 `width`/`height` 参数）。

### 7.3 `response_format: "url"`

```json
{"id":"...","data":{"image_urls":["https://hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com/...jpeg?Expires=...&OSSAccessKeyId=...&Signature=..."]},
 "metadata":{"failed_count":"0","success_count":"1"},
 "base_resp":{"status_code":0,"status_msg":"success"}}
```

| 检查项 | 实测结果 |
|---|---|
| 字段名 | `data.image_urls`（数组）|
| Host | `hailuo-image-algeng-data.oss-cn-wulanchabu.aliyuncs.com`（阿里云 OSS）|
| 签名查询参数 | `Expires` / `OSSAccessKeyId` / `Signature` |
| **有效期** | `Expires - now = 86399s ≈ 24 小时** |
| 下载验证 | HTTP 200，`content-type: image/jpeg`，**400432 字节**，魔数 `ffd8ffe0...` → JPEG |

> ⚠️ **URL 24 小时后失效**。需要长期保存必须**立即下载**或改用 `response_format:"base64"`。
> ✅ 实测直接 `fetch(url)` 可正常下载（无需额外头）。

### 7.4 参数边界矩阵

| 参数 | 合法值 | 非法行为 |
|---|---|---|
| `n` | **1..9**（含）| `n=0`/`n=10` → `2013` `n must be between 1 and 9`；`n=9` → 返回 9 张图，`success_count:"9"` |
| `aspect_ratio` | **`1:1` `16:9` `4:3` `3:2` `2:3` `3:4` `9:16` `21:9`**（共 8 个）| `5:4` → `2013` `aspect_ratio must be one of [1:1 16:9 4:3 3:2 2:3 3:4 9:16 21:9]` |
| `prompt` | 必填，**≤1500 字符** | 缺失 → `2013` `prompt are required`；1501 字符 → `2013` `prompt length must be less than 1500` |
| `response_format` | `base64` \| `url` | 其他 → `2013` `response_format not 'url' or 'base64'` |
| `model` | `image-01` | `image-999` → `2013` `unsupported model: image-999`；**缺省** → `2013` `unsupported model: `（空串）|
| `prompt_optimizer` | bool，**可省**（省了也能出图）| — |
| `aigc_watermark` | bool（true/false 均 200）| `"yes"` → `2013` `invalid params`（**无细节**）|
| `seed` | 整数（`seed:42` → 200）| — |

> `aspect_ratio` 枚举可从错误信息里**自举获取**（上面那句就是权威列表）。

### 7.5 ⚠️ 耗时：必须给足超时

| 场景 | 实测耗时 |
|---|---|
| `base64` / `n=1` / `1:1` | **103701 ms（103.7 秒！）** |
| `url` / `n=1` / `16:9` | 22004 ms |
| `base64` / `n=2` / `4:3` | 16286 ms |
| `url` / `n=9` / `1:1` | 23109 ms |
| `url` / `n=1` / `21:9` | 12177 ms |

> **单图最坏耗时可超 100 秒**。客户端超时建议 **≥180s**，给 60s 会稳定误判失败。
> 有趣的是 `n=9` 反而比 `n=1` 快——**不要用 n 去估算耗时**。

### 7.6 metadata 类型（陷阱）

```json
"metadata": {"failed_count": "0", "success_count": "1"}
```

**两个值都是字符串，不是数字！** 直接 `metadata.success_count > 0` 在 JS 里靠隐式转换勉强能过，但 `=== 0`、`typeof === 'number'` 全部为假。**必须 `Number()`**。

对照：`base_resp.status_code` 是**数字** `0`（`typeof === "number"`）。同一个响应里两种类型混用。

---

## 8. 错误码与错误体形状

### 8.1 Anthropic 兼容面（`/anthropic/v1/messages`）

错误体形状：`{type:"error", error:{type, message}, request_id}`（`error` **无 `code` 字段**）。

| 触发条件 | HTTP | `error.type` | `error.message` |
|---|---|---|---|
| 错误 Key（`sk-invalid-...`）| **401** | `authentication_error` | `login fail: Please carry the API secret key in the 'X-Api-Key' field of the request header` |
| 不带鉴权头 | **401** | `authentication_error` | 同上 |
| `messages: []` | **400** | `invalid_request_error` | `invalid params, messages must not be empty (2013)` |
| 非法 JSON body | **400** | `invalid_request_error` | `invalid params`（无 `request_id`）|
| `output_config.effort:"ultra"` | **400** | `invalid_request_error` | `invalid params, invalid reasoning_effort: "ultra" (allowed: low, medium, high, xhigh, max) (2013)` |
| `thinking:{type:"disabled"}`（M3.1-Flash）| **400** | `invalid_request_error` | `invalid params, model "MiniMax-M3.1-Flash" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)` |
| `tool_result` 跳过 | **400** | `invalid_request_error` | `invalid params, tool call result does not follow tool call (2013)` |
| 孤儿 `tool_use_id` | **400** | `invalid_request_error` | `invalid params, tool result's tool id(...) not found (2013)` |
| 图片 base64 损坏 | **400** | `invalid_request_error` | `invalid param: decode base64 data url: illegal base64 data at input byte 3 (2013)` |
| image `source.url` 拉不到 | **400** | `invalid_request_error` | `invalid param: remote returned status 404 (2013)` |

> 注意平台码 `2013` 被**拼在 message 字符串末尾**的括号里，**不是**独立字段。要拿到它只能正则抽取 `/\((\d+)\)$/`，或者只看 `error.type`。

### 8.2 图片面（`/v1/image_generation`）

错误体：`{id?, data:null, base_resp:{status_code, status_msg}}`，**HTTP 恒 200**。

| `base_resp.status_code` | `status_msg` | 含义 |
|---|---|---|
| `0` | `success` | 成功 |
| `1004` | `login fail: Please carry the API secret key in the 'Authorization' field...` | 鉴权失败 |
| `2013` | `invalid params, ...` | 参数/模型错误（详见 §7.4）|

### 8.3 平台错误码对照表（来自官方语义 + 本插件实现约定；本次实测覆盖 0/1004/2013）

| code | 含义 |
|---|---|
| `0` | 成功 |
| `1000` | 未知错误 |
| `1001` | 请求超时 |
| `1002` | 触发限流 |
| `1004` | 账号鉴权失败 |
| `1008` | 余额/套餐额度不足 |
| `1026` | 输入涉敏被拦截 |
| `1027` | 输出涉敏被拦截 |
| `1039` | Token 超限 |
| `2013` | 入参异常（模型名/参数）|
| `2049` | 无效的 API Key |
| `2056` | 超出 M Plan 资源限制（等下一个时间窗口）|

> 本次实测**未触发** `1002` / `1008` / `2056`（见 §9），其语义来自官方文档，标记为**未实测**。

### 8.4 `/v1/chat/completions` 面的错误形状**不同**（对照用）

```json
// 错误 Key → 401
{"type":"error","error":{"type":"authorized_error","message":"login fail: ... (1004)","http_code":"401"},"request_id":"..."}

// 未知模型 → 400（注意 anthropic 面此处是静默回退！）
{"type":"error","error":{"type":"bad_request_error","message":"invalid params, unknown model 'gpt-4o' (2013)","http_code":"400"},"request_id":"..."}
```

差异点：`error.type` 是 `authorized_error`（非 `authentication_error`）、多一个 `http_code` 字段、且**会拒绝未知模型**。**两个面不能共用同一个错误解析器。**

---

## 9. 限流与配额

| 并发数 | 实测结果 |
|---|---|
| 5 | 5×200，无 429 |
| 20 | 20×200，wall 1512–2288 ms，无 429 |
| **60** | **60×200**，wall **1748 ms**，max latency 1720 ms，**无 429** |

- **未触发 `429`，未出现 `1002`**（限流码），也未出现 `2056`（M Plan 超额码）。
- **响应头中不存在任何 rate-limit 信息**：无 `x-ratelimit-*`、无 `retry-after`、无 `x-ratelimit-remaining`。

一次性抓到的完整响应头：

```json
{"alb_receive_time":"1792408099.586",
 "alb_request_id":"75f0fa581bb31e27da1a8a121f8a2d6f3e5b2fec",
 "connection":"keep-alive",
 "content-length":"487",
 "content-type":"application/json; charset=utf-8",
 "date":"Mon, 19 Oct 2026 11:08:20 GMT",
 "trace-id":"07252d23b782a6e45f172eec96c61a98",
 "x-mm-request-id":"2105630285793076002_1792408099vhrlj5",
 "x-session-id":"e2242d69419da3f030db78464e996985"}
```

**可用的排障标识**：`trace-id`、`x-mm-request-id`、`minimax-request-id`、`alb_request_id`（不同请求出现的组合不同）。
**错误体里的 `request_id`** 与 `trace-id` **一致**，可用于串联日志。

> **结论**：无法实现"基于响应头预算"的自适应限流；退避策略只能基于 `429` / `1002` / `2056` 的**被动触发**。

---

## 10. 附录：`/v1/chat/completions`（OpenAI 兼容面，非必需）

| 项 | 值 |
|---|---|
| 顶层字段 | `id`, `choices`, `created`, `model`, `object`, `usage`, `input_sensitive`, `output_sensitive`, `input_sensitive_type`, `output_sensitive_type`, `output_sensitive_int`, `base_resp` |
| `usage` | `total_tokens` / `total_characters` / `prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` |
| `choices[0].message` | `content`, `role`, `name`, `audio_content`（+ thinking 时 `reasoning_content`）|
| `finish_reason` | `stop` \| `tool_calls` \| `length` |
| 工具调用 | `message.tool_calls[{id, type:"function", function:{name, arguments:"<JSON 字符串>"}, index}]`（arguments 是**字符串**，需二次 `JSON.parse`）|
| 流式 | `data: {...}` + 终止哨兵 **`data: [DONE]`**（与 anthropic 面相反）|
| thinking | 走 `delta.reasoning_content` 字段 |
| `base_resp` | 成功时存在 `{status_code:0, status_msg:""}` |

---

## 11. 最容易踩的坑（按踩中概率排序）

1. **图片接口 HTTP 恒 200** → 只看 `response.ok` 会把鉴权失败当成功。必须查 `base_resp.status_code === 0` **且** `data != null`。
2. **未知模型名静默回退 `MiniMax-M3`** → "换名字直到成功"的协商逻辑永远成功、永远拿不到想要的模型。必须**读回显的 `model` 字段**核验。
3. **`metadata.success_count/failed_count` 是字符串** → `"0"` 是 truthy，`=== 0` 是 false。必须 `Number()`。
4. **`max_tokens: 1` → `content: null`** → `content.map()` 直接 `TypeError`。必须 `Array.isArray()`。
5. **小 `max_tokens` 全被 thinking 吃掉** → 只剩 `thinking` 块、一个 `text` 都没有。建议 ≥1000。
6. **流式 `message_start.usage` 全是 0** → 取错 usage 会得出"本次零 token"。
7. **流式 `content_block_start.content_block.input` 恒为 `{}`** → 读它做工具调用会永远拿到空参数。
8. **`input_json_delta` 可能只有 1 个分片** → 写"按分片逐个 parse"的逻辑会崩；必须整体拼接后 parse。
9. **图片生成最坏耗时 100s+** → 60s 超时会稳定误判失败。用 ≥180s。
10. **`image_base64` 是裸 base64 但格式是 JPEG** → 用扩展名/Content-Type 猜格式会错，必须嗅探魔数；仍建议防御性剥 `data:` 前缀。
11. **图片 URL 24h 过期** → 异步保存 DB 里过两天全是死链。要么立即下载，要么用 base64。
12. **`thinking:{type:"disabled"}` 在 M3.1-Flash 上 400** → 但回退模型上 200，造成"时好时坏"。**永远不要下发 disabled**。
13. **"没有 thinking 块" ≠ "thinking 关掉了"** → effort 生效或任务简单时本来就可能不产生 thinking 块。不要用它做能力探测。
14. **`tool_result` 必须严格跟随 `tool_use`** → 跳过、孤儿 id、回放丢 `tool_use` 块，三种情况全部 400。
15. **401 的报错文案说要用 `X-Api-Key`** → 误导。你发 `Authorization: Bearer` 是对的。
16. **`error` 对象没有 `code` 字段** → 平台码 `2013` 只在 message 字符串末尾的括号里。想拿码只能正则抽。
17. **模型列表不含 `MiniMax-M3.1-Flash`（只有 `-Preview`），但它是可调用的** → 不要拿列表做白名单校验。
18. **`stop_sequences` 根本没被执行** → 传了停止词，模型照样越过它继续输出，且 `stop_reason` 仍是 `end_turn`、`stop_sequence` 是 `null`。不能靠它做输出约束或截断判断。
19. **Anthropic 面无 `[DONE]`，chat 面有 `[DONE]`** → 复用同一套 SSE 解析器会挂。
20. **两个 API 面的错误形状/行为不一致**（未知模型：anthropic 静默回退 vs chat 400）→ 不要共用错误解析器。

---

## 12. 对客户端实现的直接建议（验收结论）

| 关注点 | 建议 |
|---|---|
| 成功判定（messages）| `res.ok && json.base_resp?.status_code === 0`（并容错 `base_resp` 可能缺失）|
| 成功判定（image）| **只看 `base_resp.status_code === 0` 且 `data != null`**，**不要**看 HTTP 状态 |
| 模型协商 | 发最小请求 → 读响应 `model` 字段 → 与请求名 `toLowerCase()` 比对 → 不符则换候选 → 全部不符则接受并上报 |
| 模型候选顺序 | `MiniMax-M3.1-Flash` → `MiniMax-M3.1-Flash-Preview` → `MiniMax-M3` |
| thinking | **不下发** `thinking` 字段（让平台默认）；**不下发** `disabled` |
| effort | 可安全透传（回退模型也接受）；生产建议 `high`，需要质量时 `xhigh`/`max` |
| max_tokens | 默认 ≥2000；`min` 保护到 ≥1000 |
| content 读取 | 一律 `Array.isArray(json.content) ? ... : []` |
| 工具循环 | 保证每个 `tool_use` 有配对 `tool_result`；assistant 轮**保留 `tool_use` 块**；thinking 可留可省 |
| 图片 | 固定 `response_format:"base64"`（规避 24h 失效）；解码后嗅探魔数；`Number(metadata.success_count)` |
| 超时 | messages ≥120s（含 thinking 可能需要更久）；image **≥180s** |
| 限流 | 无可用响应头 → 被动退避（`429` / `1002` / `2056`）|
| SSE 解析 | 按 `\n\n` 切块；`event` + `data` 双行；无 `[DONE]`；`data.type === event` 可作校验 |
