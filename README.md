# TrustCue

A simulated Alexa+ experience that detects rising scam risk in conversation and
shifts naturally from clarification to protective assistance.

Most of the conversation is completely normal. Signals accumulate across turns,
and the assistant moves `normal → curious → protective` one step at a time.

## What it shows

A voice assistant can protect someone from a scam *in the flow of ordinary
conversation*, without accusations, alarms or interrogation. Three things should
be obvious from a run:

- Most of the conversation is completely normal.
- Risk is inferred from **signals accumulating across turns**, not one keyword.
- The tone shift is **gradual and natural**: `normal → curious → protective`.

A typical conversation: the user chats about weather and reminders, then
mentions something ordinary that carries a weak signal ("someone from my bank's
fraud team called"). More land over the next turns: urgency, secrecy, gift
cards, remote access, a wire or crypto payment, "don't tell anyone". In
**curious** mode the assistant asks natural clarifying questions ("Did you call
them back on the number on your card?"). In **protective** mode it names the
concern gently, gives one concrete safe next step, and offers to help: pause,
verify, call a trusted contact. From there the user can ask for a short
explainer on the scam pattern, or a safe practice call.

## Run it

TrustCue runs on **Amazon Bedrock** with **Amazon Nova 2 Lite**
(`us.amazon.nova-2-lite-v1:0`, `us-east-1`). Credentials come from the AWS SDK's
default chain, so if this works you are ready:

```bash
aws sts get-caller-identity
npm install
```

There is no API key to set. `.env` is optional and only holds overrides.

| Command | What it does |
|---|---|
| `npm run repl` | Phase 0 — talk to TrustCue in the terminal, mode and score printed after every reply |
| `npm run scenario` | Replay all canned conversations and check their expectations (exits non-zero on failure) |
| `npm run scenario tech-support` | Replay one — see the table below |
| `npm test` | Risk machine, normalisation and trajectory tests — offline, no AWS calls |
| `npm run dev` | The web app on http://localhost:4173 |

`TRUSTCUE_MOCK=1` swaps in a keyword **mock agent** so the state machine and UI
are demoable with no AWS access at all. The header says `MOCK` when that is what
you are looking at. `TRUSTCUE_DEBUG=1` prints retries and dropped signals.

## How it works

```
voice in → Web Speech API → one Bedrock Converse call → risk state → optional tool → Amazon Polly out
```

- **One agent** (`src/agent.js`). One *primary* Converse call per turn, with
  `toolChoice` forcing a single `record_turn` tool call — that is how the
  structured output is obtained on Nova. It returns the spoken reply plus any
  scam signals the user's message carried. It is never told the score and never
  chooses the mode. A turn costs a second call only when something needs fixing:
  a bounded retry when the output is unusable or breaks one of the rules below,
  or the rewrite described next when the mode changes mid-turn.
- **Reported labels are normalised before they count** (`src/signals.js`). The
  model reports one of ten narrow signals, because narrow questions extract
  better. Each maps to one of six broad **risk families**, and the family is what
  scores and what the judge view shows. Nova is inconsistent about which
  neighbouring label it picks for the same sentence, and this is what absorbs it.

| Family | Weight | Reported as |
|---|---|---|
| Identity / impersonation | 2 | `unsolicited_contact`, `impersonation_authority` |
| Urgency / pressure | 2 | `urgency_pressure`, `emotional_manipulation`, `too_good_offer` |
| Verification avoidance | 2 | `verification_bypass` |
| Secrecy / isolation | 3 | `secrecy_isolation` |
| Money / unusual payment | 3 | `unusual_payment` |
| Device / account access | 3 | `remote_access`, `credential_request` |

- **Code owns the mode** (`src/risk.js`). Each family scores once, at its own
  weight; the score only rises; curious at 3, protective at 6; and the mode
  advances at most one step per turn. That last rule is what stops the assistant
  lurching into a scam warning.
- **The reply always matches the mode.** A reply is written under the mode held
  at the start of the turn. If this turn's signals move the mode, the agent
  rewrites that one reply under the new mode — a second call on transition turns
  only. The judge view marks these as `reply rewritten`.
- **Two tools**, reachable only in protective mode and only once the user has
  asked (the model offers, code decides): `explain_scam_pattern` and
  `start_practice_simulation`. The agent requests one in its structured output;
  the server runs it. Their words are fixed, so the protective moment never
  depends on the model improvising. Practice mode pauses signal collection and
  breaks character on request. Tools are code-run actions rather than an API
  tool-use loop, which avoids a round trip and keeps the protective wording out
  of the model's hands.
- **Amazon Polly speaks the reply** (`src/speech.js`), long-form engine, `Ruth`
  by default. Polly only ever voices a string the rest of the pipeline has
  already settled — the mode is code's decision, the reply has been through the
  agent's guards and any rewrite, and only then is it spoken. Set
  `TRUSTCUE_VOICE`, or `TRUSTCUE_TTS=off` to use the browser's own voice instead.
  Replies are cached per voice, mode and text, so a repeated demo line is
  synthesised once.
- **The mode is delivered, not just decided.** Each turn is a separate,
  stateless synthesis, so left alone the voice resets to neutral every turn and
  the conversation sounds like unrelated lines read aloud. The mode already
  describes the shape of the conversation, so it sets the delivery: curious is
  marginally quicker, as if paying closer attention; protective drops *below*
  normal pace, gets louder, and takes a beat after its first sentence, so the
  warning lands with weight rather than sounding panicked. A frightened-sounding
  assistant is the one thing a scam victim does not need. The engines accept
  exactly three levers for this — rate, volume and break; `pitch` is
  standard-engine only and `emphasis` is rejected — and they live in one table,
  `DELIVERY` in `src/speech.js`.
  If Polly cannot play, the app says so in a banner and stays silent for that
  turn rather than quietly dropping to the browser voice — a silent swap reads
  as "Polly sounds bad" and hides the real cause. The commonest cause is a
  backgrounded tab: browsers will not decode audio in one, however fast Polly
  answered. The turn itself still completes, so a broken voice never blocks a
  conversation or a replay.
- **Nothing is persisted.** Sessions live in memory and die with the process.

### What the code refuses to trust

Nova is a small, fast model, and prompt instructions alone did not hold. Four
rules are therefore enforced in `src/agent.js` after the reply comes back, each
costing at most one extra call:

| Guard | Why |
|---|---|
| Evidence must be a verbatim quote from the user's latest message | Stops invented signals from pushing the conversation to protective early |
| No safety advice while in normal or curious mode | The model slides into "hang up and call your bank" the moment a chat smells like a scam, which destroys the gradual shift |
| No alarm words in protective mode; no naming the scam twice | "Red flag" frightens without helping, and a repeated warning stops being heard |
| No echoing its own previous reply, the user, or the prompt's examples | The failure this model reaches for whenever it has nothing new to say |

It also recovers turns where Nova serialises the tool call as XML text instead of
a `toolUse` block (`stopReason: malformed_tool_use`) rather than dropping them.

## Scenarios

Each pins an expected trajectory and fails the run if it drifts. `npm run
scenario` calls Bedrock; `npm test` covers the same three shapes against the
state machine alone, so the shapes stay pinned even offline.

| Scenario | Must |
|---|---|
| `control` | stay `normal` the whole way — a completely ordinary evening |
| `ambiguous-call` | reach `curious` and stop there — odd, but it turns out to be nothing |
| `tech-support` | reach `protective` — the fake Microsoft call |
| `bank-safe-account` | reach `protective` — the "move your money somewhere safe" call |
| `tools-and-practice` | reach `protective`, then run both tools and the practice call |

## The judge view

Press `j` or click **Judge view** to see what the user cannot: current mode,
accumulated signals with the evidence that triggered each one, the running
score against both thresholds, the exact turn protective mode fired, and a
per-turn log of shifts, rewrites and tool calls.

### Why Polly and not Nova Sonic

Nova Sonic is speech-to-speech: its input modality is speech, and it generates
its own reply. Pointing TrustCue at it would hand the model the one thing this
demo deliberately keeps in code — the mode, the guards, and the rewrite that
keeps the spoken words matching the mode. Polly is a voice, not a speaker, which
is what this architecture needs. Sonic is the right model for a future
real-time version that gives up the state machine.

### Demo replay

The judge view's **Demo replay** panel plays any scenario from `scenarios/`
through the web app so the shift can be watched rather than read. Pick one,
press **Run demo**, and each scripted line is sent through the same `/api/turn`
call a typed or spoken message takes — real model replies, real risk state, real
tools. Nothing is mocked and nothing is bypassed; the only difference is who
supplies the user's words.

The panel resets the session before it starts, shows the scenario name and
`turn 3 / 7` as it goes, and pauses between turns so the mode transitions are
easy to follow. Manual typing and the mic are disabled while it runs, so a
replay and a real user can never share a session. **Stop** halts before the next
scripted turn, leaving the conversation where it stopped for inspection.

A scenario can carry an optional `audio` array — one clip per scripted line, in
`public/audio/` — and that line is then played in the recorded voice instead of
just appearing. `tech-support` has one (a synthesized-voice recording cut into one clip per line). Timing
is part of the design: the turn request goes out as the clip starts and the
reply's voice is fetched as soon as the text returns, so only a deliberate
600 ms beat sits between the user finishing and TrustCue answering. The user's
next line follows 1.0 s after a reply (1.5 s after a protective one, so the
warning can land), and the reply's text appears at the moment its voice starts.
All clips are loaded before the first line. Scenarios without `audio`, or a clip
that fails to load, play as text exactly as before. Browsers only allow audio
after a real click, so **Run demo** must be pressed by hand, not scripted.

`tech-support` is preselected — it is the `normal → curious → protective`
walkthrough. This is a frontend addition only: `npm run scenario` is untouched
and remains the regression runner.

## Layout

```
src/signals.js   the ten reported signals and the six families they collapse into
src/risk.js      the state machine — the only thing that decides the mode
src/prompt.js    system prompt, one behaviour block per mode
src/agent.js     the single structured LLM call
src/mock-agent.js keyword stand-in for TRUSTCUE_MOCK=1
src/tools.js     the two tools and their fixed copy
src/session.js   one turn end to end, including the rewrite pass
src/speech.js    Amazon Polly — the voice, and nothing else
src/server.js    static files + /api/turn, /api/reset, /api/meta, /api/speak
public/          the Alexa-like UI and the judge panel
scenarios/       canned conversations with pass/fail expectations
```

## Scope

TrustCue is a single agent with in-memory, session-scoped state: no monitoring
service, multi-agent orchestration, RAG or scam knowledge base. It deliberately
leaves out:

- Real Alexa/AVS device integration, an MCP server, Amazon account linking
- Persistence, auth, user accounts, cross-session memory
- Real phone calls, contacts, bank or payment integrations
- Caller-ID, SMS or email ingestion, audio deepfake detection
- Multilingual support, and accessibility beyond sane defaults

## Hackathon

Built for the [Amazon Developer Hackathon 2026](https://amazonappdev2026.devpost.com/),
**Alexa+ track**, via the simulated Alexa+ web app path (not MCP). AWS services called at
runtime: Amazon Bedrock (Nova 2 Lite, Converse API) in `src/agent.js` and Amazon
Polly in `src/speech.js`.

## Disclaimer

TrustCue is a demo of an interaction pattern, not a fraud-detection product. It
is not affiliated with or endorsed by Amazon; "Alexa+" and "Amazon" are
trademarks of Amazon.com, Inc. or its affiliates. Running against AWS incurs
Bedrock and Polly charges on your account.

## License

[MIT](LICENSE)
