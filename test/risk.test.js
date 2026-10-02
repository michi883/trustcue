import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRiskState, applySignals, THRESHOLDS } from '../src/risk.js';
import { SIGNALS, FAMILIES, SIGNAL_IDS } from '../src/signals.js';

const feed = (state, ...ids) => applySignals(state, ids.map((id) => ({ id })));

test('a fresh session is normal and empty', () => {
  const s = createRiskState();
  assert.equal(s.mode, 'normal');
  assert.equal(s.score, 0);
  assert.equal(s.protectiveTurn, null);
});

test('turns with no signals never leave normal', () => {
  let s = createRiskState();
  for (let i = 0; i < 5; i++) s = feed(s).state;
  assert.equal(s.mode, 'normal');
  assert.equal(s.score, 0);
  assert.equal(s.turn, 5);
});

test('a repeated signal only scores once', () => {
  let s = createRiskState();
  s = feed(s, 'remote_access').state;
  const first = s.score;
  s = feed(s, 'remote_access').state;
  assert.equal(s.score, first);
  assert.equal(s.signals.length, 1);
});

test('unknown signal ids are ignored', () => {
  const { state } = feed(createRiskState(), 'not_a_real_signal');
  assert.equal(state.score, 0);
  assert.equal(state.signals.length, 0);
});

test('score accumulates across turns into curious then protective', () => {
  let s = createRiskState();
  s = feed(s, 'impersonation_authority').state;   // identity, 2
  assert.equal(s.mode, 'normal');
  s = feed(s, 'unusual_payment').state;           // money, 3 -> 5
  assert.equal(s.mode, 'curious');
  s = feed(s, 'credential_request').state;        // access, 3 -> 8
  assert.equal(s.mode, 'protective');
  assert.equal(s.protectiveTurn, 3);
});

test('the mode advances at most one step per turn', () => {
  const { state, pendingMode } = feed(createRiskState(), 'remote_access', 'unusual_payment', 'secrecy_isolation');
  assert.ok(state.score >= THRESHOLDS.protective);
  assert.equal(state.mode, 'curious', 'must pass through curious first');
  assert.equal(pendingMode, 'protective', 'and report where it is heading');

  const next = applySignals(state, []).state;
  assert.equal(next.mode, 'protective');
  assert.equal(next.protectiveTurn, 2);
});

test('the mode never steps back down', () => {
  let s = createRiskState();
  s = feed(s, 'remote_access', 'unusual_payment').state;
  s = feed(s).state;
  assert.equal(s.mode, 'protective');
  for (let i = 0; i < 3; i++) s = feed(s).state;
  assert.equal(s.mode, 'protective');
});

test('protectiveTurn records the first protective turn only', () => {
  let s = createRiskState();
  s = feed(s, 'remote_access', 'unusual_payment').state;   // access + money = 6
  s = feed(s).state;
  const at = s.protectiveTurn;
  assert.equal(at, 2);
  s = feed(s, 'secrecy_isolation').state;
  assert.equal(s.protectiveTurn, at);
});

test('applySignals does not mutate the state it is given', () => {
  const s = createRiskState();
  feed(s, 'remote_access');
  assert.equal(s.score, 0);
  assert.equal(s.turn, 0);
  assert.equal(s.signals.length, 0);
});

test('no single family can reach protective on its own', () => {
  for (const id of SIGNAL_IDS) {
    const { state } = feed(createRiskState(), id);
    assert.notEqual(state.mode, 'protective', `${id} alone must not trigger protective`);
  }
});

// ---- the normalisation layer ----

test('every signal maps to a real family', () => {
  for (const [id, s] of Object.entries(SIGNALS)) {
    assert.ok(FAMILIES[s.family], `${id} maps to unknown family ${s.family}`);
    assert.ok(s.hint.length > 20, `${id} needs a usable hint for the tool schema`);
  }
});

test('every family carries a weight of 2 or 3 and a label', () => {
  for (const [id, f] of Object.entries(FAMILIES)) {
    assert.ok(f.weight === 2 || f.weight === 3, `${id} weight out of range`);
    assert.ok(f.label && f.blurb, `${id} needs a label and a blurb for the judge view`);
  }
});

test('every family is reachable from at least one signal', () => {
  const reachable = new Set(Object.values(SIGNALS).map((s) => s.family));
  for (const id of Object.keys(FAMILIES)) {
    assert.ok(reachable.has(id), `nothing maps to family ${id}`);
  }
});

test('two labels from one family on one turn score once', () => {
  // Nova routinely reports both of these for a single sentence.
  const { state, added } = feed(createRiskState(), 'unsolicited_contact', 'impersonation_authority');
  assert.equal(added.length, 1);
  assert.equal(state.score, FAMILIES.identity.weight);
});

test('either label from a family produces the same score', () => {
  const viaOne = feed(createRiskState(), 'remote_access').state;
  const viaOther = feed(createRiskState(), 'credential_request').state;
  assert.equal(viaOne.score, viaOther.score);
  assert.equal(viaOne.signals[0].family, viaOther.signals[0].family);
});

test('a family already counted does not score again under its other label', () => {
  let s = feed(createRiskState(), 'urgency_pressure').state;
  const after = feed(s, 'emotional_manipulation').state;
  assert.equal(after.score, s.score);
  assert.equal(after.signals.length, 1);
});

test('entries record the raw label the model reported', () => {
  const { state } = feed(createRiskState(), 'credential_request');
  assert.equal(state.signals[0].family, 'access');
  assert.equal(state.signals[0].reportedAs, 'credential_request');
});
