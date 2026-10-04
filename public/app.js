const $ = (id) => document.getElementById(id);
const sessionId = 'web-' + Math.random().toString(36).slice(2, 8);

let meta = { thresholds: { curious: 3, protective: 6 }, families: {}, scenarios: [], tts: false };
let busy = false;
let seenSignals = new Set();
// Demo replay owns the conversation while it runs; manual input is locked out.
const replay = { active: false, stop: false };

/* ---------------- orb + speech ---------------- */

const orb = $('orb');
const setOrb = (state, hint) => {
  orb.dataset.state = state;
  if (hint !== undefined) $('hint').textContent = hint;
};

let voice = null;
const pickVoice = () => {
  const all = speechSynthesis.getVoices();
  voice =
    all.find((v) => /Samantha|Serena|Google US English|Microsoft Aria/i.test(v.name)) ||
    all.find((v) => v.lang.startsWith('en')) ||
    all[0];
};
pickVoice();
speechSynthesis.onvoiceschanged = pickVoice;

// The browser's own voice, used only when TRUSTCUE_TTS=off selects it.
// An OS voice, and it sounds like one.
function speakLocally(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.pitch = 1.0;
    u.onstart = () => setOrb('speaking', '');
    u.onend = u.onerror = () => {
      setOrb('idle', '');
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

// Whatever is being spoken right now, so it can be cut off.
let current = null;

// Voice failures are shown, not worked around. Quietly dropping to the browser
// voice reads as "Polly sounds bad" and hides the actual cause.
const showVoiceError = (message) => {
  const el = $('voiceError');
  el.textContent = `Voice failed — ${message}`;
  el.hidden = false;
};
const clearVoiceError = () => ($('voiceError').hidden = true);

// Ends the current reply immediately, whichever voice is saying it. Pausing an
// <audio> fires no `ended` event, so the waiting promise is resolved by hand —
// otherwise Stop would leave the replay waiting on a reply that never finishes.
function stopSpeaking() {
  speechSynthesis.cancel();
  current?.stop();
}

// Plays one reply and resolves when it has finished — or when it has clearly
// stopped finishing. Waiting on `ended` alone is not enough:
//   - play() resolves before any audio has been decoded, so `playing` is not
//     proof of sound; a tab the browser has deprioritised can sit at
//     readyState 0 forever and fire neither `ended` nor `error`.
//   - a pause we did not ask for never fires `ended` either.
// So the clip has to load within a few seconds or it is treated as a failure
// (the caller then falls back to the browser voice), and once its real length
// is known a backstop sized to that length guarantees the turn ends.
const LOAD_TIMEOUT_MS = 5000;

// `onProgress` is handed how far through the clip playback is (0–1), once per
// frame while sound is actually playing, so the screen can follow the voice.
function playAudio(src, state = 'speaking', { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    audio.preload = 'auto';
    let settled = false;
    let timer = null;
    let frame = 0;
    const release = () => {
      settled = true;               // set first, so our own pause() is ignored below
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      if (current?.audio === audio) current = null;
      audio.pause();
      URL.revokeObjectURL(src);
      setOrb('idle', '');
    };
    const finish = () => settled || (release(), resolve());
    const fail = (err) => settled || (release(), reject(err));

    timer = setTimeout(() => fail(new Error('audio never loaded')), LOAD_TIMEOUT_MS);
    audio.onloadedmetadata = () => {
      clearTimeout(timer);
      const length = Number.isFinite(audio.duration) ? audio.duration : 30;
      timer = setTimeout(finish, length * 1000 + 3000);
    };
    audio.onplay = () => setOrb(state, '');
    audio.onplaying = () => {       // sound has really started (also after a stall)
      if (!onProgress) return;
      cancelAnimationFrame(frame);
      const tick = () => {
        if (settled) return;
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          onProgress(Math.min(1, audio.currentTime / audio.duration));
        }
        frame = requestAnimationFrame(tick);
      };
      tick();
    };
    audio.onended = finish;
    audio.onpause = finish;
    audio.onerror = () => fail(new Error('audio playback failed'));

    current = { audio, stop: finish };
    audio.src = src;
    audio.play().catch(fail);
  });
}

