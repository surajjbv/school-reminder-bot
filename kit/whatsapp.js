// WhatsApp Web (whatsapp-web.js) in headless Chrome. One linked login can be shared by several bots on this
// Mac (`dir` holds wa-auth/); only one Chrome may use it at a time, so opening takes <dir>/wa.lock and waits.
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import wweb from 'whatsapp-web.js';

export class WhatsAppLoggedOut extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lock(dir, log) {
  const lockDir = path.join(dir, 'wa.lock');
  const chromeBusy = () => { // Chrome's own profile lock: a 'host-pid' symlink while that Chrome runs
    try { process.kill(Number(fs.readlinkSync(path.join(dir, 'wa-auth/session/SingletonLock')).split('-').pop()), 0); return true; } catch { return false; }
  };
  for (const end = Date.now() + 45 * 60000; ; await sleep(20000)) {
    try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 30 * 60000) fs.rmdirSync(lockDir); } catch { /* no lock */ } // left by a crash
    if (!chromeBusy()) try { fs.mkdirSync(lockDir); break; } catch { /* another bot has WhatsApp open */ }
    if (Date.now() > end) throw new Error('WhatsApp stayed busy (another bot) for 45 min');
    log.info('another bot is using WhatsApp, waiting…');
  }
  const unlock = () => fs.rmSync(lockDir, { recursive: true, force: true });
  process.on('exit', unlock);
  return unlock;
}

/** Opens WhatsApp. With `login`, shows the QR to link this Mac; otherwise a QR means it was unlinked. */
export async function openWhatsApp({ dir, chromePath, log, login = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const unlock = await lock(dir, log);
  const client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: path.join(dir, 'wa-auth') }),
    webVersionCache: { type: 'local', path: path.join(dir, 'wa-cache') },
    puppeteer: { headless: true, executablePath: chromePath, args: ['--no-first-run'] },
  });
  const close = async () => { await client.destroy().catch(() => {}); unlock(); };
  try {
    await new Promise((ok, fail) => {
      // The first connection after hours offline syncs history first; that can take minutes.
      const timer = setTimeout(() => fail(new Error('WhatsApp not ready in 10 min (phone offline?)')), 600000);
      const stop = (err) => { clearTimeout(timer); fail(err); };
      let pct = -1;
      client.on('loading_screen', (p) => { if (p - pct >= 25 || p === 100) log.info(`WhatsApp syncing ${p}%`); pct = p; });
      client.on('qr', (qr) => {
        if (!login) return stop(new WhatsAppLoggedOut('WhatsApp is unlinked: run `npm run login`'));
        console.log('\nWhatsApp > Settings > Linked devices > Link a device, then scan:\n');
        qrcode.generate(qr, { small: true });
      });
      client.on('auth_failure', (m) => stop(new WhatsAppLoggedOut(`WhatsApp auth failed: ${m}`)));
      client.on('disconnected', (reason) => log.warn(`WhatsApp disconnected: ${reason}`));
      client.on('ready', () => { clearTimeout(timer); ok(); });
      client.initialize().catch(stop);
    });
  } catch (err) {
    await close();
    throw err;
  }
  return {
    client,
    close,
    /** Chat id of the one group with this name (case-insensitive). */
    async findGroup(name) {
      const want = name.trim().toLowerCase();
      const groups = (await client.getChats()).filter((c) => c.isGroup && c.name?.trim().toLowerCase() === want);
      if (groups.length !== 1) throw new Error(`WhatsApp: expected 1 group named "${name}", found ${groups.length}`);
      return groups[0].id._serialized;
    },
    /** Sends and waits until WhatsApp's server has it (sendMessage only queues it in the browser). */
    async send(to, text, options = {}) {
      const msg = await client.sendMessage(to, text, { linkPreview: false, ...options });
      if (!msg?.id) throw new Error('WhatsApp did not create the message');
      let ack = msg.ack;
      for (const end = Date.now() + 60000; ack < 1 && ack !== -1 && Date.now() < end; await sleep(500)) {
        ack = (await client.getMessageById(msg.id._serialized))?.ack ?? ack;
      }
      if (ack < 1) throw new Error(`WhatsApp message not sent (${ack === -1 ? 'error' : 'still pending after 60 s'})`);
      log.info(`WhatsApp message ${msg.id.id} is on WhatsApp's server`);
      return msg;
    },
  };
}
