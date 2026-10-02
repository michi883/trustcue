// The single conversational agent, on Amazon Bedrock.
//
// One primary Converse call per turn, plus a bounded retry when the output is
// unusable or breaks one of the rules below. Structured output comes from a
// forced tool call:
// Nova must answer through `record_turn`, so every turn returns the spoken reply
// and the scam signals in the same validated shape. The agent is never told the
// score and never chooses the mode.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SIGNAL_IDS, SIGNALS } from './signals.js';
import { TOOLS } from './tools.js';
import { buildSystemPrompt, EXAMPLE_PHRASES } from './prompt.js';
import { config } from './config.js';
import { mockTurn } from './mock-agent.js';

const RECORD_TURN = {
  toolSpec: {
    name: 'record_turn',
    description: [
      "Record what TrustCue says out loud this turn, plus every scam signal the user's most recent message carried.",
      'The signals, and what each one means:',
      ...Object.entries(SIGNALS).map(([id, sig]) => `  ${id} — ${sig.hint}`),
      'Report every signal that applies, and nothing that does not. Most turns carry none.',
    ].join('\n'),
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          reply: {
            type: 'string',
            description: 'What TrustCue says out loud. Spoken language only, no markdown, at most three sentences.',
          },
          signals: {
            type: 'array',
            description: "Scam signals present in the user's most recent message. Usually empty.",
            items: {
              type: 'object',
              properties: {
                // The vocabulary lives here, in the output schema, rather than in the
                // system prompt. Nova reads a prompt full of scam language as a cue to
                // start giving safety advice, which wrecks the normal and curious modes.
                id: { type: 'string', enum: SIGNAL_IDS },
                evidence: {
                  type: 'string',
                  description:
                    "The phrase from the user's most recent message that carries this signal, quoted word for word. Never a paraphrase, and never a quote from an earlier turn — a quote that cannot be found in that message is discarded.",
                },
              },
              required: ['id', 'evidence'],
            },
          },
          tool: { type: 'string', enum: TOOLS, description: 'A tool to run after speaking, or "none".' },
          tool_arg: { type: 'string', description: 'The scam pattern id for explain_scam_pattern, otherwise an empty string.' },
        },
        required: ['reply', 'signals', 'tool', 'tool_arg'],
      },
    },
  },
};

let client;
const getClient = () => (client ??= new BedrockRuntimeClient({ region: config.region }));

const normalise = (t) =>
  t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// The prompt asks for a verbatim quote as evidence. Enforce it here rather than
// trusting it: a signal the model cannot quote the user saying is a signal the
// model invented, and inventions are what push the conversation to protective
// too early. Anything unquotable is dropped before it can score.
function quoted(signal, userMessage) {
  const haystack = normalise(userMessage);
  const needle = normalise(signal?.evidence ?? '');
  // Two words is the floor for a quote to mean anything. There is deliberately
  // no ceiling: rejecting long quotes cost real detections, and quoting too much
  // is a style problem, not a correctness one.
  if (needle.split(' ').filter(Boolean).length < 2) return false;
  return haystack.includes(needle);
}

