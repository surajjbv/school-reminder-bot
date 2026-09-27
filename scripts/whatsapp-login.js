// One-time: link the bot as a WhatsApp device (WhatsApp > Settings > Linked devices > Link a device).
import qrcode from 'qrcode-terminal';
import { openWhatsApp } from '../src/whatsapp.js';

console.log('Starting WhatsApp Web (headless)...');
const wa = await openWhatsApp({ onQr: (qr) => { console.log('\nScan with WhatsApp > Linked devices > Link a device:\n'); qrcode.generate(qr, { small: true }); } });
console.log('Linked. The session is saved; you should not need to scan again.');
await wa.close();
process.exit(0);
