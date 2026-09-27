import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { ROOT } from './config.js';

const EXTRACT_BIN = path.join(ROOT, 'bin/extract');

/** OCR an image, or pull text from a PDF (OCR for scanned pages). */
export function fileText(file) {
  return execFileSync(EXTRACT_BIN, [file], { encoding: 'utf8', timeout: 120000 }).trim();
}

/** Every tab of a workbook as CSV, skipping empty rows. */
export function sheetText(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: 'yyyy-mm-dd' });
    return `## Tab: ${name}\n${csv.split('\n').filter((l) => l.replace(/,/g, '').trim()).join('\n')}`;
  }).join('\n\n');
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Google Docs/Sheets/Drive file links found in text. */
export function driveLinks(text) {
  const out = new Map();
  const re = /https:\/\/(?:docs|drive)\.google\.com\/(?:(document|spreadsheets|presentation)\/d\/|file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/g;
  for (const m of text.matchAll(re)) {
    const kind = { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' }[m[1]] || 'file';
    if (!out.has(m[2])) out.set(m[2], { id: m[2], kind });
  }
  return [...out.values()];
}
