// TSP image nodes take PNG blobs but have no atlas/crop props. Hermes already decodes a pet's
// spritesheet on the gateway host (`pet.cells`, unicode mode). At the requested pixel width these
// are RGBA pixels, two high per cell; encode them as PNG once, then upload each blob once. No
// local Hermes files, image library, file writes, ANSI graphics or work on an animation tick.

import { deflateSync } from 'node:zlib'

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function chunk(name: string, data: Uint8Array): Buffer {
  const type = Buffer.from(name, 'ascii')
  let crc = 0xffffffff
  for (const byte of type) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8)
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8)
  const out = Buffer.allocUnsafe(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  type.copy(out, 4)
  out.set(data, 8)
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return out
}

export interface PetFrame {
  png: Uint8Array
  width: number
  height: number
}

/** Frame → row → cell [top R,G,B,A, bottom R,G,B,A]. Refuses ragged/invalid grids. */
export function cellFramePng(grid: readonly (readonly (readonly number[])[])[]): PetFrame {
  const width = grid[0]?.length ?? 0
  const height = grid.length * 2
  if (!width || !height || width > 1024 || height > 2048) throw new Error('Pet frame has no pixels or is too large.')
  const stride = width * 4 + 1
  const rows = Buffer.alloc(stride * height)
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    if (!row || row.length !== width) throw new Error('Pet frame has a ragged row.')
    for (let x = 0; x < width; x++) {
      const cell = row[x]
      if (!cell || cell.length !== 8 || cell.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new Error('Pet frame has an invalid RGBA cell.')
      rows.set(cell.slice(0, 4), y * 2 * stride + 1 + x * 4)
      rows.set(cell.slice(4), (y * 2 + 1) * stride + 1 + x * 4)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 8-bit channels
  header[9] = 6 // RGBA
  return {
    height,
    png: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]),
    width
  }
}
