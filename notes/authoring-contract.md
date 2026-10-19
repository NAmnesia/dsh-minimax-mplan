# DSH Host 插件精确编写契约（0.2.1-rc.2 实测）

证据优先级：`cordis_inspect_query`（活的服务/类型） > asar 内 `lib/index.js` 源码 > 已安装第三方插件。
注意：本机 asar 只保留 `lib/index.js`，多数包 **没有** `lib/types/**/*.d.ts`（read 会报 not found）。
要精确类型请用 `cordis_inspect_query`（Host `Service`/`Config`/`Tool`、Client `Slots`/`Theme`）。

---

## A. ToolDefinition：`output.render` 是模型可见 content 的唯一来源

**结论（实据）**：`ctx.tools.register(def)` 只接受 `{name, description, parameters, output:{schema, render, presentationMeta?}, execute}`；
**`render` 必须返回 `ContentBlock[]`**，`execute` 的返回值只作为“规范 JSON 值”喂给 `render`，本身不进模型上下文。

- 依据 `...\@deepseek-ai\dsh-tools\lib\index.js:2974-2983`
  ```js
  register(definition) {
    if (output === void 0 || typeof output !== "object" || typeof output.render !== "function"
      || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function")
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
    assertSupportedJsonSchema(output.schema);
  ```
- 返回值→content 映射 `dsh-tools\lib\index.js:3637-3667`
  ```js
  const detached = snapshotToolValue(tool.name, candidate);
  const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
  if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
  rendered = tool.output.render(exec.arguments, value);
  const content = snapshotProjection(tool.name, "render", rendered);   // 即最终 content
  meta = tool.output.presentationMeta?.(exec.arguments, value);
  ```
- 抛错路径 `dsh-tools\lib\index.js:3712-3726`：`execute` throw → `content:[{type:'text',text:'Error: '+msg}], isError:true`。
  **不要**用返回字符串表示失败，要 `throw`（`HarnessError` 还能带 `code`）。
- `finalizeContent`/`projectContent`/`presentCall`/`presentResult`/`timeoutMs`/`isConcurrencySafe`/`deferLoading` **全部可选**。
  类型（inspect `Service tools` 的 referencedTypes）：
  ```ts
  interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    projectContent?(...): ContentBlock[] | undefined;
    finalizeContent?(...): ContentBlock[] | undefined;
    timeoutMs?: number; isConcurrencySafe?(args): boolean;
    presentCall?(args): ToolCallView | undefined;
    presentResult?(args, result: ToolResult): ToolResultView | undefined;
  }
  interface ToolOutputDefinition { readonly schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue; }
  interface ToolRunContext extends ToolExecution { deferContext(m: UserMessage): void; concludeTurn(): void; }
  interface ToolExecution { callId; rootCallId; name; arguments; agent?: {id: SessionId; session: Session}; signal: AbortSignal; }
  ```

**官方真实写法（原文摘录，`dsh-tool-web\lib\index.js:736-818` `web_fetch`）**
```js
import { defineTool } from "@deepseek-ai/dsh-tools";
ctx.tools.register(defineTool({
  name: "web_fetch",
  description: "...",
  parameters: { url: { type: "string", required: true, description: "..." } },
  output: {
    schema: { type: "object", additionalProperties: false, properties: { url: {type:"string",required:true}, ... } },
    render: (_args, value) => [{ type: "text", text: formatFetchOutput(value, maxOutputChars) }],
    presentationMeta: (_args, value) => fetchMetaFromValue(value, maxOutputChars),
  },
  timeoutMs, isConcurrencySafe: () => true,
  async execute(args, exec) { const result = await ctx.web.fetch({url: input.url}, exec.signal); return {...}; },
  presentCall: presentFetchCall,
  presentResult: (args, result) => presentFetchResult(args, result),
}));
```

