// Reads Classroom posts and linked Drive files as the kid's school account, using a
// Chrome profile signed in by hand (`npm run login:school`). Headless, read-only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { config, DATA } from './config.js';
import { driveLinks, fileText, htmlToText, sheetText } from './extract.js';
import { log } from './log.js';

export const PROFILE = path.join(DATA, 'school-chrome');
const DL = path.join(DATA, 'downloads');
const MAX_CHARS = 20000;

export class LoginExpired extends Error {}

const exportUrl = ({ id, kind }) => ({
  doc: `https://docs.google.com/document/d/${id}/export?format=html`,
  sheet: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
  slides: `https://docs.google.com/presentation/d/${id}/export?format=pdf`,
  file: `https://drive.google.com/uc?export=download&id=${id}`,
}[kind]);

export async function openClassroom() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: config.chromePath,
    userDataDir: PROFILE,
    // Real Keychain, so cookies saved by the normal Chrome login window are readable.
    ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
  });
  const page = await browser.newPage();
  fs.rmSync(DL, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  const s = {
    close: () => browser.close(),

    async checkLogin() {
      await page.goto('https://classroom.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!page.url().startsWith('https://classroom.google.com')) throw new LoginExpired('school account login expired');
    },

    /** Drive/Docs links attached to a Classroom post. */
    async postLinks(url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      if (page.url().includes('accounts.google.com')) throw new LoginExpired('school account login expired');
      const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
      return driveLinks(hrefs.join('\n'));
    },

    /** Download one Drive item and return its text (plus links it contains, for Docs). */
    async fileText(link) {
      const before = new Set(fs.readdirSync(DL));
      try {
        await page.goto(exportUrl(link), { timeout: 60000 });
      } catch { /* downloads abort navigation; that's expected */ }
      if (page.url().includes('accounts.google.com')) throw new LoginExpired('school account login expired');

      const file = await waitForDownload(before);
      if (!file) { log.warn(`no download for ${link.kind} ${link.id} (no access or unsupported)`); return null; }
      const buf = fs.readFileSync(file);
      let text = '';
      let links = [];
      if (link.kind === 'sheet') text = sheetText(buf);
      else if (link.kind === 'doc') {
        const html = buf.toString('utf8');
        text = htmlToText(html);
        links = driveLinks(decodeURIComponent(html));
      } else if (/\.(pdf|png|jpe?g|heic|gif|webp)$/i.test(file)) text = fileText(file);
      else if (/\.xlsx$/i.test(file)) text = sheetText(buf);
      else { log.warn(`skipping unsupported file ${path.basename(file)}`); return null; }
      fs.rmSync(file);
      text = text.slice(0, MAX_CHARS);
      return { text, links, hash: crypto.createHash('sha1').update(text).digest('hex') };
    },
  };
  return s;
}

async function waitForDownload(before, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const done = fs.readdirSync(DL).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (done.length) return path.join(DL, done[0]);
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
