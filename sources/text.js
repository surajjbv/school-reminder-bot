// Text out of school material: OCR (macOS Vision) for images and PDFs, recent tabs of Sheets, HTML, Drive links.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const ROOT = path.join(import.meta.dirname, '..');
const OCR_BIN = path.join(ROOT, 'data', 'ocr');

/** OCR an image, or text from a PDF (OCR for scanned pages). Builds the macOS helper on first use. */
export function fileText(file) {
  if (!fs.existsSync(OCR_BIN)) execFileSync('swiftc', ['-O', path.join(ROOT, 'ocr.swift'), '-o', OCR_BIN]);
  return execFileSync(OCR_BIN, [file], { encoding: 'utf8', timeout: 120000 }).trim();
}

// Latest date in a tab name, as YYMMDD (0 if none). Handles "15/09/26 - 18/09/26" and the compact
// day-month-year runs schools use: "210926" = 21/09/26, "7926" = 7/9/26, "10826" = 10/8/26.
function tabDate(name) {
  const dates = [];
  const add = (d, m, y) => { if (d >= 1 && d <= 31 && m >= 1 && m <= 12) dates.push((y % 100) * 1e4 + m * 100 + d); };
  for (const [, d, m, y] of name.matchAll(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g)) add(+d, +m, +y);
  if (!dates.length) {
    for (const run of name.match(/\d{4,6}/g) || []) {
      const y = +run.slice(-2);
      const dm = run.slice(0, -2);
      const [d2, m2] = [+dm.slice(0, 2), +dm.slice(2)]; // prefer a 2-digit day ("10826" = 10 Aug, not 1 Aug)
      if (dm.length >= 3 && d2 <= 31 && m2 >= 1 && m2 <= 12) add(d2, m2, y); else add(+dm.slice(0, 1), +dm.slice(1), y);
    }
  }
  return dates.length ? Math.max(...dates) : 0;
}

/** The 3 most recent tabs of a workbook as CSV (newest dates in tab names; if none are dated, the first 3), skipping empty rows. */
export function sheetText(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const dated = wb.SheetNames.filter(tabDate).sort((a, b) => tabDate(b) - tabDate(a));
  const tabs = dated.length ? dated : wb.SheetNames;
  return tabs.slice(0, 3).map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: 'yyyy-mm-dd' });
    return `## Tab: ${name}\n${csv.split('\n').filter((l) => l.replace(/,/g, '').trim()).join('\n')}`;
  }).join('\n\n');
}

export const htmlToText = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** Google Docs/Sheets/Drive file links found in text. */
export function driveLinks(text) {
  const out = new Map();
  const re = /https:\/\/(?:docs|drive)\.google\.com\/(?:(document|spreadsheets|presentation)\/d\/|file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/g;
  for (const m of text.matchAll(re)) {
    if (!out.has(m[2])) out.set(m[2], { id: m[2], kind: { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' }[m[1]] || 'file' });
  }
  return [...out.values()];
}