// Polly speaks the reply, delivered under the mode the turn ended in — the
// server turns that into pace, volume and timing. Fetching and playing are
// separate steps so a caller can fetch early (while the user is still talking)
// and play the instant the reply is due. Resolves to:
//   a blob URL  — Polly audio, ready to play
//   null        — TRUSTCUE_TTS=off, so the browser's own voice is used instead
//   false       — Polly failed; the failure has been shown, and the turn goes on
// Failure is shown rather than papered over, but never blocks the conversation.
function prefetchSpeech(text, mode) {
  if (!text || !meta.tts) return Promise.resolve(null);
  return fetch('/api/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, mode }),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`speak failed (${res.status})`);
      return URL.createObjectURL(await res.blob());
    })
    .catch((err) => {
      console.error('Polly failed:', err);
      showVoiceError(err.message);
      return false;
    });
}

async function speak(text, mode, ready = prefetchSpeech(text, mode)) {
  if (!text) return;
  stopSpeaking();
  const url = await ready;
  if (url === false) return;
  if (url === null) return speakLocally(text);
  try {
    await playAudio(url);
    clearVoiceError();
  } catch (err) {
    console.error('Polly failed:', err);
    showVoiceError(err.message);
  }
}

/* ---------------- transcript ---------------- */

// Returns the main bubble, so a caller can keep filling it in.
function addTurn(who, text, mode, toolSpeech) {
  const el = document.createElement('div');
  el.className = `turn ${who}`;
  if (mode) el.dataset.mode = mode;
  el.innerHTML = `<div class="who">${who === 'user' ? 'you' : 'trustcue'}</div>
    <div class="bubble"></div>`;
  el.querySelector('.bubble').textContent = text;
  if (toolSpeech) {
    const t = document.createElement('div');
    t.className = 'bubble tool';
    t.textContent = toolSpeech;
    el.appendChild(t);
  }
  $('transcript').appendChild(el);
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return el.querySelector('.bubble');
}

// The words of a recorded line, written out as they are spoken: a line that
// is on screen before the first word is said looks written in advance, which
// is the one thing a live-sounding demo must not do. A clip carries no
// word-level timing, so each word gets a share of the clip by its length, plus
// the pause a comma or full stop leaves in the speech (the clips are trimmed
// tight, so the speech runs across the whole file). A word appears as it
// begins to be said. Returns `show(p)`, p being how far through the clip we
// are; the bubble is only created once the first word is due.
function paceWords(text, getBubble) {
  const words = [...text.matchAll(/\S+/g)];
  const starts = [];
  let total = 0;
  words.forEach((m, i) => {
    starts.push(total);
    const last = i === words.length - 1;
    total += m[0].length + (last ? 0 : /[.?!]$/.test(m[0]) ? 6 : /[,;:—–-]$/.test(m[0]) ? 3 : 0);
  });

  let shown = 0;
  return (p) => {
    let n = shown;
    while (n < words.length && starts[n] / total <= p) n += 1;
    if (n === shown || n === 0) return;
    shown = n;
    getBubble().textContent = text.slice(0, words[n - 1].index + words[n - 1][0].length);
    $('transcript').scrollTop = $('transcript').scrollHeight;
  };
}

/* ---------------- judge view ---------------- */

