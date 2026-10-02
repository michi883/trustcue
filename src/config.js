import fs from 'node:fs';

// Minimal .env support so there is no dotenv dependency.
try {
  for (const line of fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env — environment variables only */
}

export const config = {
  // Amazon Bedrock. Credentials come from the AWS SDK's default chain
  // (environment, shared config, SSO, instance role) — never from this file.
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  modelId: process.env.TRUSTCUE_MODEL || 'us.amazon.nova-2-lite-v1:0',
  temperature: Number(process.env.TRUSTCUE_TEMPERATURE ?? 0.3),
  maxTokens: 800,
  port: Number(process.env.PORT || 4173),
  // Offline stand-in for demos without AWS access.
  mock: process.env.TRUSTCUE_MOCK === '1',

  // Amazon Polly speaks the reply. The browser's own speechSynthesis is the
  // fallback, so the app still talks with no AWS access at all.
  tts: process.env.TRUSTCUE_TTS !== 'off',
  // Ruth on the long-form engine: the engine built for connected, multi-sentence
  // delivery, which is what keeps a reply sounding like part of a conversation
  // rather than a line read on its own. Long-form is en-US only — Danielle,
  // Gregory and Patrick are the alternatives. For en-GB (Amy, Brian) or a lower
  // bill, use the generative engine instead.
  voice: process.env.TRUSTCUE_VOICE || 'Ruth',
  ttsEngine: process.env.TRUSTCUE_TTS_ENGINE || 'long-form',
};
