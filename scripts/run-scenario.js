#!/usr/bin/env node
// Replay a canned conversation and print the mode/score trace, then check the
// scenario's expectations. Exits non-zero if a scenario fails.
//
//   npm run scenario                 # all scenarios
//   npm run scenario tech-support    # one

import fs from 'node:fs';
import path from 'node:path';
import { createSession, takeTurn } from '../src/session.js';
import { config } from '../src/config.js';
import { MODES } from '../src/risk.js';

const dir = new URL('../scenarios/', import.meta.url);
const wanted = process.argv.slice(2);
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .filter((f) => !wanted.length || wanted.includes(path.basename(f, '.json')));

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  mode: (m) =>
    ({ normal: `\x1b[32m${m}\x1b[0m`, curious: `\x1b[33m${m}\x1b[0m`, protective: `\x1b[31m${m}\x1b[0m`, practice: `\x1b[35m${m}\x1b[0m` })[m] ?? m,
};

let failures = 0;

let first = true;
for (const file of files) {
  if (!first) await new Promise((r) => setTimeout(r, 2000));   // let the token bucket refill
  first = false;
  const scenario = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  console.log(`\n${C.bold(`── ${scenario.name} ──`)}`);
  console.log(C.dim(scenario.description) + '\n');

  const session = createSession();
  let crashed = null;
  for (const utterance of scenario.turns) {
    let t;
    try {
      t = await takeTurn(session, utterance);
      await new Promise((r) => setTimeout(r, 900));   // keep clear of Bedrock throttling
    } catch (err) {
      crashed = err.message;
      console.log(`${C.dim('[--]')} user      ${utterance}`);
      console.log(`     \x1b[31merror\x1b[0m     ${err.message}\n`);
      break;
    }
    const sig = t.added.length
      ? t.added.map((s) => `+${s.family}(${s.weight})${s.reportedAs && s.reportedAs !== s.family ? C.dim(`←${s.reportedAs}`) : ''}`).join(' ')
      : C.dim('—');
    console.log(`${C.dim(`[${String(t.turn).padStart(2)}]`)} user      ${utterance}`);
    console.log(`     trustcue  ${t.reply}`);
    console.log(
      `     ${C.dim('state')}     ${C.mode(t.mode.padEnd(10))} score ${String(t.score).padStart(2)}  ${sig}` +
        (t.repaired ? C.dim('  [reply rewritten for new mode]') : '') +
        (t.tool ? `  \x1b[36m[tool: ${t.tool.name}${t.tool.arg ? ':' + t.tool.arg : ''}]\x1b[0m` : ''),
    );
    console.log();
  }

  const e = scenario.expect ?? {};
  const final = session.risk.mode;
  const peak = session.trace.reduce(
    (max, t) => (MODES.indexOf(t.mode) > MODES.indexOf(max) ? t.mode : max),
    'normal',
  );
  const problems = [];
  if (crashed) problems.push(`crashed: ${crashed}`);
  if (e.finalMode && final !== e.finalMode) problems.push(`final mode ${final}, expected ${e.finalMode}`);
  if (e.maxMode && MODES.indexOf(peak) > MODES.indexOf(e.maxMode)) problems.push(`reached ${peak}, must stay at ${e.maxMode}`);
  if (e.maxScore !== undefined && session.risk.score > e.maxScore) problems.push(`score ${session.risk.score} > ${e.maxScore}`);
  if (e.protectiveByTurn) {
    const pt = session.risk.protectiveTurn;
    if (pt === null) problems.push('never became protective');
    else if (pt > e.protectiveByTurn) problems.push(`protective at turn ${pt}, expected by ${e.protectiveByTurn}`);
  }

  if (problems.length) {
    failures += 1;
    console.log(`\x1b[31mFAIL\x1b[0m  ${problems.join('; ')}`);
  } else {
    const pt = session.risk.protectiveTurn;
    console.log(`\x1b[32mPASS\x1b[0m  final=${final} score=${session.risk.score}` + (pt ? ` protective@turn${pt}` : ''));
  }
}

if (config.mock) console.log(C.dim('\n(mock agent — TRUSTCUE_MOCK=1, replies are canned)'));
process.exit(failures ? 1 : 0);