function renderJudge(state) {
  document.body.dataset.mode = state.mode;
  $('modeChip').textContent = state.mode;

  const max = meta.thresholds.protective + 4;
  const pct = (v) => Math.min(100, (v / max) * 100);
  $('meterFill').style.width = pct(state.score) + '%';
  $('tickCurious').style.left = pct(meta.thresholds.curious) + '%';
  $('tickProtective').style.left = pct(meta.thresholds.protective) + '%';
  $('scoreText').textContent = `score ${state.score}`;
  $('triggerText').textContent = state.protectiveTurn ? `protective triggered on turn ${state.protectiveTurn}` : '';

  const list = $('signalList');
  list.innerHTML = '';
  if (!state.signals.length) {
    list.innerHTML = '<li class="empty">none yet</li>';
  } else {
    for (const s of state.signals) {
      const li = document.createElement('li');
      if (!seenSignals.has(s.family)) li.className = 'fresh';
      seenSignals.add(s.family);
      const label = meta.families[s.family]?.label ?? s.family;
      li.innerHTML = `<div class="row"><span class="name">${label}</span><span class="w">turn ${s.turn} · +${s.weight}</span></div>`;
      if (s.evidence) {
        const ev = document.createElement('div');
        ev.className = 'ev';
        ev.textContent = `“${s.evidence}”`;
        li.appendChild(ev);
      }
      list.appendChild(li);
    }
  }

  const log = $('turnLog');
  log.innerHTML = '';
  if (!state.trace.length) {
    log.innerHTML = '<li class="empty">no turns yet</li>';
  } else {
    for (const t of state.trace) {
      const bits = [];
      if (t.added.length) bits.push(t.added.map((a) => `+${a.family}`).join(' '));
      if (t.mode !== t.modeSpokenUnder) {
        const cls = t.mode === 'protective' ? 'trigger' : 'shift';
        bits.push(`<span class="${cls}">→ ${t.mode}</span>`);
      }
      if (t.repaired) bits.push('reply rewritten');
      if (t.pendingMode) bits.push(`holding, next: ${t.pendingMode}`);
      if (t.tool) bits.push(`<span class="toolfire">tool: ${t.tool.name}${t.tool.arg ? ' · ' + t.tool.arg : ''}</span>`);
      if (!bits.length) bits.push('—');
      const li = document.createElement('li');
      li.innerHTML = `<span class="n">${t.turn}</span><span>${bits.join(' · ')}</span>`;
      log.appendChild(li);
    }
  }
}

/* ---------------- conversation ---------------- */

// Resolves true when the turn completed (or the replay was stopped mid-turn),
// false when it was refused or errored. The replay loop uses that to stop
// rather than plough on through a broken turn.
//
// With a recorded `clip`, the turn is paced like a real exchange. The request
// goes out the moment the user starts speaking, and the reply's audio is
// fetched as soon as the text is back, so by the time the clip ends everything
// is ready and the only wait left is the deliberate beat of a listener
// answering. Reply text and voice land together: the bubble appears when the
// audio starts, not before it. The user's own line is written out as the clip
// is spoken (see paceWords) rather than dropped on screen whole.
const RESPONSE_GAP_MS = 600;   // user stops → assistant starts, the beat of a listener taking it in
let lastMode = 'normal';

async function send(text, { clip = null } = {}) {
  if (busy || !text.trim()) return false;
  busy = true;
  // Typed or spoken-live text is already complete; a recorded line is not.
  let userBubble = clip ? null : addTurn('user', text);
  const getUserBubble = () => (userBubble ??= addTurn('user', ''));
  const reveal = clip ? paceWords(text, getUserBubble) : null;
  try {
    const turn = fetch('/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'request failed');
        return { data, voice: prefetchSpeech(data.entry.reply, data.entry.mode) };
      });
    turn.catch(() => {});        // surfaced below; don't let a stopped replay leave it unhandled

    if (clip) {
      // A clip that won't play is not fatal — the line just lands whole.
      await playAudio(clip, 'listening', { onProgress: reveal }).catch((err) => console.error('clip failed:', err));
      if (replay.stop) {         // cut off mid-line: leave only what was said
        setOrb('idle', '');
        return true;
      }
      getUserBubble().textContent = text;   // complete the line (all of it, if the clip never played)
      setOrb('thinking', 'thinking…');
      await gap(RESPONSE_GAP_MS);
      if (replay.stop) {
        setOrb('idle', '');
        return true;
      }
    } else {
      setOrb('thinking', 'thinking…');
    }

    const { data, voice } = await turn;
    const url = await voice;
    if (replay.stop && clip) {
      setOrb('idle', '');
      return true;
    }
    addTurn('cue', data.entry.agentReply, data.entry.mode, data.entry.toolSpeech);
    renderJudge(data.state);
    lastMode = data.entry.mode;
    await speak(data.entry.reply, data.entry.mode, url);
    return true;
  } catch (err) {
    setOrb('idle', '');
    addTurn('cue', `(error: ${err.message})`);
    return false;
  } finally {
    busy = false;
  }
}

