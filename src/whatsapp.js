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
      // Reject first: destroying the browser makes initialize() fail with a less useful error.
      reject(new WhatsAppLoggedOut('WhatsApp is unlinked: run `npm run login:whatsapp`'));
      client.destroy().catch(() => {});
    });
    client.on('auth_failure', (m) => { clearTimeout(timer); reject(new WhatsAppLoggedOut(`WhatsApp auth failed: ${m}`)); });
    client.on('ready', () => { clearTimeout(timer); resolve(wrap(client)); });
    client.on('disconnected', (reason) => log.warn(`WhatsApp disconnected: ${reason}`));
    client.on('change_state', (state) => log.info(`WhatsApp state: ${state}`));
    client.initialize().catch(reject);
  });
}

function wrap(client) {
  // Look chats up via contacts: client.getChats() breaks on some WhatsApp Web versions.
  let contacts;
  const findContact = async (pred, label) => {
    contacts ??= await client.getContacts();
    // WhatsApp can list the same contact more than once; keep one per ID.
    let matches = [...new Map(contacts.filter(pred).map((c) => [c.id._serialized, c])).values()];
    // The same person can appear under a phone ID (@c.us) and a privacy ID (@lid); prefer the phone ID.
    if (matches.length > 1) matches = matches.filter((c) => c.id.server !== 'lid');
    if (matches.length !== 1) throw new Error(`WhatsApp: expected 1 contact "${label}", found ${matches.length}`);
    return matches[0];
  };
  const groupId = async () =>
    (await findContact((c) => c.isGroup && c.name === config.groupName, config.groupName)).id._serialized;

  return {
    close: () => client.destroy(),

    /** The teacher's messages after `sinceSec`, each with text (caption + OCR of images/PDFs). */
    async readTeacherMessages(sinceSec) {
      const teacher = await findContact((c) => !c.isGroup && c.name === config.teacherChat, config.teacherChat);
      const chat = await client.getChatById(teacher.id._serialized);
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

    /** The person to @mention, by saved contact name; cached after the first lookup. */
    async mentionId(db) {
      let id = kvGet(db, 'mention_id');
      if (id) return id;
      const suffix = config.mentionNumberEndsWith;
      id = (await findContact((c) => !c.isGroup && c.isMyContact && c.name === config.mentionName && (!suffix || c.id.user.endsWith(suffix)),
        config.mentionName)).id._serialized;
      kvSet(db, 'mention_id', id);
      return id;
    },

    async sendToGroup(text, mentionId) {
      const id = await groupId();
      await humanDelay();
      const msg = await client.sendMessage(id, text, { mentions: [mentionId] });
      if (!msg?.id) throw new Error('WhatsApp returned no message id: send may have failed');
      log.info(`WhatsApp accepted message ${msg.id.id}`);
    },

    async sendToSelf(text) {
      await humanDelay();
      await client.sendMessage(client.info.wid._serialized, text);
    },
  };
}

// '@919876543210' renders as '@<contact name>' in WhatsApp when passed with `mentions`.
export const mentionToken = (id) => '@' + id.split('@')[0];
