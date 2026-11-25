import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipInput {
  name: string;
  data: Buffer | string;
  date?: Date;
}

/** 生成一个 zip（deflate 压缩），只用 Node 自带的 zlib。用于导出诊断包，文件不大。 */
export function createZip(entries: readonly ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw) >>> 0;
    const { time, day } = dosDateTime(entry.date ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * 读出 zip 里每个文件的名字与内容，并校验 CRC。
 * 只支持本文件写出的格式（deflate、无 zip64），够测试和诊断包回读用。
 */
export function readZip(data: Buffer): Map<string, string> {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("不是有效的 zip：找不到中央目录结尾");
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(`zip 中央目录第 ${index} 项损坏`);
    const expectedCrc = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = data.readUInt16LE(local + 26);
    const body = data.subarray(local + 30 + localNameLength, local + 30 + localNameLength + compressedSize);
    const content = inflateRawSync(body);
    if ((crc32(content) >>> 0) !== expectedCrc) throw new Error(`zip 条目 ${name} 的 CRC 对不上`);
    files.set(name, content.toString("utf8"));
    offset += 46 + nameLength;
  }
  return files;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}
