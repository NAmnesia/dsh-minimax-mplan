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

    /** 本插件在 profile 里可能出现的配置命名空间写法（插件无法预知 Loader 用哪个）。 */
    const NAMESPACE_CANDIDATES = ['dsh-minimax-mplan', 'include:minimax-mplan'];

    /** 卡片在 Plugins 页面里注册的键（package name 与 include: 形式都试）。 */
    const CARD_KEYS = ['dsh-minimax-mplan', 'include:minimax-mplan'];

    /** 运行时插件名。 */
    const name = 'dsh-minimax-mplan';

    /** 硬依赖：slots 注册槽位；locale 提供文案。configForms 走 ctx.get() 可选。 */
    const inject = ['slots', 'locale'];

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
      const writable = snapshot?.writable === true;

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

      /** 保存：scope.set 写整个字段，所以基于快照构造完整对象。 */
      const onSave = async () => {
        if (scope === undefined || !writable) return;
        setBusy(true);
        setMessage(undefined);
        setIsError(false);
        try {
          const next = { ...value };
          if (draftKey !== null) next.apiKey = draftKey.trim();
          if (draftEnv !== null) next.apiKeyEnv = draftEnv.trim() || 'MINIMAX_CN_API_KEY';
          // 逐个字段写入：apiKey 是 secret，单独写便于脱敏回读。
          if (draftKey !== null) await scope.set('apiKey', draftKey.trim());
          if (draftEnv !== null) await scope.set('apiKeyEnv', draftEnv.trim() || 'MINIMAX_CN_API_KEY');
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

      if (scope === undefined) {
        return runtime.jsxs('div', {
          className: 'mm-card',
          children: [
            runtime.jsx('p', { className: 'mm-title', children: translate('title') }),
            runtime.jsx('p', { className: 'mm-intro', children: translate('unavailable') }),
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
      const namespace = 'settings.minimax-mplan';
      ctx.effect(() =>
        ctx.locale.register(namespace, {
          zh,
          en,
        }),
      );
      const t = ctx.locale.bind(namespace);

      const forms = ctx.get('configForms');
      let scope;

      /**
       * 绑定到 Host 真正提供的命名空间。
       *
       * 不能只读一次：`configForms` 的镜像由异步 `describe()` 填充，
       * apply 时通常还是空的。用 `whileServed` 跟随服务端状态，
       * 并在状态变化时重新注册槽位（渲染器会按对象身份缓存 inject 结果，
       * 旧的注册不会被重新求值）。
       */
      const registerCards = () => {
        const disposers = [];
        for (const key of CARD_KEYS) {
          for (const slotName of ['plugins.row.config', 'plugins.bundle.config']) {
            try {
              const dispose = ctx.slots.inject(slotName, () =>
                ctx.slots.register(
                  {
                    name: slotName,
                    key: slotName === 'plugins.row.config' ? `${key}#${key}` : key,
                    priority: 30,
                    inject: () => ({ t, scope }),
                  },
                  MiniMaxCard,
                ),
              );
              if (typeof dispose === 'function') disposers.push(dispose);
            } catch {
              // 槽位尚未声明时 inject 会排队，不视为失败。
            }
          }
        }
        return disposers;
      };

      let liveDisposers = [];

      const bind = () => {
        if (forms === void 0 || typeof forms.whileServed !== 'function') {
          // 老版本没有 whileServed：退化为一次性读取。
          scope = forms?.get(NAMESPACE_CANDIDATES[0]);
          liveDisposers = registerCards();
          return;
        }
        ctx.effect(() =>
          forms.whileServed(NAMESPACE_CANDIDATES, (served) => {
            const ns = NAMESPACE_CANDIDATES.find((candidate) => served.has(candidate));
            scope = ns === undefined ? undefined : forms.get(ns);
            liveDisposers = registerCards();
            return () => {
              for (const dispose of liveDisposers) {
                try {
                  dispose();
                } catch {
                  // 忽略单个清理失败。
                }
              }
              liveDisposers = [];
            };
          }),
        );
        liveDisposers = registerCards();
      };

      bind();
    }

    return { name, inject, apply };
  },
  });
}
