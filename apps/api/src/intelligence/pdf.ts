// A small dependency-free PDF writer for scheduled reports: A4 pages, Helvetica, headings, paragraphs, tables and
// thin rules. Text is limited to the standard Latin set, so the rupee sign is written as "Rs".

export type PdfBlock =
  | { type: 'title'; text: string }
  | { type: 'subtitle'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'table'; columns: string[]; rows: string[][]; widths?: number[] }
  | { type: 'gap'; size?: number };

const W = 595.28;
const H = 841.89;
const M = 48;

/** Characters outside WinAnsi are replaced so the standard fonts can show them. */
function clean(s: string) {
  return s
    .replace(/₹\s?/g, 'Rs ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E]/g, '');
}
const esc = (s: string) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Rough Helvetica width (average glyph ≈ 0.5 em; good enough for wrapping). */
const widthOf = (s: string, size: number) => clean(s).length * size * 0.5;

function wrap(text: string, size: number, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size) > max && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export function renderPdf(blocks: PdfBlock[], footer = ''): Buffer {
  const pages: string[][] = [[]];
  let y = H - M;
  const ops = () => pages[pages.length - 1];
  const newPage = () => {
    pages.push([]);
    y = H - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + 20) newPage();
  };
  const text = (s: string, x: number, size: number, bold = false, grey = false) => {
    ops().push(`BT ${grey ? '0.42 0.42 0.42 rg' : '0.1 0.1 0.1 rg'} /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET`);
  };
  const rule = (yy: number) => ops().push(`0.85 0.85 0.85 RG 0.5 w ${M} ${yy.toFixed(2)} m ${(W - M).toFixed(2)} ${yy.toFixed(2)} l S`);

  for (const b of blocks) {
    if (b.type === 'gap') {
      y -= b.size ?? 10;
      continue;
    }
    if (b.type === 'title' || b.type === 'subtitle' || b.type === 'heading' || b.type === 'text') {
      const size = b.type === 'title' ? 20 : b.type === 'heading' ? 13 : b.type === 'subtitle' ? 10 : 10;
      const lead = size * 1.4;
      for (const line of wrap(b.text, size, W - 2 * M)) {
        ensure(lead);
        y -= lead;
        text(line, M, size, b.type === 'title' || b.type === 'heading', b.type === 'subtitle');
      }
      if (b.type === 'heading') y -= 2;
      continue;
    }
    // Table
    const n = b.columns.length;
    const widths = b.widths ?? Array(n).fill(1);
    const total = widths.reduce((s, w) => s + w, 0);
    const cols = widths.map((w) => ((W - 2 * M) * w) / total);
    const row = (cells: string[], bold: boolean) => {
      const lines = cells.map((c, i) => wrap(c, 9, cols[i] - 8));
      const h = Math.max(...lines.map((l) => l.length)) * 12 + 6;
      ensure(h);
      const top = y;
      lines.forEach((ls, i) => {
        const x = M + cols.slice(0, i).reduce((s, w) => s + w, 0);
        ls.forEach((l, j) => {
          y = top - 12 - j * 12;
          text(l, x + (i === 0 ? 0 : 4), 9, bold);
        });
      });
      y = top - h;
      rule(y + 2);
    };
    row(b.columns, true);
    for (const r of b.rows) row(r, false);
    y -= 6;
  }

  // Assemble objects: catalog, pages, fonts, then each page + its content stream.
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((p, i) => {
    const foot = `BT 0.55 0.55 0.55 rg /F1 8 Tf ${M} 28 Td (${esc(`${footer}${footer ? '  -  ' : ''}Page ${i + 1} of ${pages.length}`)}) Tj ET`;
    const stream = [...p, foot].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
