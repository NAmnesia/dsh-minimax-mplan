# dsh-minimax-mplan

把 **MiniMax M Plan 订阅**接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：
让主代理把细分工作交给 MiniMax 子代理执行，并直接使用 MiniMax 的文生图能力。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

- **零运行时依赖** —— 不 import 任何 `@deepseek-ai/*` 包
- **图形化配置** —— 装好后在 DSH 设置里填 API Key，无需编辑配置文件
- **纯 Host 插件** —— 无客户端代码，不需要重启 GUI

---

## 能力

| 工具 | 作用 |
| --- | --- |
| `minimax_generate_image` | 文生图。图片经 DSH attachment 服务**进入会话**，你和模型都能直接看到。 |
| `minimax_delegate` | 把自包含任务交给 MiniMax 子代理。它带工具循环，能自己出图、读写工作区文件、列目录。 |
| `minimax`（可选） | 向 `ctx.subagents` 注册的提供方，供官方 `dsh-tool-subagent` 以 `provider: minimax` 使用。 |

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
| 设置里看不到插件的配置表单 | schemastery 版本过旧。插件已做兼容，若仍不行请升级 DSH。 |

---

## 实现说明

```text
lib/index.js     Cordis 入口：Config schema、两个工具、可选 subagent 提供方
lib/minimax.js   MiniMax 客户端（仅用 Node 内置 fetch）+ 错误归类 + 模型名核验
lib/image.js     图片落盘与 DSH attachment 适配
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

### 设置界面为什么能自动生成表单

DSH 设置界面（`dsh-settings` 的 `volatileForm()`）只把 `meta.volatile === true`
的字段投影成控件；`dsh-app-boot` 的 `isNativeConfigSchema()` 还要求
`Symbol.for('schemastery') === true`。所以 `Config` 必须是**原生 schemastery
Schema**，并且每个字段都要 `.volatile()`。

`.volatile()` 还有个副作用：该字段**不参与值解析**，直接调用 `Config(raw)`
会得到 cosmokit 惰性 jar。Cordis 走 `~standard.validate` 拿到的是原始值，
插件对两种形态都做了兼容解包。

### 测试

```bash
node test/offline.mjs       # 24 项离线单测，不联网
node test/contract.mjs      # 21 项契约测试，验证 DSH 加载契约
node test/native-schema.mjs # 验证 Config 能被设置界面识别
node test/live-smoke.mjs    # 真实端点冒烟（会消耗少量 M Plan 额度）
```

---

## 许可

[MIT](LICENSE)