**文本 + 图片（ImageBlock）的合法构造**：`dsh-tool-fs\lib\index.js:966-974` + `1006`
```js
function imageReadContent(value) {
  return [
    { type: "text",  text: formatImageReadOutput(value.path, value.image) },
    { type: "image", attachment: imageRefFromValue(value.image) },
  ];
}
// ...
output: { schema: {...}, render: (_args, value) => imageReadContent(value) },
```
`ImageBlock`（inspect 类型）：`{ type:'image'; attachment: ImageAttachmentRef; offloaded?: true }`；
`ImageAttachmentRef = { attachmentId: AttachmentId; mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; bytes; width; height; name?; originalDimensions? }`。
`attachmentId` 必须由 `attachments.saveImage(s)` 产出的**真 id**（见 B），**不要自己编**：模型请求时会
`readImageRequest(ref,...)` 按 id 读字节，假 id 会在下一轮请求时才炸。

## B. `ctx.attachments.saveImages(...)`：ImageBlock 的唯一正路

- 入参/返回（inspect `Service attachments`）
  ```ts
  interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string }
  saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  validateImage(input): Promise<void>
  readonly imageLimits: { maxImageBytes; maxImagesPerMessage; maxMessageImageBytes; maxImagePixels; maxImageDimension; mediaTypes }
  ```
- 官方用法 `dsh-tool-fs\lib\index.js:1027-1031`（读取后转 AttachmentRef 返回给 `render`）
  ```js
  ref = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) });
  ```
- 可选服务取法（同文件 `1015`）：`const attachments = ctx.get("attachments"); if (!attachments) throw ...`
- 部署限制（`dsh-attachment-local\lib\index.js:971-1018`）：默认 `maxImageBytes=20MiB`、
  `maxImagesPerMessage=20`、`maxImagePixels=64e6`、`maxImageDimension=8192`、`mediaTypes=['image/png','image/jpeg','image/webp','image/gif']`；
  `saveImages` 会先批量校验再逐个 `commit`，失败抛 `AttachmentError`（`code: IMAGE_TOO_LARGE / IMAGE_TOO_MANY_PIXELS / IMAGE_DIMENSION_TOO_LARGE / INVALID_IMAGE / IMAGE_TYPE_MISMATCH`）。
  即：**PNG/JPEG/WebP/GIF、单图 ≤20MiB、边长 ≤8192px、≤64Mpx**，超出必须先降采样。
- 结论：**必须**经 `ctx.attachments` 才能拿到可展示 ImageBlock；直接回 `{type:'image',attachment:{attachmentId:'x',...}}` 只能“看起来像”，下一轮请求必失败。

## C. `export const Config`：用 `@deepseek-ai/schemastery`

**包名**：`import z from "@deepseek-ai/schemastery"`（不是 `schemastery`，也不是 zod）。
Loader 用 `isNativeConfigSchema` 判真（`dsh-app-boot\lib\index.js:2447-2451`：`Symbol.for("schemastery") === true && typeof type === "string" && meta`）；
Cordis 用 `runtime.Config["~standard"].validate(config)`（`cordis\lib\index.js:956-962`）。

