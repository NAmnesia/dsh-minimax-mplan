# dsh-minimax-mplan

把 **MiniMax M Plan 订阅**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：
让主代理把细分工作交给 MiniMax 子代理执行，并直接使用 MiniMax 的**文生图 / 图生图**能力。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **零运行时依赖** —— 不 import 任何 `@deepseek-ai/*` 包
- **图形化配置** —— 装好后在 DSH 设置里填 API Key，无需编辑配置文件
- **纯 Host 插件** —— 无客户端代码，不需要重启 GUI

---

## 能力

| 工具 | 作用 |
| --- | --- |
| `minimax_generate_image` | 文生图。图片经 DSH attachment 服务**进入会话**，你和模型都能直接看到。 |
| `minimax_image_to_image` | **图生图**：以一张参考图作主体参考，生成保留同一人物/主体特征的新图。 |
| `minimax_delegate` | 把自包含任务交给 MiniMax 子代理。它带工具循环，能自己出图、读写工作区文件、列目录。 |
| `minimax`（可选） | 向 `ctx.subagents` 注册的提供方，供官方 `dsh-tool-subagent` 以 `provider: minimax` 使用。 |

---

## 图生图怎么用

MiniMax 的图生图和文生图是**同一个接口**（`/v1/image_generation`），只是多传一个
`subject_reference`（主体参考）字段。本插件把它包成了一个独立工具。

参考图的取法，按优先级：

1. **`image_path`** —— 工作区内的图片文件路径（相对工作目录）。
2. **会话里最近一张图片** —— 不给路径时的默认行为。包括：
   - 用户刚在对话里发的那张图；
   - 之前一次文生图产出的图（因为工具结果里带 image 块）。

也就是说最常见的用法是：**直接在聊天里丢一张图给模型，说「照这张画个别的」**，
模型调用 `minimax_image_to_image` 即可，不用你操心路径。

### 平台侧硬约束（会先在本地拦下来）

| 约束 | 说明 |
| --- | --- |
| 参考图数量 | 一次请求**只支持 1 张** |
| 主体类型 | `type` 目前**只支持** `character`（人像主体参考） |
| 参考图格式 | 只接受 **JPG / JPEG / PNG**（WebP / GIF 会被本地拒绝） |
| 参考图大小 | **小于 10MB** |
| 参考图来源 | 只接受**本地文件或会话附件**；不接受公网 URL |

> 平台目前没有提供 mask / inpainting / 局部重绘这类像素级编辑参数，
> 图生图本质是「换一个场景重画同一个主体」，不是通用图片编辑器。

### 隐私设计

- 参考图以 **base64 Data URL** 直接发给 MiniMax，**不经过任何第三方图床**，
  你的图不会落到任何公开可访问的地址上。
- 刻意**不支持**把公网 URL 当参考图：让平台去拉一个 URL，等于把图暴露给
  所有能访问该地址的一方。
- 参考图只在内存里待到请求发出为止，不落盘、不写日志、不进工具返回值。
- API Key 只出现在 `Authorization` 头里；平台若在错误体里回显 Key，
  插件会在错误文案里**打码**后才返回给模型。
- 参考图路径必须留在工作目录内，越界路径直接拒绝（不读盘、不发请求）。

### 不影响其它 DSH 插件

- 三个工具名统一带 `minimax_` 前缀，不会和别的插件撞名
  （`dsh-tools` 同名注册会直接抛错）。
- 所有注册都挂在 `ctx.effect` 上，插件卸载即自动注销，不给别的插件留残留作用域。
- 可选服务（`attachments` / `workingDirectory` / `systemPrompt` / `subagents`）
  一律用 `ctx.get()` 取，**绝不写进 `inject`**，不会拖住别的插件装配。
- 只写自己的工作目录子目录 `.minimax-images/`，不碰工作区其它路径。
- 不改写任何全局状态（`fetch` / `process.env` / 别的插件的注册表）。

---

## 安装

### 方式 1：DSH 设置界面（推荐）

1. 打开 DSH → **设置 → 插件**
2. 点「安装」，选择下载好的 `.tgz` 文件（或粘贴包名）
3. 重启 DSH