// Everything the user drives goes through here, so replay and manual input
// can never interleave on the same session.
const manualSend = (text) => {
  if (replay.active) return;
  send(text);
};

/* ---------------- voice input ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let listening = false;

if (SR) {
  recog = new SR();
  recog.lang = 'en-US';
  recog.interimResults = true;
  recog.continuous = false;

  recog.onstart = () => {
    listening = true;
    $('mic').classList.add('on');
    setOrb('listening', 'listening…');
  };
  recog.onresult = (e) => {
    const text = Array.from(e.results).map((r) => r[0].transcript).join('');
    $('input').value = text;
    if (e.results[e.results.length - 1].isFinal) {
      $('input').value = '';
      manualSend(text);
    }
  };
  recog.onerror = () => setOrb('idle', 'Didn’t catch that.');
  recog.onend = () => {
    listening = false;
    $('mic').classList.remove('on');
    if (orb.dataset.state === 'listening') setOrb('idle', '');
  };
} else {
  $('mic').classList.add('off');
  $('mic').title = 'Speech recognition needs Chrome or Edge';
}

$('mic').onclick = () => {
  if (!recog || replay.active) return;
  stopSpeaking();
  listening ? recog.stop() : recog.start();
};

/* ---------------- wiring ---------------- */

$('send').onclick = () => {
  const v = $('input').value;
  $('input').value = '';
  manualSend(v);
};
$('input').onkeydown = (e) => {
  if (e.key === 'Enter') $('send').click();
};

$('judgeToggle').onclick = () => {
  const open = $('judge').hidden;
  $('judge').hidden = !open;
  $('judgeToggle').setAttribute('aria-pressed', String(open));
};
$('judgeClose').onclick = () => {
  $('judge').hidden = true;
  $('judgeToggle').setAttribute('aria-pressed', 'false');
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'j' && !['INPUT', 'SELECT'].includes(e.target.tagName)) $('judgeToggle').click();
});

async function resetSession() {
  stopSpeaking();
  const res = await fetch('/api/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const { state } = await res.json();
  $('transcript').innerHTML = '';
  seenSignals = new Set();
  renderJudge(state);
  setOrb('idle', 'Tap the mic, or just type.');
}

$('reset').onclick = () => {
  if (!replay.active) resetSession();
};

/* ---------------- demo replay ---------------- */

// Drives a canned scenario through the very same /api/turn path a typed or
// spoken message takes — no mocked replies, no shortcut past the risk machine.
// The only difference is who supplies the user's words.

const TURN_GAP_MS = 1600;      // text-only replay: long enough to watch a mode transition land

// With recorded audio the gap is the user's pause before speaking again. It is
// shorter than the text-only gap because sound carries the rhythm, and longer
// after a protective reply: the warning needs a moment to land before the
// person answers it.
const USER_GAP_MS = 1000;
const USER_GAP_AFTER_PROTECTIVE_MS = 1500;
const OPENING_BEAT_MS = 700;   // clean transcript, then the first line

const selectedScenario = () => meta.scenarios.find((s) => s.name === $('demoScenario').value);
const setDemoStatus = (text) => ($('demoStatus').textContent = text);

// The pause between turns: one timer rather than a polling loop, so a
// throttled background tab cannot stretch it, and Stop can cut it short.
let endGap = null;
const gap = (ms) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      endGap = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    endGap = done;
  });

function setReplayUI(on) {
  replay.active = on;
  document.body.dataset.replay = on ? 'on' : 'off';
  $('demoRun').disabled = on;
  $('demoScenario').disabled = on;
  $('reset').disabled = on;
  $('demoStop').disabled = !on;
  // Manual input is locked out so the two can never share a session.
  $('input').disabled = on;
  $('send').disabled = on;
  $('mic').disabled = on;
  $('input').placeholder = on ? 'Demo replay running…' : 'Say something to TrustCue…';
}

