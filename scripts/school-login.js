// Opens a normal (not automated) Chrome window on the bot's own profile so you can
// sign in to the kid's school account by hand. Quit it (Cmd+Q) when done.
import { spawn } from 'node:child_process';
import { config, requireConfig } from '../src/config.js';
import { openClassroom, PROFILE } from '../src/classroom.js';

requireConfig('schoolAccount');

const url = `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(config.schoolAccount)}&continue=https://classroom.google.com/`;
console.log(`Sign in as ${config.schoolAccount}, tick "save password" if Chrome offers, then QUIT that Chrome window with Cmd+Q.`);

const chrome = spawn(config.chromePath, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' });
chrome.on('exit', async () => {
  const s = await openClassroom();
  try {
    await s.checkLogin();
    console.log(`OK: ${config.schoolAccount} is signed in. The bot can read Classroom now.`);
  } catch (e) {
    console.error(`Not signed in yet (${e.message}). Run \`npm run login:school\` again.`);
    process.exitCode = 1;
  } finally {
    await s.close();
  }
});