### 方式 2：命令行

```bash
# 从本地 tarball
dsh plugin --profile desktop add ./dsh-minimax-mplan-1.1.0.tgz

# 从 npm（发布后）
dsh plugin --profile desktop add dsh-minimax-mplan

# 从 git
dsh plugin --profile desktop add github:你的账号/dsh-minimax-mplan
```

---

## 配置 API Key

装好后有两种方式，**任选其一**。

### 方式 A：图形界面（推荐）

**设置 → 插件 → 找到 dsh-minimax-mplan → 配置**，填入：

| 字段 | 填什么 |
| --- | --- |
| **M Plan 订阅 Key** | `sk-cp-` 开头的 Key |
| 其他字段 | 保持默认即可 |

这个字段标记为 `secret`，保存后界面上会脱敏显示，不会以明文回传浏览器。

### 方式 B：环境变量

```powershell
# Windows PowerShell（永久生效，需重开终端）
setx MINIMAX_CN_API_KEY "sk-cp-你的Key"
```

```bash
# macOS / Linux
echo 'export MINIMAX_CN_API_KEY="sk-cp-你的Key"' >> ~/.zshrc && source ~/.zshrc
```

插件按 **配置里的 apiKey → DSH 凭据 → 环境变量** 的顺序查找，先找到的生效。

### 怎么拿到 Key