const toConverse = (history) =>
  history.map((m) => ({ role: m.role, content: [{ text: m.content }] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const debug = process.env.TRUSTCUE_DEBUG === '1' ? (...a) => console.error('  \x1b[2m·', ...a, '\x1b[0m') : () => {};

// Nova sometimes serialises the tool call as plain text in its own XML syntax
// instead of returning a toolUse block (Bedrock reports stopReason
// "malformed_tool_use"). The payload is intact, and often truncated mid-tag, so
// parse it leniently rather than throwing away a good turn.
function recoverToolUse(content = []) {
  const text = content.map((b) => b.text).filter(Boolean).join('').trim();
  if (!text) return null;

  // Sometimes the fallback is not the XML form at all — just the spoken reply as
  // prose. Losing the signals for one turn is survivable; crashing mid-demo is not.
  if (!text.includes('__function=record_turn')) {
    if (text.includes('<') || text.length > 400) return null;
    return { reply: text, signals: [], tool: 'none', tool_arg: '' };
  }

  const fields = {};
  for (const [, key, value] of text.matchAll(/<__parameter=(\w+)>([\s\S]*?)(?:<\/_*\w*>?|$)/g)) {
    // A truncated or misspelled closing tag can survive the split, sometimes with
    // repeated content after it. Keep only what precedes the first stray bracket.
    fields[key] = value.split('<')[0].trim();
  }
  if (!fields.reply) return null;


  let signals = [];
  try {
    signals = JSON.parse(fields.signals || '[]');
  } catch {
    signals = [];
  }
  return { reply: fields.reply, signals, tool: fields.tool || 'none', tool_arg: fields.tool_arg || '' };
}

const NUDGE_REPEAT =
  'Your previous attempt reused wording from your own earlier reply. Answer what the user just said, in completely different words.';

const NUDGE_PARROT =
  "Your previous attempt repeated the user's own words back at them. Reply with something of your own instead.";

// Alarm language frightens people without helping them, and the model will not
// reliably obey a "never say this" instruction. Treat it as a retry condition.
const ALARM_WORDS = /\b(red flags?|warning|danger(ous)?|alert|urgent(ly)?|immediately)\b/i;
const NUDGE_ALARM =
  'Your previous attempt used alarm language. Say the same thing calmly, without words like "red flag", "warning" or "urgent".';

// In normal and curious mode the assistant is not supposed to be protecting
// anyone yet — that is the whole point of the gradual shift. Left to itself the
// model slides into safety advice the moment a conversation smells like a scam,
// so the contract is enforced here rather than hoped for.
const SAFETY_ADVICE =
  /\b(hang(ing)? up|red flags?|scams?|fraud|the number on (the back of )?your card|official (number|website|support number)|call (them|him|her|the bank|your bank|microsoft|us) (straight |right )?back|just to be safe|to be safe|i'?d recommend|it'?s best to|the safest|don'?t (give|share|install|click|send)|never (give|share|install)|not able to (give|help|advise)|can'?t give advice)\b/i;
const NUDGE_CLONE =
  'Your previous attempt reused a sentence from the examples in your instructions. Those show tone only. Say it again in your own words, about this conversation specifically.';

const NUDGE_QUIET =
  'Your previous attempt gave safety advice. You are not protecting anyone on this turn — drop every word of caution and answer the way an assistant would if it had noticed nothing at all.';

// Nova likes to reuse last turn's sentence with a word or two swapped, which an
// exact-match check misses. Compare word sets instead: heavy overlap means the
// user is about to hear the same thing twice.
function echoesPrevious(reply, previous) {
  if (!reply || !previous) return false;
  const a = new Set(normalise(reply).split(' ').filter(Boolean));
  const b = new Set(normalise(previous).split(' ').filter(Boolean));
  if (a.size < 4 || b.size < 4) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size) > 0.65;
}

const isTransient = (err) =>
  err.$retryable?.throttling ||
  err.name === 'ThrottlingException' ||
  err.name === 'ModelTimeoutException' ||
  (err.$metadata?.httpStatusCode ?? 0) >= 500;

// Throttling gets its own budget. It says nothing about the quality of the turn,
// so it must not eat the attempts reserved for fixing a bad reply.
async function converseWithBackoff(...args) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await converse(...args);
    } catch (err) {
      if (!isTransient(err) || tries >= 6) throw err;
      const backoff = 1000 * 2 ** (tries - 1) + Math.random() * 500;
      debug(`waiting ${Math.round(backoff)}ms after ${err.name}`);
      await sleep(backoff);
    }
  }
}

async function converse(system, messages, extraSystem, temperature) {
  return getClient().send(
    new ConverseCommand({
      modelId: config.modelId,
      // Appended to the end of the system text, not sent as a separate block:
      // this model weights the tail of its instructions most heavily.
      system: [{ text: extraSystem ? `${system}\n\n## Correction\n\n${extraSystem}` : system }],
      messages,
      toolConfig: { tools: [RECORD_TURN], toolChoice: { tool: { name: 'record_turn' } } },
      inferenceConfig: { maxTokens: config.maxTokens, temperature },
    }),
  );
}