**真实原型 A**：`dsh-tool-fs\lib\index.js:1188-1203`
```js
import z from "@deepseek-ai/schemastery";
const inject = ["tools", "fs", "systemPrompt", "workingDirectory"];
const Config = z.object({
  read: z.boolean().default(true),
  readImage: z.boolean().default(true),
  readLimit: z.number().default(READ_LIMIT),
  readMaxLineLength: z.number().default(READ_MAX_LINE_LENGTH),
  readMaxBytes: z.number().default(READ_MAX_BYTES),
});
function apply(ctx, config) { const resolved = config; /* 已带默认值 */ }
export { Config, apply, inject, name };
```
**真实原型 B（默认值/可选/枚举/字典/嵌套，第三方插件）**：`dsh-connect-workbuddy\lib\index.js:5613-5677`
```js
const modelConfig = z.object({ id: z.string().required(), name: z.string().required(),
  contextWindow: z.number().step(1).min(1), maxTokens: z.number().step(1).min(1) });
const regionStateConfig = z.object({
  enabled: z.boolean().default(true).description("..."),
  creditPosition: z.union([z.const("composer"), z.const("stats")]).default("composer").description("..."),
  lastCatalog: z.array(modelConfig).default([]),
  enabledModelIds: z.array(z.string()).default([]),
  contextBudgets: z.dict(z.number().step(1).min(1)).default({}),
  pool: poolConfig.default({}),
});
const Config = z.object({
  authFile: z.string().description("..."),                       // 无 default = 可选
  regions: z.dict(regionStateConfig).default({}).description("..."),
});
```
**真实原型 C（pattern / 枚举字符串 / volatile）**：`dsh-claude-desktop-theme\lib\index.js:622-647`
```js
const Config = z.object({
  enabled: z.boolean().default(false).description("启用 CCD 风格界面").volatile(),
  appearance: z.object({ canvas: z.string().default("").description("...").pattern(HEX_COLOUR) }).default({}).description("背景色").volatile(),
});
```
要点：`.default(x)` 即“可选 + 默认值”，`apply` 拿到的 `config` 已过 schema（缺失字段补默认）；
`.required()` 表示必填；`.description()` 进 Config JSON Schema；枚举用 `z.union([z.const(a), z.const(b)])`；
`volatile()` 仅对 patch 实时生效有意义，且**不能嵌套在 volatile 字段内**（`dsh-app-boot` 会抛
`volatile fields require a fixed object path without an enclosing volatile field`）。

## D. `inject` 与 `ctx.tools` 作用域

- `export const inject` 两种形态都合法（`cordis\lib\index.js:1491-1499` 的 `Inject.resolve` 支持数组或对象）：
  ```js
  const inject = ["tools", "systemPrompt"];                       // 硬依赖：全部就绪才 apply
  const inject = { tools: null, systemPrompt: null };             // 对象形态（可带 per-service config）
  ```
  官方工具全用数组：`dsh-tool-web:832`、`dsh-tool-fs:1188`、`dsh-tool-present:10`。
- **可选服务不要写进 inject**（否则服务缺席时插件永远不 apply）：用 `ctx.get("x")` 判空，或
  `ctx.inject(["webServer"], (webCtx) => { ... })` 局部等待。实据：
  `dsh-550c-boot\lib\index.js:404`、`dsh-llm-pi-ai\lib\index.js`（tool-fs `1221` `ctx.inject(["attachments"], cb)`）、
  `dsh-whale-widget\lib\index.js:1017-1018` 注释：“必须用 ctx.get('deepseekAccount') 读可选服务，绝不能写进 inject —— 一旦进 inject，整个插件会永远等不到服务而完全不 apply”。
- `ctx.tools.register` 作用域：**在插件自身 ctx 上注册 = 全局工具**；在 `agent.ctx` 上注册 = 该 agent 专属
  （`dsh-tools:2974-2983` → `this.layers.effect(this.ctx, ...)`；`ScopedLayers.effect` 用 `scopeOf(ctx)`，
  `dsh-scope\lib\index.js:189-218`）。`restrict()`/`presentAs()` **必须**在 scoped ctx 上调，否则抛错
  （`dsh-tools:2911-2913`、`:2991-2996`）。
- `ctx.tools` 是 `tools` 服务：`register/get/schemas/guard/restrict/presentAs/execute`（inspect `Service tools`）。

## E. package.json / locale / icon / 本地目录安装

**清单**（最小可装 bundle）：
```json
{ "name": "@local/my-plugin", "version": "1.0.0", "private": true, "type": "module",
  "exports": { ".": "./index.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg",
               "./cordis.patch.yml": "./cordis.patch.yml", "./package.json": "./package.json" },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
           "engines": { "dsh": ">=0.2.1-rc.2" } } }
```
`cordis.patch.yml`：`- insert: [ { id: my-plugin, name: "@local/my-plugin", config: {} } ]`。
**只有 patch 不够，只声明 dsh.client 也不可装**：`plugin-manager/lib/index.js:1866` 与 `2074` 都要求
`manifest.dsh.bundle !== undefined`，否则 `not-a-bundle`。

