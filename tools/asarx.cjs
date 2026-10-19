// 从 Electron asar 中按需提取文件（只读源，写到目标目录）。
// 用法：node asarx.cjs <asarPath> <outDir> [pathFragment]
//
// asar 头部布局：
//   [0..3]   u32 = 4                （第一个 pickle 的载荷长度，固定）
//   [4..7]   u32 = headerSize+4      （第一个 pickle 的总长度）
//   [8..11]  u32 = jsonLength+4      （第二个 pickle 的载荷长度）
//   [12..15] u32 = jsonLength
//   [16..]   JSON 头部本体
// 文件数据区从 16 + jsonLength 开始。
const fs = require('node:fs');
const path = require('node:path');

const SRC = process.argv[2];
const OUT = process.argv[3];
const WANTED = process.argv[4];

const buf = fs.readFileSync(SRC);
const u32 = (offset) => buf.readUInt32LE(offset);

const jsonLength = u32(12);
const jsonStart = 16;
const json = JSON.parse(buf.subarray(jsonStart, jsonStart + jsonLength).toString('utf8'));
const dataStart = jsonStart + jsonLength;

let emitted = 0;
function walk(node, rel) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const next = rel === '' ? name : `${rel}/${name}`;
    if (entry.files) {
      walk(entry, next);
    } else if (WANTED === undefined || next.includes(WANTED)) {
      if (entry.unpacked) {
        console.log(`UNPACKED ${next}`);
        continue;
      }
      const start = dataStart + Number(entry.offset);
      const data = buf.subarray(start, start + entry.size);
      const dest = path.join(OUT, next);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
      emitted += 1;
      console.log(`OK ${next} (${entry.size})`);
    }
  }
}
fs.mkdirSync(OUT, { recursive: true });
walk(json, '');
console.log(`emitted ${emitted}`);
