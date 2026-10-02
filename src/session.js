// One turn of conversation, start to finish.
//
// The agent writes its reply under the mode the state machine currently holds.
// After the reply comes back, this turn's signals are folded in and the mode is
// recomputed. If the recomputed mode differs from the one the reply was written
// under, the agent rewrites that reply once, under the authoritative mode. So
// the mode is always code's decision, and the spoken words always match it.

import { createRiskState, applySignals } from './risk.js';
import { runTurn } from './agent.js';
import { explainScamPattern, startPracticeSimulation, toolAllowed, userRequestedTool } from './tools.js';

const STOP_PRACTICE = /\b(stop|quit|enough|done|end it|hang up|that'?s enough)\b/i;
const MAX_PRACTICE_TURNS = 6;

export function createSession() {
  return {
    risk: createRiskState(),
    history: [],
    practice: false,
    practiceTurns: 0,
    trace: [],
  };
}

export async function takeTurn(session, userMessage) {
  const modeSpokenUnder = session.practice ? 'practice' : session.risk.mode;
  const practice = session.practice;

  let result = await runTurn(session.risk, session.history, userMessage, { practice });
  let calls = 1;

  // Signals are only collected in real conversation, never during role-play.
  const reported = practice ? [] : result.signals;
  const { state, added, pendingMode } = applySignals(session.risk, reported);
  session.risk = state;

  let repaired = false;
  if (!practice && state.mode !== modeSpokenUnder) {
    // Protective is only ever *entered* here, so this rewrite is the one turn
    // that gets the "first time" wording; later protective turns must not repeat it.
    result = await runTurn(state, session.history, userMessage, {
      repair: true,
      firstProtective: state.mode === 'protective',
    });
    calls = 2;
    repaired = true;
  }

  // Tools are code-run, and only once the conversation is genuinely protective.
  let toolRun = null;
  const historyBefore = session.history;
  if (
    result.tool !== 'none' &&
    !practice &&
    toolAllowed(state.mode) &&
    userRequestedTool(userMessage, historyBefore)
  ) {
    if (result.tool === 'explain_scam_pattern') {
      toolRun = explainScamPattern(result.toolArg);
    } else if (result.tool === 'start_practice_simulation') {
      toolRun = startPracticeSimulation();
      session.practice = true;
      session.practiceTurns = 0;
    }
  }

  if (practice) {
    session.practiceTurns += 1;
    if (STOP_PRACTICE.test(userMessage) || session.practiceTurns >= MAX_PRACTICE_TURNS) {
      session.practice = false;
    }
  }

  const speech = [result.reply, toolRun?.speech].filter(Boolean).join(' ');

  session.history.push(
    { role: 'user', content: userMessage },
    { role: 'assistant', content: speech },
  );

  const entry = {
    turn: state.turn,
    user: userMessage,
    reply: speech,            // everything spoken, agent + tool
    agentReply: result.reply,
    toolSpeech: toolRun?.speech ?? null,
    mode: session.practice ? 'practice' : state.mode,
    modeSpokenUnder,
    score: state.score,
    added: added.map((s) => ({ family: s.family, weight: s.weight, evidence: s.evidence, reportedAs: s.reportedAs })),
    allSignals: state.signals.map((s) => ({ family: s.family, weight: s.weight, turn: s.turn })),
    protectiveTurn: state.protectiveTurn,
    pendingMode,
    repaired,
    calls,
    tool: toolRun ? { name: toolRun.tool, arg: toolRun.arg } : null,
    practice: session.practice,
  };
  session.trace.push(entry);
  return entry;
}