**dsh 字段语义**（`dsh-app-boot\lib\index.js:279-326` `evaluatePluginCompatibility`）：
只认 `dsh.engines.dsh`；没有时不匹配的是 `peerDependencies` 里所有 `@deepseek-ai/dsh*`。不满足 → 安装被拒或启动时该 bundle 被 skipped。
第三方实例：`dsh-550c-boot\package.json:67-81`（`dsh.engines.dsh >=0.2.0-rc.1` + `dsh.bundle.patch` + `dsh.client.{inject,platform}`）。

**locale / icon（精确规则，`dsh-app-boot\lib\index.js:2073-2247` + `:2168-2232`）**
- 只读 `<specifier>/locale/en.json`；再扫**同目录**其他 `*.json` 当其他语言，文件名必须是语言 id（`/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/`）。
- 键：`meta.title`、`meta.description`（都在 `meta` 下，均可选）；`title` 缺省回落 `package.json name`，`description` 缺省为空串。
- 必须通过 **exports** 暴露：`"./locale/*.json": "./locale/*.json"`；`readPluginResource` 走 Node ESM 解析，没导出=没资源。
- icon：优先 `package.json` 顶层 `"icon": "icons/x.png"`（相对清单目录），否则 `<specifier>/icon` 导出；
  格式 SVG/PNG/JPEG/WebP，**≤256 KiB**，必须位于包目录内，否则 `readPluginMeta` 返回 `error` 但保留文字。
- 模板（官方）：`...\dsh-agent-preset\skills\cordis-plugin-development\templates\decoration\{package.json,locale/en.json,cordis.patch.yml,index.js}`。

**`install_bundle` 对本地目录的实际行为**
- 入参：**绝对路径**（`install-spec.js:62-69`：相对路径直接 `invalid-spec: a local path must be absolute`，`file:`/`link:` 前缀可带）。
- 预检：目录必须存在、有可读 `package.json`、有 `dsh.bundle`（`plugin-manager/lib/index.js:1855-1867`）；然后
  `pnpm add <abs path>`（`:2033-2038`），成功后对比 `package.json.dependencies` 差集，必须恰好新增 1 个包，且它有 `dsh.bundle`。
- 失败/取消/无 bundle 会回滚 `package.json` + `pnpm-lock.yaml`（`:1996-2083` 的 `readRestoredFiles/restoreFiles`）。
- 成功后写 `dsh.profile.bundles` 并 reload；结果 `application`：
  `applied`（有 HMR）/ `restart-required`（`restartReason`，无 HMR 时 `no-hmr`）/ `failed`(`error.code`)/ `cancelled` / `overridden`
  （`dsh-plugin-manager\lib\index.js:2373-2400` `change()`；`lib/types/tools.js:46-67` `withNextStep`）。
- **连接方式**：绝对路径依赖由 pnpm 记为 `link:`/`file:` 并在 profile `node_modules` 下建**符号链接/junction**；
  `dsh-app-boot:664-692` `linkedProfileRoots()` 就是枚举这些链接并登记 `linkedRoots`（“linked checkout”）。
  因此：**`files` 字段对本地链接安装不生效**（官方 skill 明说：“Local directory installation links the checkout instead,
  so check the files directly; `files` does not filter a linked directory”）。改源文件即改插件（但已加载模块需重启/HMR 才生效）。
  同理 `main`/`exports` 仍必须对：行 `name: "@local/my-plugin"` 被当作裸包名 import，Node 走 `exports["."]`，没有则回退 `main`。
- 装完确认：`cordis_inspect_query` Host `Config.listConfigs`（按 `name` 过滤，看该行 `status: schema`）；
  或 CLI `dsh --profile desktop --dump-config`（`dsh-app-boot` 导出的 `renderConfigDump` 会打印 `# == <layer>` 注释，能看出是哪一层插了行）。

## F. 工具 execute 里拿当前会话 cwd

