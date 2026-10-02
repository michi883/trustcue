// Amazon Polly — the voice TrustCue speaks with, and how it carries the mode.
//
// Polly only ever voices a string the rest of the pipeline has already settled:
// the mode is code's decision, the reply has been through the agent's guards and
// any rewrite, and only then does it get spoken. Nothing here can change the
// words. That is why this is Polly and not Nova Sonic — Sonic is speech-to-speech
// and would generate its own reply, bypassing the state machine entirely.
//
// What this file does add is delivery. Each turn is a separate, stateless
// synthesis, so without help the voice resets to neutral every turn and the
// conversation sounds like unrelated lines read aloud. The mode is the shape of
// the conversation, and it is already known here, so it drives the delivery.

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { config } from './config.js';

let client = null;
const getClient = () => (client ??= new PollyClient({ region: config.region }));

// How each mode is spoken: speaking rate, volume, and a pause after the first
// sentence. The generative and long-form engines accept exactly these three
// levers — `pitch` is standard-engine only and `emphasis` is rejected outright,
// so tension has to be carried by pace, loudness and timing.
//
// Rising risk leans in rather than speeding up: curious is a touch quicker, as
// if paying closer attention, and protective drops back below normal and gets
// louder, so the warning lands with weight instead of sounding panicked. A
// frightened-sounding assistant is the one thing a scam victim does not need.
const DELIVERY = {
  normal: { rate: null, volume: null, pause: 0 },
  curious: { rate: '102%', volume: '+1dB', pause: 0 },
  protective: { rate: '96%', volume: '+3dB', pause: 300 },
  practice: { rate: null, volume: null, pause: 0 }, // role-play: the scammer, not TrustCue
};

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildSsml(text, mode) {
  const { rate, volume, pause } = DELIVERY[mode] ?? DELIVERY.normal;
  let body = escapeXml(text);
  // Let the opening sentence land before the advice that follows it.
  if (pause) body = body.replace(/([.!?])\s+/, `$1<break time="${pause}ms"/> `);
  const attrs = [rate && `rate="${rate}"`, volume && `volume="${volume}"`].filter(Boolean).join(' ');
  if (attrs) body = `<prosody ${attrs}>${body}</prosody>`;
  return `<speak>${body}</speak>`;
}

// A demo replays the same lines over and over, and the mock agent repeats itself
// by design. Polly is billed per character, so remember what has already been
// spoken. Bounded, because sessions are not.
const CACHE_LIMIT = 200;
const cache = new Map();

// Replies are at most three sentences. Anything longer is a bug upstream, and
// paying long-form rates for it would be the wrong way to find out.
const MAX_CHARS = 1500;

export const ttsAvailable = () => config.tts;

export async function synthesize(text, mode = 'normal') {
  const key = `${config.ttsEngine}:${config.voice}:${mode}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;

  if (text.length > MAX_CHARS) throw new Error(`reply too long to speak (${text.length} chars)`);

  const res = await getClient().send(
    new SynthesizeSpeechCommand({
      Text: buildSsml(text, mode),
      TextType: 'ssml',
      VoiceId: config.voice,
      Engine: config.ttsEngine,
      OutputFormat: 'mp3',
    }),
  );

  const audio = Buffer.from(await res.AudioStream.transformToByteArray());

  // Map preserves insertion order, so the oldest key is the first one.
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, audio);
  return audio;
}