// The one place that decides whether a reply is worth another round trip.
// Returns {why, text} or null.
function qualityProblem(reply, lastSpoken, userMessage, state, opts) {
  if (!reply) return { why: 'empty reply', text: NUDGE_PARROT };
  if (opts.practice) return null;

  const flat = normalise(reply);
  if (EXAMPLE_PHRASES.some((phrase) => flat.includes(normalise(phrase))))
    return { why: 'cloned an example phrase', text: NUDGE_CLONE };
  if (flat === normalise(userMessage)) return { why: 'parroted the user', text: NUDGE_PARROT };
  if (echoesPrevious(reply, lastSpoken)) return { why: 'echoed its own previous reply', text: NUDGE_REPEAT };

  if (state.mode === 'protective') {
    if (ALARM_WORDS.test(reply)) return { why: 'alarm language', text: NUDGE_ALARM };
    // Once the concern has been raised, naming it again is the thing to avoid.
    if (!opts.firstProtective && /\bscam(s|mer|mers)?\b/i.test(reply))
      return { why: 'named the scam again', text: NUDGE_ALARM };
    return null;
  }
  return SAFETY_ADVICE.test(reply) ? { why: 'safety advice in a quiet mode', text: NUDGE_QUIET } : null;
}

/**
 * @param {object} state    current risk state (supplies the mode to speak in)
 * @param {Array<{role: string, content: string}>} history  prior turns
 * @param {string} userMessage
 * @param {{practice?: boolean, repair?: boolean, firstProtective?: boolean}} opts
 */
export async function runTurn(state, history, userMessage, opts = {}) {
  if (config.mock) return mockTurn(state, history, userMessage, opts);

  const system = buildSystemPrompt(state, opts);
  const messages = [...toConverse(history), { role: 'user', content: [{ text: userMessage }] }];
  const lastSpoken = [...history].reverse().find((m) => m.role === 'assistant')?.content ?? '';

  // Two kinds of retry. Output that is unusable is retried up to three times;
  // a reply that breaks one of the rules above gets exactly one more go. A
  // second quality retry was tried and reverted: it rarely changed the answer,
  // and the extra call volume ran the account into Bedrock's throttling limit.
  // Transient failures are handled separately, in converseWithBackoff.
  let extraSystem = null;
  let last = null;
  let stopReason = 'unknown';
  let qualityRetries = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await converse(system, messages, extraSystem, config.temperature + 0.3 * qualityRetries);
    } catch (err) {
      const retryable = err.$retryable?.throttling || err.name === 'ThrottlingException' ||
        err.name === 'ModelTimeoutException' || (err.$metadata?.httpStatusCode ?? 0) >= 500;
      if (retryable && attempt < 3) {
        const backoff = 1000 * 2 ** (attempt - 1) + Math.random() * 400;
        debug(`retry after ${Math.round(backoff)}ms: ${err.name}`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`Bedrock call failed (${err.name}): ${err.message}`);
    }

    stopReason = response.stopReason;
    const content = response.output?.message?.content ?? [];
    const structured = content.find((b) => b.toolUse)?.toolUse?.input;
    const out = structured ?? recoverToolUse(content);
    debug(`attempt ${attempt}`, structured ? 'toolUse' : out ? 'recovered from text' : `unusable (${stopReason})`);
    if (!out) {
      extraSystem = null;
      continue;
    }

    last = {
      // Nothing here trusts the model's vocabulary — anything unrecognised is dropped.
      reply: String(out.reply ?? '').trim(),
      signals: (Array.isArray(out.signals) ? out.signals : []).filter((s) => {
        if (!SIGNAL_IDS.includes(s?.id)) {
          debug('dropped unknown signal', JSON.stringify(s));
          return false;
        }
        if (!quoted(s, userMessage)) {
          debug(`dropped ${s.id} — unquotable evidence:`, JSON.stringify(s.evidence));
          return false;
        }
        return true;
      }),
      tool: TOOLS.includes(out.tool) ? out.tool : 'none',
      toolArg: String(out.tool_arg ?? ''),
      usage: response.usage,
    };

    if (qualityRetries === 0) {
      const nudge = qualityProblem(last.reply, lastSpoken, userMessage, state, opts);
      if (nudge) {
        debug(`retry: ${nudge.why}`);
        extraSystem = nudge.text;
        qualityRetries += 1;
        await sleep(250);          // don't stack retries into a burst
        continue;
      }
    }
    return last;
  }

  if (last) return last;              // three tries, still repeating: take it
  throw new Error(`Model returned no usable turn after 3 attempts (stopReason: ${stopReason})`);
}
