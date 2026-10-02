# Devpost submission draft — TrustCue

Track: **Alexa+** (simulated Alexa+ web app). Mini challenges: **AWS Builder**, **Open Source**.
Repo: <GitHub URL> (MIT). Demo video: <YouTube/Vimeo URL, under 3 min, public>.

## Text description

TrustCue shows how a voice assistant can protect someone from a scam inside
ordinary conversation, with no accusations or alarms. Most of the conversation is
normal. Weak signals (an unsolicited call, urgency, secrecy, remote access,
unusual payment) accumulate across turns, and the assistant moves
`normal → curious → protective` one step at a time.

**How it works.** Each turn makes one Amazon Bedrock Converse call to Amazon Nova 2
Lite with a forced `record_turn` tool, which returns the spoken reply plus any
signals found in the user's message. The model never sees the score and never
picks the mode. Code does: ten reported signals collapse into six risk families,
each scoring once; thresholds are 3 (curious) and 6 (protective); the mode moves
at most one step per turn. Code also enforces the rules a small model won't hold
by instruction: signals need a verbatim quote, no safety advice before
protective, no alarm words once protective, no echoing. If a turn changes the
mode, the reply is rewritten under the new mode so the words match. Two fixed-copy
tools (`explain_scam_pattern`, `start_practice_simulation`) are reachable only in
protective mode. Amazon Polly (long-form, Ruth) speaks the reply, with rate,
volume and a pause set by mode so the warning lands calmly. A judge view shows
the invisible parts: signals with evidence, running score, and the exact turn
protective mode fired.

**Built with:** Node.js, Amazon Bedrock (Nova 2 Lite), Amazon Polly, Web Speech API.

## Product feedback (edit with your own experience)

- **Bedrock Converse + Nova 2 Lite.** Forcing `toolChoice` on one tool was the
  reliable way to get structured output. Occasionally Nova returned the call as
  XML text (`stopReason: malformed_tool_use`) and we had to parse it. Nova often
  picked different neighbouring labels for the same sentence, so labels are
  normalised in code. It ignored some negative instructions (no safety advice,
  no alarm words) until we enforced them after the response.
- **Polly.** Only rate, volume and break work on the long-form/generative
  engines; `pitch` is standard-only and `emphasis` is rejected, which was not
  obvious up front. Long-form is en-US only.
- **Nova Sonic.** Considered, but speech-to-speech would remove the code-owned
  mode and guards, which are the point of this design (see README).
- **Onboarding.** <add: model access, credentials, region/inference-profile
  friction, anything that cost you time>

## Optional

- Feature requests: <add>
- Friction log (up to 10% bonus): <add>
