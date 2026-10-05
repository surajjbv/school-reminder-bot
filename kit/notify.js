// macOS notification; best effort (no GUI session, e.g. over SSH, is fine). Synchronous, so it works just before exit.
import { execFileSync } from 'node:child_process';

export function notify(title, message) {
  const clip = (s, n) => String(s).replace(/\s+/g, ' ').slice(0, n);
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(clip(message, 200))} with title ${JSON.stringify(clip(title, 80))}`], { stdio: 'ignore', timeout: 5000 }); } catch { /* no GUI */ }
}
