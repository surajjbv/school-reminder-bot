// WhatsApp (via kit/whatsapp.js): the teacher's messages in, the digest and failure alerts out.
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../kit/log.js';
import { openWhatsApp } from '../kit/whatsapp.js';
import { fileText } from './text.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = path.join(import.meta.dirname, '..', 'data');

/** Opens WhatsApp (`login`: link this Mac with a QR) and adds the school bot's lookups. Chat ids are cached in the store. */
export async function schoolWhatsApp({ cfg, env, store, login = false }) {
  const wa = await openWhatsApp({ dir: cfg.data, chromePath: cfg.chromePath, log, login });
  const { client } = wa;
  let contacts;
  // Chat IDs are looked up by saved name once (scanning contacts is slow), then cached.
  async function chatId(key, pred, label) {
    const cached = store?.get(key);
    if (cached) return cached;
    contacts ??= await client.getContacts();
    let found = [...new Map(contacts.filter(pred).map((c) => [c.id._serialized, c])).values()]; // de-duplicate
    if (found.length > 1) found = found.filter((c) => c.id.server !== 'lid');
    if (found.length !== 1) throw new Error(`WhatsApp: expected 1 contact "${label}", found ${found.length}`);
    store?.set(key, found[0].id._serialized);
    return found[0].id._serialized;
  }

  return {
    close: wa.close,
    /** Chat id of the digest's group (checks the name is unique). */
    async groupId() {
      let id = store.get('wa_group');
      if (!id) { id = await wa.findGroup(env.GROUP_NAME); store.set('wa_group', id); }
      return id;
    },

    /** The teacher's messages after `sinceSec`, with image/PDF text added via OCR. */
    async readTeacherMessages(sinceSec) {
      const id = await chatId('wa_teacher', (c) => !c.isGroup && c.name === env.TEACHER_CHAT_NAME, env.TEACHER_CHAT_NAME);
      const chat = await client.getChatById(id);
      await sleep(1500); // let history sync after being offline
      const out = [];
      for (const m of (await chat.fetchMessages({ limit: 200 })).filter((x) => x.timestamp > sinceSec && !x.fromMe)) {
        let text = m.body || '';
        const isPdf = m.type === 'document' && /pdf/i.test(m._data?.mimetype || '');
        if (m.hasMedia && (m.type === 'image' || isPdf)) {
          const file = path.join(DATA, `wa-${m.id.id}.${isPdf ? 'pdf' : 'jpg'}`);
          try {
            fs.writeFileSync(file, Buffer.from((await m.downloadMedia()).data, 'base64'));
            text = `${text}\n[${isPdf ? 'PDF' : 'Image'} text]\n${fileText(file)}`.trim();
          } catch (err) {
            log.warn(`could not read media in WhatsApp message ${m.id.id}: ${err.message}`);
          } finally {
            fs.rmSync(file, { force: true });
          }
        }
        if (text.trim()) out.push({ id: m.id._serialized, ts: m.timestamp, text });
      }
      return out;
    },

    /**
     * Who to @mention. Groups now tag people by privacy ID (@lid), and a mention only shows
     * as "@Name" when the text and the tag both use that ID. Cached after the first lookup.
     */
    async mention() {
      let lid = store.get('wa_mention_lid');
      if (!lid) {
        const suffix = env.MENTION_NUMBER_ENDS_WITH;
        const phoneId = await chatId('wa_mention_phone',
          (c) => !c.isGroup && c.isMyContact && c.name === env.MENTION_NAME && (!suffix || c.id.user.endsWith(suffix)), env.MENTION_NAME);
        lid = (await client.getContactLidAndPhone([phoneId]))[0]?.lid || phoneId;
        store.set('wa_mention_lid', lid);
      }
      return { id: lid, token: '@' + lid.split('@')[0] };
    },

    async sendToGroup(text, mentionId) {
      const id = await this.groupId();
      await sleep(1000 + Math.random() * 2000); // small human-like pause
      await wa.send(id, text, { mentions: [mentionId], linkPreview: undefined }); // WhatsApp's default preview, as before
    },

    sendToSelf: (text) => wa.send(client.info.wid._serialized, text, { linkPreview: undefined }),
  };
}
