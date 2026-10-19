# dsh-minimax-mplan v1.2.1 — 崩溃修复报告

## 根因

DSH 桌面端 2026-10-19 20:06 崩溃的直接原因：

**`lib/index.js` 的 `Config` 导出使用了 top-level await**：
```js
// 崩溃前（v1.2.0）：
export const Config = await (async () => { ... })();
```

Cordis 插件加载器的 `_init()` 方法同步访问 `moduleNamespace.Config`。
当模块还在 TLA 解析中时，`Config` 是 Promise 而非 Schema 对象。
这导致：
1. `isNativeConfigSchema()` 判定失败
2. `dsh-settings` 的 `volatileForm(undefined)` 抛 TypeError
3. `settings.describe()` RPC 返回 `{ ok: false }`
4. 桌面壳收到 RPC 失败 → `reportFatal` → 进程退出

## 修复内容

### 1. lib/index.js — Config 改为同步导出
```js
// 修复后（v1.2.1）：
import { createRequire } from 'node:module';

function loadSchemastery() {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('@deepseek-ai/schemastery');
    return mod?.default ?? mod;
  } catch {
    return undefined;
  }
}

function buildConfig() {
  const z = loadSchemastery();
  if (z === undefined) return minimalFallbackSchema;
  try {
    return z.object({ ... });
  } catch {
    return buildFallbackSchema(z);
  }
}

export const Config = buildConfig();  // 同步值，Cordis 立即可用
```

### 2. lib/client.js — 顶层加载容错
```js
// 修复前：
window.__ModuleLoader__.load({ ... });  // 非浏览器环境直接 throw

// 修复后：
const __loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
if (__loader !== undefined) {
  __loader.load({ ... });
}
```

### 3. package.json — 版本号升至 1.2.1

## 验证结果

所有 Cordis 兼容性检查通过：
- ✅ Config 同步可访问（不再是 Promise）
- ✅ schemastery 符号检测通过
- ✅ `volatileForm()` 正常生成 12 个字段的表单
- ✅ `redactSecrets()` 正确脱敏 apiKey
- ✅ `apply()` 函数签名正确
- ✅ `client.js` 在 Node 环境加载不 throw

## 用户操作步骤

### 立即可用（本地 link 安装）
1. 在 DSH 中打开命令面板：`/plugin install dsh-minimax-mplan`
   或手动重启 DSH（因为插件的 `link:` 依赖已在 profile 里）
2. 打开 DSH 设置 → 插件 → dsh-minimax-mplan
3. 填入 M Plan 订阅 Key（sk-cp- 开头）

### 让插件在市场上可被搜索（发布）
1. **推送到 GitHub**：
   ```bash
   cd D:\dsh_coding\dsh-minimax-mplan
   git push origin main
   ```

2. **发布 npm 包**（可选，也可以只用 git source）：
   ```bash
   npm publish
   ```

3. **托管市场索引 JSON**：把 `market-index.json` 托管到任意最终 URL：
   - 推到 GitHub 后可以通过 raw URL 访问：
     `https://raw.githubusercontent.com/NAmnesia/dsh-minimax-mplan/main/market-index.json`
   - 或发布到 GitHub Pages
   - 或用 GitHub Gist 的 raw URL

4. **用户在 DSH 中添加索引源**：
   - 打开 DSH → Discover（发现）→ Add index source
   - 粘贴上述 URL
   - 搜索 "minimax" 即可找到插件并安装

### 市场索引格式
`market-index.json` 遵循 DSH plugin-market-index 的 format 1 规范：
- `source.type: "git"` + `url` + `commit`（40位hex）→ 从 Git 安装
- `source.type: "npm"` + `registry`（可选）→ 从 npm 安装
- `engines.dsh` 声明兼容的 DSH 版本范围

## 文件变更
```
lib/index.js      — Config 改为同步导出（核心修复）
lib/client.js     — 顶层加载容错（防御性修复）
package.json      — 版本号 1.2.0 → 1.2.1
market-index.json — 新增（插件市场索引）
```