// One blob URL per scripted line, or null where there is no recording (a
// scenario without audio, or a clip that failed to load) — that line then plays
// as text, exactly as it did before.
async function loadClips(urls, count) {
  if (!urls?.length) return Array(count).fill(null);
  setDemoStatus('loading audio…');
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      try {
        const res = await fetch(urls[i]);
        if (!res.ok) throw new Error(`${res.status}`);
        return URL.createObjectURL(await res.blob());
      } catch (err) {
        console.error(`clip ${i + 1} failed to load:`, err);
        return null;
      }
    }),
  );
}

async function runDemo() {
  const scenario = selectedScenario();
  if (!scenario || replay.active) return;

  replay.stop = false;
  setReplayUI(true);
  if (listening) recog.stop();

  const total = scenario.turns.length;
  setDemoStatus(`${scenario.name} · resetting…`);
  await resetSession();

  // Load every clip up front: a clip that has to be fetched mid-conversation
  // would show up as a stall in the user's own voice.
  const clips = await loadClips(scenario.audio, total);
  let played = 0;
  let failedAt = 0;
  lastMode = 'normal';
  if (clips.some(Boolean) && !replay.stop) await gap(OPENING_BEAT_MS);
  for (const line of scenario.turns) {
    if (replay.stop) break;                       // halt before the next scripted turn
    setDemoStatus(`${scenario.name} · turn ${played + 1} / ${total}`);
    const clip = clips[played];
    if (!(await send(line, { clip }))) {
      failedAt = played + 1;
      break;
    }
    played += 1;
    if (played < total && !replay.stop) {
      await gap(!clip ? TURN_GAP_MS : lastMode === 'protective' ? USER_GAP_AFTER_PROTECTIVE_MS : USER_GAP_MS);
    }
  }
  clips.forEach((u) => u && URL.revokeObjectURL(u));

  const tail = failedAt
    ? `stopped — turn ${failedAt} / ${total} failed`
    : replay.stop
      ? `stopped at turn ${played} / ${total}`
      : `finished · ${total} / ${total} turns`;
  setDemoStatus(`${scenario.name} · ${tail}`);
  setReplayUI(false);
  setOrb('idle', 'Tap the mic, or just type.');
}

$('demoRun').onclick = runDemo;
$('demoStop').onclick = () => {
  if (!replay.active) return;
  replay.stop = true;
  stopSpeaking();             // cut the reply being spoken short so the halt is prompt
  endGap?.();                 // and don't sit out the rest of the inter-turn pause
  setDemoStatus(`${selectedScenario()?.name ?? 'demo'} · stopping…`);
};
$('demoScenario').onchange = () => {
  const s = selectedScenario();
  if (!s) return;
  $('demoScenario').title = s.description;
  setDemoStatus(`${s.name} · ${s.turns.length} turns · ready`);
};

/* ---------------- boot ---------------- */

(async () => {
  meta = await (await fetch('/api/meta')).json();
  $('modelTag').textContent = meta.mock ? 'MOCK' : meta.model;
  $('modelTag').title = meta.tts ? `voice: Amazon Polly ${meta.voice}` : 'voice: browser speechSynthesis';
  for (const s of meta.scenarios) {
    const o = document.createElement('option');
    o.value = s.name;
    o.textContent = `${s.name} · ${s.turns.length} turns`;
    $('demoScenario').appendChild(o);
  }
  // tech-support is the normal → curious → protective walkthrough.
  const first = meta.scenarios.find((s) => s.name === 'tech-support') ?? meta.scenarios[0];
  if (first) {
    $('demoScenario').value = first.name;
    $('demoScenario').onchange();
  } else {
    $('demoRun').disabled = true;
    setDemoStatus('no scenarios found');
  }
  renderJudge({ mode: 'normal', score: 0, signals: [], trace: [], protectiveTurn: null });
})();
