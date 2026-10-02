// The three conversation shapes the demo depends on, exercised against the risk
// machine directly. No network, no model — these pin the trajectory, not the
// wording. `npm run scenario` covers the same three shapes end to end on Bedrock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRiskState, applySignals, MODES } from '../src/risk.js';
import { SIGNAL_IDS } from '../src/signals.js';

// Replays a conversation as a list of per-turn signal reports and returns the
// mode after each turn.
function replay(turns) {
  let state = createRiskState();
  const modes = [];
  for (const ids of turns) {
    state = applySignals(state, ids.map((id) => ({ id, evidence: 'quoted words' }))).state;
    modes.push(state.mode);
  }
  return { state, modes };
}

const neverSkipsAStep = (modes) => {
  let previous = 'normal';
  for (const mode of modes) {
    assert.ok(
      MODES.indexOf(mode) - MODES.indexOf(previous) <= 1,
      `jumped ${previous} → ${mode} in one turn`,
    );
    previous = mode;
  }
};

test('benign conversation: stays normal throughout', () => {
  const { state, modes } = replay([[], [], [], [], [], []]);
  assert.deepEqual(new Set(modes), new Set(['normal']));
  assert.equal(state.score, 0);
  assert.equal(state.protectiveTurn, null);
  assert.equal(state.signals.length, 0);
});

test('ambiguous conversation: reaches curious and stops there', () => {
  // A stranger made contact and the user is relying on their details — enough to
  // ask about, never enough to warn about.
  const { state, modes } = replay([
    [],
    ['unsolicited_contact'],                        // identity  +2 = 2
    ['impersonation_authority'],                    // identity  already counted
    ['verification_bypass'],                        // verification +2 = 4
    [],
    [],
  ]);
  assert.equal(state.mode, 'curious');
  assert.equal(state.score, 4);
  assert.equal(state.protectiveTurn, null);
  assert.ok(!modes.includes('protective'), 'must never reach protective');
  assert.ok(modes.includes('curious'));
  neverSkipsAStep(modes);
});

test('scam conversation: climbs to protective one step at a time', () => {
  const { state, modes } = replay([
    [],
    ['unsolicited_contact', 'impersonation_authority'],   // identity +2 = 2
    ['remote_access'],                                    // access   +3 = 5
    ['urgency_pressure'],                                 // pressure +2 = 7
    ['secrecy_isolation'],                                // secrecy  +3 = 10
  ]);
  assert.equal(state.mode, 'protective');
  assert.equal(state.score, 10);
  assert.ok(state.protectiveTurn > 0);
  assert.deepEqual(modes, ['normal', 'normal', 'curious', 'protective', 'protective']);
  neverSkipsAStep(modes);
});

test('a scam conversation is never labelled protective on its first signal', () => {
  for (const id of SIGNAL_IDS) {
    const { modes } = replay([[id]]);
    assert.notEqual(modes[0], 'protective', `${id} triggered protective immediately`);
  }
});

test('every scenario file is well formed', () => {
  const dir = new URL('../scenarios/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 3, 'expected at least the demo scenarios');

  for (const file of files) {
    const s = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
    const where = path.basename(file);
    assert.equal(s.name, path.basename(file, '.json'), `${where}: name must match filename`);
    assert.ok(s.description?.length > 20, `${where}: needs a description`);
    assert.ok(Array.isArray(s.turns) && s.turns.length >= 3, `${where}: needs turns`);
    assert.ok(s.turns.every((t) => typeof t === 'string' && t.trim()), `${where}: bad turn`);
    assert.ok(s.expect && Object.keys(s.expect).length, `${where}: needs expectations`);
    if (s.expect.finalMode) assert.ok(MODES.includes(s.expect.finalMode), `${where}: bad finalMode`);
    if (s.expect.maxMode) assert.ok(MODES.includes(s.expect.maxMode), `${where}: bad maxMode`);
  }
});

test('the demo covers all three shapes end to end', () => {
  const dir = new URL('../scenarios/', import.meta.url);
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));

  assert.ok(
    all.some((s) => s.expect.maxMode === 'normal'),
    'no scenario pins a conversation that must stay normal',
  );
  assert.ok(
    all.some((s) => s.expect.maxMode === 'curious'),
    'no scenario pins a conversation that must reach curious but not protective',
  );
  assert.ok(
    all.some((s) => s.expect.finalMode === 'protective'),
    'no scenario pins a conversation that must reach protective',
  );
});
