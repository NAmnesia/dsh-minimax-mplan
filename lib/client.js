/**
 * Client 端配置卡片：让用户在 DSH 设置 → 插件里直接填 MiniMax API Key。
 *
 * 为什么需要这个文件：
 *   Host 端的 `Config` schema 只决定"配置**可以**被编辑"，
 *   真正把输入框画出来的是 Client 端注册在 `plugins.row.config` /
 *   `plugins.bundle.config` 槽位上的组件。官方设置页只渲染那些槽位，
 *   没有注册就什么也看不到。
 *
 * 数据通路：
 *   - 读：`ctx.configForms.get(ns).getSnapshot().value`（Host 的镜像）
 *   - 写：`scope.set(field, nextValue)` —— 注意它写的是**整个字段**，
 *     不做服务端合并，所以必须基于当前快照构造完整对象。
 *
 * 浏览器产物格式：`window.__ModuleLoader__.load({ id, factory })`，
 * React 从模块表里取，不能自带一份。
 *
 * 2026-10-19 崩溃修复：顶层必须容错。
 * 1) window.__ModuleLoader__ 可能未就绪（老版本 DSH 或预加载环境）
 * 2) 在非浏览器环境（Node.js 单测）里 window 本身不存在
 * 任何顶层 throw 都会导致 renderer 加载失败，进而 host 端 settings RPC 异常。
 */