服务：`ctx.workingDirectory`（`dsh-working-directory\lib\index.js:12-86`）
```ts
readonly defaultDirectory: string;
get(session: Session): string            // 同步，读已提交目录，无 IO
ensure(agent: Agent, signal?): Promise<string>   // 校验目录存在，必要时恢复原始 project
set(agent: Agent, path: string, signal?): Promise<string>
```
官方用法（工具内，`dsh-tool-fs\lib\index.js:171-177`）：
```js
async function sessionResolveOptions(ctx, exec) {
  const cwd = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  return { ...(cwd !== void 0 ? { cwd } : {}), signal: exec.signal };
}
```
即：`exec.agent.session` 是 `Session`，`exec.agent.session.header.cwd` 也可读（`SessionHeader.cwd?: string`，inspect 类型），
但推荐 `ctx.workingDirectory.ensure(exec.agent, exec.signal)`（会处理目录被删的恢复）。
`inject` 里加 `"workingDirectory"`（tool-fs/tool-present 都这么做；`dsh-tools` 里 run_code 也是用 `ctx.get("workingDirectory").ensure(exec.agent, ...)`）。

## G. logger / effect

- 日志：`ctx.logger.info|warn|error|debug(...)`（`cordis\lib\index.js:640-649` 静态方法，名字按 fiber 名自动派生），
  或 `ctx.logger("my-plugin").warn(...)`（`LoggerService[symbols.invoke]`，`:629-638`）。实例：
  `dsh-local-usage\lib\index.js:1420` `ctx.logger.warn(...)`；`dsh-tools\lib\index.js:3175`。
- 清理：一切注册都挂在 fiber effect 上，返回 disposer 即自动清理：
  ```js
  const dispose = ctx.effect(() => webCtx.webServer.register({...}), "boot-550c: GET /route"); // 官方实例 dsh-550c-boot:405-413
  ctx.effect(() => { const t = setTimeout(warm, ms); return () => clearTimeout(t); }, "…: background fold"); // dsh-local-usage:1428-1433
  // generator 形式可 yield 多个有序 disposer（dsh-scope:192-217 / dsh-tools:2914-2926）
  ```
  `ctx.tools.register` 返回的也是“精确 disposer”，但**不要**手动调用——fiber 卸载会清；重复注册同名工具会抛
  `tool "x" is already registered`（`dsh-tools:2731`）。

## H. 最容易踩的坑（务必转告实现者）

1. **`render` 返回 `ContentBlock[]`，不是字符串**；`execute` 返回的是 JSON 值，必须被 `output.schema` 校验通过（多/少字段都抛 `INVALID_TOOL_OUTPUT`）。
2. **`defineTool` 的 `parameters`/`output.schema` 是“作者 DSL”，不是裸 JSON Schema**：属性级写 `required: true`，
   `object` 节点必须显式 `additionalProperties: true|false`，无约束 JSON 用 `type: "json"`（`dsh-tools:585-753` 的 `runSchemaCompiler`）。
   而如果**不用** `defineTool`、直接给 `ctx.tools.register` 一个对象，则 `parameters`/`output.schema` 要是**裸 JSON Schema**
   （对象级 `required: [...]`），`register` 只校验 `output.schema`（`assertSupportedJsonSchema`），`execute` 不再替你校验入参。
   两种风格不可混用。建议统一用 `defineTool`。
3. **枚举没有 `z.enum`**：用 `z.union([z.const("a"), z.const("b")])`；不要用 zod。
4. **`@deepseek-ai/schemastery` 是包名**；其真伪识别用全局 `Symbol.for("schemastery")`，所以 profile/installation 两份实例可互通。
5. **图片必须过 `ctx.attachments.saveImage/saveImages`**；直接造 `ImageBlock` 的 `attachmentId` 会在下一次模型请求时失败。
6. **可选服务用 `ctx.get(...)`，不要塞进 `inject`**，否则插件可能永不 apply。
7. 本机 asar **没有 `.d.ts`**；查类型用 `cordis_inspect_query`（Host `Service {service}`、`Config {name}`、`Tool {}`），别浪费时间读不存在的类型文件。
8. `plugin_manager` 每次调用都需要 danger-full-access 审批；本会话审批被禁用 → 安装/启用动作必须由有权限的 lead 执行。
