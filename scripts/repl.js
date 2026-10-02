#!/usr/bin/env node
// Phase 0: talk to TrustCue in the terminal. After every reply it prints the
// mode, score and any new signals — the same numbers the judge view shows.

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createSession, takeTurn } from '../src/session.js';
import { config } from '../src/config.js';

const session = createSession();
const rl = readline.createInterface({ input: stdin, output: stdout });

const colour = { normal: '\x1b[32m', curious: '\x1b[33m', protective: '\x1b[31m', practice: '\x1b[35m' };

console.log('\x1b[1mTrustCue\x1b[0m — text prototype. Ctrl+C to quit, "reset" to start over.');
console.log(`\x1b[2mmodel: ${config.mock ? 'MOCK' : config.modelId}\x1b[0m\n`);

for (;;) {
  const line = (await rl.question('\x1b[36myou  \x1b[0m')).trim();
  if (!line) continue;
  if (line === 'reset') {
    Object.assign(session, createSession());
    console.log('\x1b[2m(session reset)\x1b[0m\n');
    continue;
  }
  try {
    const t = await takeTurn(session, line);
    console.log(`\x1b[1mcue  \x1b[0m${t.reply}`);
    const sig = t.added.length ? t.added.map((s) => `+${s.family}(${s.weight})`).join(' ') : '—';
    console.log(
      `\x1b[2m     ${colour[t.mode]}${t.mode}\x1b[0m\x1b[2m  score ${t.score}  ${sig}` +
        (t.repaired ? '  [rewritten]' : '') +
        (t.tool ? `  [tool: ${t.tool.name}]` : '') +
        '\x1b[0m\n',
    );
  } catch (err) {
    console.error(`\x1b[31merror\x1b[0m ${err.message}\n`);
  }
}
