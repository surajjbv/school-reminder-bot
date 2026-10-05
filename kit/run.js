// runBot: one run of a bot with config, log, store, a single-instance lock and the standard exit codes:
//   0 ok · 1 failed (macOS notification) · 75 temporary (model busy, low memory, already running): retried quietly.
// The model lease is always released, also on errors, Ctrl-C and kill.
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import * as llm from './llm.js';
import { log, openLog } from './log.js';
import { notify } from './notify.js';
import { openStore } from './store.js';

/** A failure that should just be retried later, without a notification (exit 75). */
export class Temporary extends Error {}

/**
 * name: bot name (lease, notifications) · root: the bot's folder · defaults/env/optionalEnv: see loadConfig ·
 * schema/importJson: see openStore · main({ cfg, env, store, log, dry, args }): the run.
 */
export async function runBot({ name, root, defaults, env, optionalEnv, schema, importJson, main }) {
  const lock = path.join(root, 'data', 'run.lock');
  let store = null;
  let haveLock = false;
  const cleanup = () => {
    store?.close();
    llm.release();
    if (haveLock) fs.rmSync(lock, { force: true });
    haveLock = false;
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.error(`stopped by ${sig}`); process.exit(130); });
  process.on('unhandledRejection', (err) => { log.error(`unhandled: ${err?.stack ?? err}`); process.exit(1); });

  let code = 0;
  try {
    const cfg = loadConfig(root, { defaults, env, optionalEnv });
    openLog(cfg.data);
    if (cfg.unusedEnv.length) log.warn(`.env keys not used by this bot: ${cfg.unusedEnv.join(', ')}`);
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid && pid !== process.pid && isAlive(pid)) throw new Temporary(`another run is in progress (pid ${pid})`);
      fs.writeFileSync(lock, String(process.pid)); // left by a crash
    }
    haveLock = true;
    llm.setup({ bot: name, model: cfg.model, takeoverIdleMinutes: cfg.takeoverIdleMinutes, log });
    store = openStore(cfg.data, { schema, dry: cfg.dry, importJson });
    log.info(`${name} run start${cfg.dry ? ' (dry run: nothing is sent, changed or saved)' : ''}`);
    await main({ cfg, env: cfg.env, store, log, dry: cfg.dry, args: process.argv.slice(2) });
    log.info('run done');
  } catch (err) {
    code = err instanceof Temporary || err instanceof llm.ModelBusy ? 75 : 1;
    if (code === 75) log.warn(`${err.message}: will retry later`);
    else {
      log.error(`FAILED during "${log.currentStep}": ${err instanceof ConfigError ? err.message : err.stack}`);
      notify(`${name} failed`, err.message);
    }
  }
  const u = llm.usage();
  if (u.calls || u.loadMs) log.info(`model: load ${(u.loadMs / 1000).toFixed(1)} s, ${u.calls} call(s) ${(u.ms / 1000).toFixed(1)} s`);
  cleanup();
  process.exit(code);
}

function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
