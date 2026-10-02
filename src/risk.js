// Deterministic risk state machine. The LLM reports signals; this file — and
// only this file — decides the mode. Reported signals are first normalised to
// their risk family, so it does not matter which of two neighbouring labels the
// model reached for. No decay, no hysteresis: each family scores once, the score
// only rises, and the mode advances at most one step per turn so the shift never
// feels abrupt.

import { familyOf, familyWeight } from './signals.js';

export const MODES = ['normal', 'curious', 'protective'];

export const THRESHOLDS = {
  curious: 3,
  protective: 6,
};

export function createRiskState() {
  return {
    score: 0,
    mode: 'normal',
    // [{ family, weight, turn, evidence, reportedAs }] — first sighting of each family
    signals: [],
    turn: 0,
    protectiveTurn: null,   // turn number where protective mode was first entered
    lastAdvancedTurn: null,
  };
}

function modeForScore(score) {
  if (score >= THRESHOLDS.protective) return 'protective';
  if (score >= THRESHOLDS.curious) return 'curious';
  return 'normal';
}

// Advance at most one step: normal -> curious -> protective.
function capAdvance(current, target) {
  const from = MODES.indexOf(current);
  const to = MODES.indexOf(target);
  if (to <= from) return current;            // never step back down
  return MODES[Math.min(to, from + 1)];
}

/**
 * Fold this turn's reported signals into the risk state, by family.
 * @param {object} state    previous state (not mutated)
 * @param {Array<{id: string, evidence?: string}>} reported  raw model labels
 * @returns {{state: object, added: Array, pendingMode: string|null}}
 */
export function applySignals(state, reported = []) {
  const next = {
    ...state,
    turn: state.turn + 1,
    signals: [...state.signals],
  };

  const seen = new Set(next.signals.map((s) => s.family));
  const added = [];

  for (const item of reported) {
    const id = typeof item === 'string' ? item : item?.id;
    const family = familyOf(id);
    // Unknown label, or a family already counted this conversation — either way
    // it adds nothing. Two labels from one family on one turn count once.
    if (!family || seen.has(family)) continue;
    seen.add(family);
    const entry = {
      family,
      weight: familyWeight(family),
      turn: next.turn,
      evidence: (typeof item === 'object' && item.evidence) || '',
      reportedAs: id,
    };
    next.signals.push(entry);
    added.push(entry);
    next.score += entry.weight;
  }

  const target = modeForScore(next.score);
  const capped = capAdvance(state.mode, target);

  if (capped !== state.mode) {
    next.mode = capped;
    next.lastAdvancedTurn = next.turn;
    if (capped === 'protective' && next.protectiveTurn === null) {
      next.protectiveTurn = next.turn;
    }
  }

  return { state: next, added, pendingMode: target !== capped ? target : null };
}