const __loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
if (__loader !== undefined) {
  __loader.load({
  // 这个 id 必须等于包名：DSH 用它把浏览器模块与 package.json 的 dsh.client
  // 声明对应起来，写错会导致模块不被装配。
  id: 'dsh-minimax-mplan',
  factory: (require) => {
    const react = require('react');
    const runtime = require('react/jsx-runtime');

    /**
     * 本插件的配置命名空间。
     *
     * 规则（两条独立证据）：
     *  1. Host 的 `dsh-settings` 用 `entry.options.id` 作为 ns
     *     （`lib/index.js:432` `ns: entry.options.id`、:443 `ns: entry.options.id`）。
     *     而 Loader 条目的 `options.id` 就是 bundle patch 里那行的 `id`，
     *     也就是本插件的 `minimax-mplan`，**不是**包名、也不是 `include:minimax-mplan`。
     *  2. 官方同款插件 `cot-translation` 在 `cordis.patch.yml` 里 `id: cot-translation`，
     *     客户端就写 `ctx.configForms.get('cot-translation')`
     *     （`dsh-experimental-client-ui-cot-translation/lib/client.js:961`）。
     *     包名是 `@deepseek-ai/dsh-experimental-client-ui-cot-translation`，和 ns 完全不同。
     *
     * 所以这里唯一正确的是 `minimax-mplan`。旧代码猜的
     * `dsh-minimax-mplan` / `include:minimax-mplan` 都取不到 scope。
     */
    const NAMESPACE = 'minimax-mplan';

    /** 包名：bundle 详情页用它的包名作为键。 */
    const PACKAGE_NAME = 'dsh-minimax-mplan';

    /** 文案字典命名空间（与官方插件一样，独立于配置命名空间）。 */
    const LOCALE_NS = 'minimaxMplan';

    /** bundle 的 patch 声明的行 id（`cordis.patch.yml` 里的 `id`）。 */
    const ROW_ID = 'minimax-mplan';

    /**
     * 卡片在 Plugins 页面里注册的键。
     *
     * 页面用 `rowConfigKey(bundle, rowId) = `${bundle}#${rowId}`` 拼行级键，
     * 并用 `ledger.rows.has(...)` 判定这一行「有没有配置」—— 只有命中，
     * 行后面的「配置」按钮才会出现。所以这里必须是 `包名#行id`，
     * 不能拿包名去填行 id 那一段（旧代码写的 `包名#包名` 永远匹配不上）。
     */
    const SLOT_CARDS = [
      { slotName: 'plugins.row.config', key: `${PACKAGE_NAME}#${ROW_ID}` },
      { slotName: 'plugins.bundle.config', key: PACKAGE_NAME },
    ];

    /** 运行时插件名。 */
    const name = 'dsh-minimax-mplan';

    /**
     * 硬依赖。
     *
     * `configForms` 必须是**硬依赖**：官方同款插件直接写在 inject 里
     * （`dsh-experimental-client-ui-cot-translation/lib/client.js:891-896`）。
     * 走 `ctx.get()` 软取的话，客户端装配顺序可能让 `configForms` 还没挂上，
     * apply 就跑了，于是 scope 恒为 undefined、卡片退化成「配置服务尚未就绪」。
     */
    const inject = ['slots', 'locale', 'configForms'];

    const zh = {
      title: 'MiniMax M Plan',
      intro: '填入 M Plan 订阅 Key（sk-cp- 开头）即可使用。留空则回退到环境变量 MINIMAX_CN_API_KEY。',
      apiKey: 'M Plan 订阅 Key',
      apiKeyPlaceholder: 'sk-cp-...',
      apiKeyHint: '标记为 secret：保存后界面会脱敏显示。',
      apiKeyEnv: '环境变量名',
      apiKeyEnvHint: '当上面的 Key 留空时，从这里指定的环境变量读取。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saved: '已保存',
      notWritable: '当前 profile 不可写，无法保存。',
      unavailable: '配置服务尚未就绪，请稍后重新打开本页。',
      loading: '正在读取配置…',
      saveFailed: '本部署没有接受这些值，已保留供你修改',
      dirty: '有未保存的修改',
      secretKept: '已保存（脱敏显示）',
    };

    const en = {
      title: 'MiniMax M Plan',
      intro: 'Paste your M Plan subscription key (starts with sk-cp-). Leave empty to fall back to MINIMAX_CN_API_KEY.',
      apiKey: 'M Plan subscription key',
      apiKeyPlaceholder: 'sk-cp-...',
      apiKeyHint: 'Marked as secret: redacted once saved.',
      apiKeyEnv: 'Environment variable name',
      apiKeyEnvHint: 'Used when the key above is empty.',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Saved',
      notWritable: 'This profile is not writable.',
      unavailable: 'Configuration service is not ready yet. Reopen this page later.',
      loading: 'Reading configuration…',
      saveFailed: 'This deployment did not accept these values; they were left for you to correct',
      dirty: 'Unsaved changes',
      secretKept: 'Saved (redacted)',
    };

    /** 极简样式：只用主题 token，跟随明暗主题。 */
    const css = `
.mm-card{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary)}
.mm-title{font-size:15px;font-weight:600;margin:0}
.mm-intro{margin:0;color:var(--dsw-alias-label-tertiary);line-height:18px}
.mm-row{display:flex;flex-direction:column;gap:4px}
.mm-label{font-weight:500}
.mm-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-l1);
  color:inherit;font:inherit}
.mm-input:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.mm-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mm-actions{display:flex;gap:8px;align-items:center}
.mm-btn{padding:5px 12px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-l1);color:inherit;font:inherit;cursor:pointer}
.mm-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);color:#fff;border-color:transparent}
.mm-btn:disabled{opacity:.5;cursor:default}
.mm-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mm-status[data-error=true]{color:var(--dsw-alias-state-error-primary)}
`;

    /** 确保样式只注入一次。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      const id = 'dsh-minimax-mplan-client/styles';
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-minimax-mplan-client';
      tag.dataset.pluginCss = id;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /** 从 volatile jar 或普通值里取出真实值。 */
    function unwrap(value, fallback) {
      if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        try {
          const inner = value.get();
          return inner === undefined ? fallback : inner;
        } catch {
          return fallback;
        }
      }
      return value === undefined ? fallback : value;
    }

    /** 配置卡片组件。 */
    function MiniMaxCard(props) {
      const { t, scope } = props;
      ensureStyle();

      const translate = typeof t === 'function' ? t : (key) => key;

      // 订阅 Host 的配置镜像；scope 可能晚到，用 state 追踪。
      const [snapshot, setSnapshot] = react.useState(() => scope?.getSnapshot());
      react.useEffect(() => {
        if (scope === undefined) return undefined;
        setSnapshot(scope.getSnapshot());
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()));
      }, [scope]);

      const value = snapshot?.value ?? {};
      const status = snapshot?.status;
      const writable = snapshot?.writable === true;

      // apiKey 是 secret：Host 固定带 redactSecrets 下发，读回的是脱敏值，
      // 不能拿它当真实值显示在输入框里（否则用户一点保存就把脱敏串写回去）。
      const savedApiKey = unwrap(value.apiKey, '');
      const savedApiKeyEnv = unwrap(value.apiKeyEnv, 'MINIMAX_CN_API_KEY');

      // 草稿态：只在用户改动后与 saved 不同。
      const [draftKey, setDraftKey] = react.useState(null);
      const [draftEnv, setDraftEnv] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [message, setMessage] = react.useState(undefined);
      const [isError, setIsError] = react.useState(false);

      // 配置变化后清掉草稿（例如别处写入）。
      react.useEffect(() => {
        setDraftKey(null);
        setDraftEnv(null);
      }, [savedApiKey, savedApiKeyEnv]);

      const apiKeyValue = draftKey ?? savedApiKey;
      const apiKeyEnvValue = draftEnv ?? savedApiKeyEnv;
      const dirty = draftKey !== null || draftEnv !== null;

      /**
       * 保存。
       *
       * `scope.set(field, value)` 写单字段（内部就是 mutate [{op:'set',path:[field]}]），
       * 不需要也不应该自己拼整个对象。
       *
       * 关键：它返回 `Promise<boolean>`，**被拒时返回 false 而不抛异常**
       *（`dsh-client-ui-settings/lib/client.js:1140`、:1171-1174）。
       * 所以必须检查返回值，否则保存失败也会显示「已保存」。
       */
      const onSave = async () => {
        if (!writable) return;
        setBusy(true);
        setMessage(undefined);
        setIsError(false);
        try {
          const results = [];
          if (draftKey !== null) results.push(await scope.set('apiKey', draftKey.trim()));
          if (draftEnv !== null) {
            results.push(await scope.set('apiKeyEnv', draftEnv.trim() || 'MINIMAX_CN_API_KEY'));
          }
          if (results.some((ok) => ok !== true)) {
            setIsError(true);
            setMessage(translate('saveFailed'));
            return;
          }
          setDraftKey(null);
          setDraftEnv(null);
          setMessage(translate('saved'));
        } catch (error) {
          setIsError(true);
          setMessage(error?.message ?? String(error));
        } finally {
          setBusy(false);
        }
      };

      if (scope === undefined || status === 'loading' || status === 'unavailable') {
        return runtime.jsxs('div', {
          className: 'mm-card',
          children: [
            runtime.jsx('p', { className: 'mm-title', children: translate('title') }),
            runtime.jsx('p', {
              className: 'mm-intro',
              children: translate(status === 'loading' ? 'loading' : 'unavailable'),
            }),
          ],
        });
      }

      return runtime.jsxs('div', {
        className: 'mm-card',
        children: [
          runtime.jsx('p', { className: 'mm-title', children: translate('title') }),
          runtime.jsx('p', { className: 'mm-intro', children: translate('intro') }),

          runtime.jsxs('div', {
            className: 'mm-row',
            children: [
              runtime.jsx('label', { className: 'mm-label', children: translate('apiKey') }),
              runtime.jsx('input', {
                className: 'mm-input',
                type: 'password',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: translate('apiKeyPlaceholder'),
                value: apiKeyValue,
                disabled: busy || !writable,
                onChange: (event) => setDraftKey(event.target.value),
              }),
              runtime.jsx('p', { className: 'mm-hint', children: translate('apiKeyHint') }),
            ],
          }),

          runtime.jsxs('div', {
            className: 'mm-row',
            children: [
              runtime.jsx('label', { className: 'mm-label', children: translate('apiKeyEnv') }),
              runtime.jsx('input', {
                className: 'mm-input',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                value: apiKeyEnvValue,
                disabled: busy || !writable,
                onChange: (event) => setDraftEnv(event.target.value),
              }),
              runtime.jsx('p', { className: 'mm-hint', children: translate('apiKeyEnvHint') }),
            ],
          }),

          writable
            ? runtime.jsxs('div', {
                className: 'mm-actions',
                children: [
                  runtime.jsx('button', {
                    type: 'button',
                    className: 'mm-btn',
                    'data-primary': true,
                    disabled: busy || !dirty,
                    onClick: onSave,
                    children: busy ? translate('saving') : translate('save'),
                  }),
                  runtime.jsx('button', {
                    type: 'button',
                    className: 'mm-btn',
                    disabled: busy || !dirty,
                    onClick: () => {
                      setDraftKey(null);
                      setDraftEnv(null);
                      setMessage(undefined);
                    },
                    children: translate('discard'),
                  }),
                  message === undefined
                    ? null
                    : runtime.jsx('span', {
                        className: 'mm-status',
                        'data-error': isError,
                        children: message,
                      }),
                  dirty && message === undefined
                    ? runtime.jsx('span', { className: 'mm-status', children: translate('dirty') })
                    : null,
                ],
              })
            : runtime.jsx('p', { className: 'mm-status', children: translate('notWritable') }),
        ],
      });
    }

    /** 注册配置卡片与文案。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'minimax-mplan: dictionaries');
      const t = ctx.locale.bind(LOCALE_NS);

      // 与官方 cot-translation 一致：直接从服务上取本行的配置作用域。
      // 命名空间固定为行 id，不需要试探多种写法。
      const scope = ctx.configForms.get(NAMESPACE);

      for (const { slotName, key } of SLOT_CARDS) {
        ctx.effect(
          () =>
            ctx.slots.inject(slotName, () =>
              ctx.slots.register(
                {
                  name: slotName,
                  key,
                  locale: LOCALE_NS,
                  inject: () => ({ t, scope }),
                },
                MiniMaxCard,
              ),
            ),
          `minimax-mplan: ${slotName}`,
        );
      }
    }

    return { name, inject, apply };
  },
  });
}
