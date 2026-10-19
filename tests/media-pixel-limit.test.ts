/**
 * 图片解压炸弹（像素闸）回归用例。
 *
 * 依据（2026-10-18 外部审计 PR-02）：只限压缩后字节数（10 MiB）不限解码后
 * 像素数 —— 小体积、超高宽高的 PNG 可让解码器吃满内存。修复：metadata 后
 * 显式比较 width*height，解码调用同时带 limitInputPixels。
 *
 * 构造：先用 sharp 生成一张 1×1 的合法 PNG，再把 IHDR 里的宽高改成
 * 30000×30000 并重算 IHDR CRC —— 体积仍只有几十字节，但声明的像素数
 * 9 亿 > 上限 4000 万。
 */

import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { probeImage, MEDIA_LIMITS } from '../src/server/modules/media/service';

/** 在 PNG 字节流里定位 IHDR 块（签名 8 字节之后第一个块）。 */
function patchPngSize(bytes: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(bytes);
  // PNG 签名 8 字节 + 长度(4) + 类型(4) + 数据(13) + CRC(4)
  const ihdr = 8 + 4 + 4;
  if (out.subarray(ihdr - 4, ihdr).toString('ascii') !== 'IHDR') {
    throw new Error('构造失败：不是 IHDR');
  }
  out.writeUInt32BE(width, ihdr);
  out.writeUInt32BE(height, ihdr + 4);
  // 重算 IHDR CRC：类型(4) + 数据(13)
  const typeAndData = out.subarray(ihdr - 4, ihdr + 13);
  out.writeUInt32BE(crc32(typeAndData) >>> 0, ihdr + 13);
  return out;
}

describe('图片像素闸（解压炸弹）', () => {
  it('声明的像素数超过上限 → 明确拒绝，而不是拖死解码器', async () => {
    const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const bomb = patchPngSize(tiny, 30000, 30000);

    const result = await probeImage(bomb);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('too_many_pixels');
  });

  it('正常尺寸的图片不受影响', async () => {
    const normal = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const result = await probeImage(normal);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.width).toBe(64);
      expect(result.height).toBe(48);
    }
  });

  it('上限是 4000 万像素（与声明一致）', () => {
    expect(MEDIA_LIMITS.maxPixels).toBe(40_000_000);
  });
});
