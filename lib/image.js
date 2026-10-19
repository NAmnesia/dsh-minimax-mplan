/**
 * 图片落盘与 DSH attachment 适配。
 *
 * 两条路径，按可用性自动选择：
 *  A. attachments 服务可用 → saveImage() 得到 ImageAttachmentRef，
 *     可构造 ImageBlock 进入会话（模型与用户都能直接看到图片）。
 *  B. attachments 不可用或存储拒绝 → 退回写工作区文件，结果里返回路径。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sniffImageMediaType } from './minimax.js';

/** 扩展名映射，仅用于落盘命名（真实格式由字节嗅探决定）。 */
const EXTENSION = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 文件名净化：去掉路径分隔符与控制字符，折叠连字符，限制长度。 */
export function sanitizeName(name) {
  if (typeof name !== 'string') return undefined;
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 48);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 把一张 base64 图片变成可用的持久化结果。
 * @param {object} options
 * @param {object} [options.attachments] ctx.attachments（可空）
 * @param {string} [options.cwd]         工作目录，用于退回落盘
 * @param {string} options.base64        裸 base64
 * @param {string} [options.name]        展示名（不含扩展名）
 * @returns {Promise<{kind:'attachment', ref:object}|{kind:'file', file:string, mediaType:string, bytes:number}>}
 */
export async function persistImage({ attachments, cwd, base64, name }) {
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  if (data.length === 0) throw new Error('MiniMax 返回了空图片数据');

  const mediaType = sniffImageMediaType(data) ?? 'image/png';
  const base = sanitizeName(name) ?? `minimax-${Date.now()}`;
  const extension = EXTENSION[mediaType] ?? 'png';

  if (attachments !== undefined) {
    try {
      const ref = await attachments.saveImage({
        data,
        mediaType,
        name: `${base}.${extension}`,
      });
      return { kind: 'attachment', ref };
    } catch {
      // 存储拒绝（尺寸/像素/字节超限等）时退回落盘，保证结果不丢失。
    }
  }

  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('图片无法进入会话附件，且没有可用工作目录用于落盘');
  }
  const dir = join(cwd, '.minimax-images');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${base}-${randomUUID().slice(0, 8)}.${extension}`);
  await writeFile(file, data);
  return { kind: 'file', file, mediaType, bytes: data.length };
}

/**
 * 把持久化结果转成 ContentBlock 数组。
 * 附件型返回真正的 image 块；落盘型只能返回文本说明（含绝对路径）。
 */
export function toImageBlocks(persisted, { caption, index, total }) {
  const blocks = [];
  if (caption) blocks.push({ type: 'text', text: caption });
  if (persisted.kind === 'attachment') {
    blocks.push({ type: 'image', attachment: persisted.ref });
  } else {
    const suffix =
      total === undefined || total <= 1 ? '' : `（第 ${index + 1}/${total} 张）`;
    blocks.push({
      type: 'text',
      text: `图片已保存到：${persisted.file}${suffix}（${persisted.mediaType}，${persisted.bytes} 字节）`,
    });
  }
  return blocks;
}