1. 打开 [MiniMax 控制台 · 套餐详情](https://platform.minimax.cn/console/plan)
2. 订阅 M Plan（Go / Explore / Build 任一档）
3. 复制**订阅 Key**，形如 `sk-cp-xxxxxxxx`

> ⚠️ **必须是订阅 Key（`sk-cp-` 开头），不是按量计费 Key（`sk-api-` 开头）。**
> 两者额度互不通用。填错不会报错，只会静默扣你账户余额。

---

## 使用

装好之后不用记工具名，直接说人话：

```text
画一只戴耳机的橘猫，扁平插画风
```

```text
让 MiniMax 帮我写一份 800 字产品介绍，保存成 intro.md
```

```text
做一张发布会封面，16:9，深蓝科技风，中间放发光晶体
```

```text
（先丢一张人物照片）照这张画一版水彩插画风
```

> **关键约束**：委派的任务必须自包含。子代理看不到你和主代理的对话，
> 所以别说「把上面那段代码优化一下」，要贴全文。

---

## 配置项

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | `''` | M Plan 订阅 Key。留空则回退到凭据/环境变量。 |
| `apiKeyEnv` | `MINIMAX_CN_API_KEY` | 凭据引用名（环境变量名）。 |
| `baseURL` | `https://api.minimax.cn` | API 根地址。 |
| `textModel` | `MiniMax-M3.1-Flash` | 文本模型。平台对未知模型名会静默回退，插件会核验。 |
| `imageModel` | `image-01` | `image-01` 或 `image-01-live`。 |
| `reasoningEffort` | `max` | `low` / `medium` / `high` / `xhigh` / `max`。降低更快更省。 |
| `maxTokens` | `32768` | 最大生成 token（含 thinking）。太小会被 thinking 吃光导致空输出。 |
| `maxTurns` | `12` | 子代理工具循环最多轮数。 |
| `delegateToolName` | `minimax_delegate` | 委派工具名。 |
| `imageToolName` | `minimax_generate_image` | 出图工具名。 |
| `imageToImageToolName` | `minimax_image_to_image` | 图生图工具名。 |
| `registerSubagentProvider` | `true` | 是否注册 `minimax` subagent 提供方。 |
| `allowWorkspaceWrites` | `true` | 是否允许子代理写工作区文件。 |

---

## 排查

| 现象 | 原因与解决 |
| --- | --- |
| 提示「未配置 MiniMax API Key」 | 三条回退都没命中。检查设置里的 Key 或环境变量。 |
| `1004 账号鉴权失败` | Key 填错，或用成了按量计费 Key。 |
| `2056 超出 M Plan 资源限制` | 套餐额度用完（5 小时 / 周双窗口）。去[控制台](https://platform.minimax.cn/console/usage)看用量。 |
| 图片被内容安全拦截 | 换提示词，避免敏感描述。 |
| 委派返回空内容 | `maxTokens` 太小被 thinking 吃光，调大即可。 |
| 图生图报「参考图格式不支持」 | 平台只收 JPG/PNG。把 WebP/GIF 转成 PNG 再试。 |
| 图生图报「参考图过大」 | 参考图超过 10MB，先压缩。 |
| 图生图报「没有找到可用的参考图」 | 会话里还没有图片。把图放进工作区并用 `image_path` 指定，或先在对话里发一张图。 |
| 图生图报「路径越界」 | `image_path` 必须相对工作目录，不能用 `../` 越出去。 |
| 图生图报 2013 参数异常 | 把 `imageModel` 改回 `image-01`（`image-01-live` 对主体参考支持不稳）。插件会自动降级重试一次。 |
| 设置里看不到插件的配置表单 | schemastery 版本过旧。插件已做兼容，若仍不行请升级 DSH。 |

---

## 实现说明

```text
lib/index.js     Cordis 入口：Config schema、三个工具、可选 subagent 提供方
lib/minimax.js   MiniMax 客户端（仅用 Node 内置 fetch）+ 错误归类 + 模型名核验 + 主体参考
lib/image.js     图片落盘、参考图校验与 DSH attachment 适配
```

### 来自真实端点探测的硬约束

改代码前请先读，这些都是实测结论（详见 [verify/REPORT.md](verify/REPORT.md)）：

1. **模型名静默回退** —— 传不存在的模型名不报错，平台直接回退到 `MiniMax-M3`。
   必须读响应回显的 `model` 字段核验，不能靠「调用失败再换名字」。
2. **图片接口 HTTP 恒为 200** —— 错误只在 `base_resp.status_code`，
   必须同时校验平台码与 `data` 非空。
3. **thinking 关不掉** —— M3.1-Flash 传 `{"type":"disabled"}` 必 400；
   `max_tokens` 太小时会被 thinking 吃光、无正文输出。
4. **图片必须过 attachment 服务** —— 自造 `attachmentId` 会在下一轮请求时失败。
   存储拒绝时插件自动退回落盘。
5. **`stop_sequences` 不生效** —— 网关静默忽略，别用它做输出约束。
6. **图生图 = 文生图 + `subject_reference`** —— 同一个端点、同一个响应结构，
   不要另开一条请求路径。
7. **`metadata.success_count/failed_count` 是字符串** —— 必须 `Number()` 后比较。

### 设置界面为什么能自动生成表单

DSH 设置界面（`dsh-settings` 的 `volatileForm()`）只把 `meta.volatile === true`
的字段投影成控件；`dsh-app-boot` 的 `isNativeConfigSchema()` 还要求
`Symbol.for('schemastery') === true`。所以 `Config` 必须是**原生 schemastery
Schema**，并且每个字段都要 `.volatile()`。

`.volatile()` 还有个副作用：该字段**不参与值解析**，直接调用 `Config(raw)`
会得到 cosmokit 惰性 jar。Cordis 走 `~standard.validate` 拿到的是原始值，
插件对两种形态都做了兼容解包（`unwrap`）。注意 schemastery ≥ 3.18.3 走
原生 `.volatile()` 时，`~standard.validate` 返回的**也是**惰性 jar ——
测试里统一用 `plain()` 解包，避免断言随本机 schemastery 版本漂移。

### 测试

```bash
node test/offline.mjs       # 37 项离线单测，不联网
node test/contract.mjs      # 21 项契约测试，验证 DSH 加载契约
node test/native-schema.mjs # 验证 Config 能被设置界面识别
node test/live-smoke.mjs    # 真实端点冒烟（会消耗少量 M Plan 额度，约 2 张图）
```

> `live-smoke.mjs` 会真的调用 MiniMax 出图，**消耗你的 M Plan 额度**。
> 请自己手动跑，别放进 CI。

---

## 许可

[MIT](LICENSE)
