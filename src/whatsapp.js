import fs from 'node:fs';
import path from 'node:path';
import wweb from 'whatsapp-web.js';
import { config, DATA } from './config.js';
import { kvGet, kvSet } from './db.js';
import { fileText } from './extract.js';
import { log } from './log.js';

const { Client, LocalAuth } = wweb;
const MEDIA = path.join(DATA, 'wa-media');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = () => sleep(2000 + Math.random() * 4000);

export class WhatsAppLoggedOut extends Error {}

/** Start WhatsApp Web. With onQr (login script) shows the QR; otherwise a QR means the link was lost. */
export function openWhatsApp({ onQr } = {}) {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA, 'wa-auth') }),
    puppeteer: { headless: true, executablePath: config.chromePath, args: ['--no-first-run'] },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WhatsApp did not become ready in 3 min')), 180000);
    client.on('qr', (qr) => {
      if (onQr) return onQr(qr);
      clearTimeout(timer);
      client.destroy().finally(() => reject(new WhatsAppLoggedOut('WhatsApp is unlinked: run `npm run login:whatsapp`')));
    });
    client.on('auth_failure', (m) => { clearTimeout(timer); reject(new WhatsAppLoggedOut(`WhatsApp auth failed: ${m}`)); });
    client.on('ready', () => { clearTimeout(timer); resolve(wrap(client)); });
    client.initialize().catch(reject);
  });
}

function wrap(client) {
  const findChat = async (pred, label) => {
    const chat = (await client.getChats()).find(pred);
    if (!chat) throw new Error(`WhatsApp chat not found: ${label}`);
    return chat;
  };

  return {
    close: () => client.destroy(),

    /** The teacher's messages after `sinceSec`, each with text (caption + OCR of images/PDFs). */
    async readTeacherMessages(sinceSec) {
      const chat = await findChat((c) => !c.isGroup && c.name === config.teacherChat, config.teacherChat);
      await sleep(3000); // let history sync after being offline
      const msgs = (await chat.fetchMessages({ limit: 200 })).filter((m) => m.timestamp > sinceSec && !m.fromMe);
      fs.mkdirSync(MEDIA, { recursive: true });
      const out = [];
      for (const m of msgs) {
        let text = m.body || '';
        const isDoc = m.type === 'document' && /pdf/i.test(m._data?.mimetype || '');
        if (m.hasMedia && (m.type === 'image' || isDoc)) {
          try {
            const media = await m.downloadMedia();
            const file = path.join(MEDIA, `${m.id.id}.${m.type === 'image' ? 'jpg' : 'pdf'}`);
            fs.writeFileSync(file, Buffer.from(media.data, 'base64'));
            text = `${text}\n[${m.type === 'image' ? 'Image' : 'PDF'} text]\n${fileText(file)}`.trim();
            fs.rmSync(file);
          } catch (e) {
            log.warn(`could not read media in WhatsApp message ${m.id.id}: ${e.message}`);
          }
        }
        if (text.trim()) out.push({ id: m.id._serialized, ts: m.timestamp, text });
      }
      fs.rmSync(MEDIA, { recursive: true, force: true });
      return out;
    },

    /** Find the person to @mention by saved contact name; cached after the first lookup. */
    async mentionId(db) {
      let id = kvGet(db, 'mention_id');
      if (id) return id;
      const group = await findChat((c) => c.isGroup && c.name === config.groupName, config.groupName);
      for (const p of group.participants) {
        const c = await client.getContactById(p.id._serialized);
        if (c.name === config.mentionName || c.pushname === config.mentionName) { id = c.id._serialized; break; }
      }
      if (!id) throw new Error(`No member named "${config.mentionName}" in group "${config.groupName}"`);
      kvSet(db, 'mention_id', id);
      return id;
    },

    async sendToGroup(text, mentionId) {
      const group = await findChat((c) => c.isGroup && c.name === config.groupName, config.groupName);
      await humanDelay();
      await group.sendStateTyping();
      await humanDelay();
      await group.sendMessage(text, { mentions: [mentionId] });
    },

    async sendToSelf(text) {
      await humanDelay();
      await client.sendMessage(client.info.wid._serialized, text);
    },
  };
}

// '@919876543210' renders as '@<contact name>' in WhatsApp when passed with `mentions`.
export const mentionToken = (id) => '@' + id.split('@')[0];
