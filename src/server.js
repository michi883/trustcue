// Phase 1: the web app. A static file server, three JSON endpoints and the
// audio one that voices a reply.
// Sessions live in memory and die with the process — no database, by design.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, takeTurn } from './session.js';
import { synthesize, ttsAvailable } from './speech.js';
import { config } from './config.js';
import { FAMILIES } from './signals.js';
import { THRESHOLDS } from './risk.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const scenarioDir = path.join(here, '..', 'scenarios');

const sessions = new Map();
const getSession = (id) => {
  if (!sessions.has(id)) sessions.set(id, createSession());
  return sessions.get(id);
};

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const publicState = (session) => ({
  mode: session.practice ? 'practice' : session.risk.mode,
  score: session.risk.score,
  turn: session.risk.turn,
  protectiveTurn: session.risk.protectiveTurn,
  practice: session.practice,
  signals: session.risk.signals,
  trace: session.trace,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      return json(res, 200, {
        model: config.mock ? 'mock' : config.modelId,
        mock: config.mock,
        tts: ttsAvailable(),
        voice: config.voice,
        thresholds: THRESHOLDS,
        families: Object.fromEntries(
          Object.entries(FAMILIES).map(([id, f]) => [id, { weight: f.weight, label: f.label, blurb: f.blurb }]),
        ),
        scenarios: fs
          .readdirSync(scenarioDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => JSON.parse(fs.readFileSync(path.join(scenarioDir, f), 'utf8')))
          .map(({ name, description, turns, audio }) => ({ name, description, turns, audio })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/turn') {
      const { sessionId = 'default', text } = await readBody(req);
      if (!text || !text.trim()) return json(res, 400, { error: 'text is required' });
      const session = getSession(sessionId);
      const entry = await takeTurn(session, text.trim());
      return json(res, 200, { entry, state: publicState(session) });
    }

    // Voices a reply that has already been decided. The browser falls back to
    // its own speechSynthesis if this fails, so a Polly error is never fatal.
    if (req.method === 'POST' && url.pathname === '/api/speak') {
      if (!ttsAvailable()) return json(res, 503, { error: 'tts disabled' });
      const { text, mode } = await readBody(req);
      if (!text || !text.trim()) return json(res, 400, { error: 'text is required' });
      const audio = await synthesize(text.trim(), mode);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
      return res.end(audio);
    }

    if (req.method === 'POST' && url.pathname === '/api/reset') {
      const { sessionId = 'default' } = await readBody(req);
      sessions.set(sessionId, createSession());
      return json(res, 200, { state: publicState(sessions.get(sessionId)) });
    }

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(config.port, () => {
  const voice = config.tts ? `${config.voice}/${config.ttsEngine}` : 'browser speechSynthesis';
  console.log(
    `TrustCue on http://localhost:${config.port}  (${config.mock ? 'MOCK' : config.modelId + ' @ ' + config.region})  voice: ${voice}`,
  );
});
