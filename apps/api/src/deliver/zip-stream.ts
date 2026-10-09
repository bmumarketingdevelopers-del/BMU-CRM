// Minimal streaming ZIP writer (stored entries, data descriptors, ZIP64 not needed for handover packs < 4 GB).
// Streams each file from disk once: header → bytes (CRC computed on the fly) → data descriptor → central directory.
import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';
import type { Writable } from 'node:stream';

type Entry = { name: string; crc: number; size: number; offset: number; time: number; date: number };

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export class ZipStream {
  private offset = 0;
  private entries: Entry[] = [];

  constructor(private readonly out: Writable) {}

  private write(buf: Buffer) {
    this.offset += buf.length;
    return new Promise<void>((resolve, reject) => {
      if (this.out.write(buf)) resolve();
      else {
        this.out.once('drain', resolve);
        this.out.once('error', reject);
      }
    });
  }

  private async begin(name: string) {
    const fname = Buffer.from(name, 'utf8');
    const { time, date } = dosTime(new Date());
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    h.writeUInt16LE(0, 8); // stored
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    // crc, sizes = 0 (in the data descriptor)
    h.writeUInt16LE(fname.length, 26);
    const entry: Entry = { name, crc: 0, size: 0, offset: this.offset, time, date };
    await this.write(Buffer.concat([h, fname]));
    return entry;
  }

  private async end(entry: Entry) {
    const d = Buffer.alloc(16);
    d.writeUInt32LE(0x08074b50, 0);
    d.writeUInt32LE(entry.crc >>> 0, 4);
    d.writeUInt32LE(entry.size, 8);
    d.writeUInt32LE(entry.size, 12);
    await this.write(d);
    this.entries.push(entry);
  }

  async addBuffer(name: string, data: Buffer) {
    const entry = await this.begin(name);
    entry.crc = crc32(data);
    entry.size = data.length;
    await this.write(data);
    await this.end(entry);
  }

  async addFile(name: string, path: string) {
    const entry = await this.begin(name);
    let crc = 0;
    let size = 0;
    for await (const chunk of createReadStream(path)) {
      const buf = chunk as Buffer;
      crc = crc32(buf, crc);
      size += buf.length;
      await this.write(buf);
    }
    entry.crc = crc;
    entry.size = size;
    await this.end(entry);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const fname = Buffer.from(e.name, 'utf8');
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.size, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(fname.length, 28);
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, fname]));
    }
    const size = this.offset - start;
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0);
    z.writeUInt16LE(this.entries.length, 8);
    z.writeUInt16LE(this.entries.length, 10);
    z.writeUInt32LE(size, 12);
    z.writeUInt32LE(start, 16);
    await this.write(z);
    await new Promise<void>((resolve) => this.out.end(resolve));
  }
}
