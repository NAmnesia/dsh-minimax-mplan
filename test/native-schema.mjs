// 验证插件 Config 是否是「原生 schemastery schema」，以及字段是否进表单。
const plugin = await import('../lib/index.js');

const sym = Symbol.for('schemastery');
const config = plugin.Config;

console.log('=== 原生 schema 判定（dsh-app-boot: isNativeConfigSchema）===');
const hasSymbol = Reflect.get(config, sym) === true;
const hasType = typeof Reflect.get(config, 'type') === 'string';
const hasMeta = Reflect.get(config, 'meta') !== null && typeof Reflect.get(config, 'meta') === 'object';
console.log('Symbol.for(schemastery) === true :', hasSymbol);
console.log('typeof type === "string"       :', hasType);
console.log('meta 是对象                     :', hasMeta);
console.log('=> 设置界面可配置               :', hasSymbol && hasType && hasMeta);

console.log('\n=== 表单字段（dsh-settings: volatileForm）===');
const dict = config.dict ?? {};
const keys = Object.keys(dict);
console.log('字段总数:', keys.length);
const volatileKeys = keys.filter((key) => dict[key]?.meta?.volatile === true);
console.log('volatile 字段数:', volatileKeys.length);
console.log('volatile 字段:', volatileKeys.join(', '));
const secretKeys = keys.filter((key) => dict[key]?.meta?.role === 'secret');
console.log('secret 字段:', secretKeys.join(', ') || '(无)');
const described = keys.filter((key) => typeof dict[key]?.meta?.description === 'string');
console.log('带说明的字段:', described.length, '/', keys.length);

console.log('\n=== 值校验（Cordis: ~standard.validate）===');
const empty = plugin.Config['~standard'].validate({});
console.log('空配置 ->', JSON.stringify(empty.value ?? empty.issues).slice(0, 200));
const withKey = plugin.Config['~standard'].validate({ apiKey: 'sk-cp-abc' });
console.log('带 key -> apiKey =', JSON.stringify(withKey.value?.apiKey));

console.log('\n=== 结论 ===');
const allGood =
  hasSymbol &&
  hasType &&
  hasMeta &&
  volatileKeys.length === keys.length &&
  secretKeys.includes('apiKey');
console.log(allGood ? '全部通过' : '存在问题，需检查');
process.exit(allGood ? 0 : 1);
