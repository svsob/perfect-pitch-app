// Perfect Pitch Mini App (Projektový dizajn): daily training with all seven notes, then a 28-task test.
// The bot puts the plan into the link; the app plays it and returns the data with Telegram.WebApp.sendData.
import { Audio } from './audio.js?v=8';
import { COLORS, NOTE_IDS, buildPayload, decodePlan, packState, testEntry } from './plan.js?v=8';
import { makeT, noteName } from './i18n.js?v=8';

const tg = window.Telegram?.WebApp;
// Launched from the chat's reply-keyboard button Telegram may pass no initData, so also trust the platform.
const inTelegram = !!(tg && (tg.initData || (tg.platform && tg.platform !== 'unknown')));
const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1'; // local testing: 20-second minimum training
const app = document.getElementById('app');
const audio = new Audio('sounds/');
window.__audio = audio; // for debugging in the browser console

let plan, t, lang, state, store, colors, ticker = null, lastTick = 0, lastSave = 0;

// ---------- storage (Telegram CloudStorage, else localStorage) ----------
function makeStore() {
  const cloud = inTelegram && tg.isVersionAtLeast?.('6.9') && tg.CloudStorage;
  const ls = {
    get: (k) => Promise.resolve((() => { try { return localStorage.getItem(k); } catch { return null; } })()),
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } return Promise.resolve(); },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } return Promise.resolve(); },
  };
  if (!cloud) return ls;
  // never wait more than 2 s for Telegram's cloud: a missing callback must not freeze the session
  const wait = (fn, fallback) => new Promise((ok) => {
    const timer = setTimeout(() => ok(fallback), 2000);
    try { fn((v) => { clearTimeout(timer); ok(v); }); } catch { clearTimeout(timer); ok(fallback); }
  });
  return {
    get: (k) => wait((done) => cloud.getItem(k, (err, v) => done(err ? null : v || null)), null),
    set: (k, v) => wait((done) => cloud.setItem(k, v, () => done()), undefined),
    del: (k) => wait((done) => cloud.removeItem(k, () => done()), undefined),
  };
}
const keyState = (sid) => `pp2_${sid}`;
const keySent = (sid) => `pp2sent_${sid}`;
const KEY_PENDING = 'pp2_pending';
const save = () => { lastSave = Date.now(); return store.set(keyState(plan.sid), JSON.stringify(state)); };

async function pendingList() {
  try { return JSON.parse((await store.get(KEY_PENDING)) || '[]'); } catch { return []; }
}
async function markPending() {
  const list = await pendingList();
  if (!list.includes(plan.sid)) {
    list.push(plan.sid);
    await store.set(KEY_PENDING, JSON.stringify(list.slice(-10)));
  }
}

// ---------- helpers ----------
const $ = (sel) => app.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const haptic = () => { try { if (inTelegram) tg.HapticFeedback.impactOccurred('light'); } catch { /* old client */ } };
const minTrainMs = () => (FAST ? 20 : plan.min_train_s) * 1000;

function header(sub) {
  return `<header class="top"><div class="brand">PERFECT&nbsp;PITCH</div>
    <div class="eyebrow">${esc(t('day', { d: plan.day }))}${sub ? ' · ' + esc(sub) : ''}</div></header>`;
}

/** Seven keys: coloured squares with the Latin name (training) or neutral ivory keys (test, no colours). */
function keysHtml(neutral) {
  return `<div class="keys${neutral ? ' neutral' : ''}">${NOTE_IDS.map((n) =>
    `<button class="key" data-n="${n}" style="${neutral ? '' : `--k:${colors[n]}`}" disabled><span>${esc(noteName(lang, n))}</span></button>`,
  ).join('')}</div>`;
}

function setOrb(color, label = '', mark = '') {
  const orb = $('#orb');
  if (!orb) return;
  orb.style.setProperty('--c', color || 'transparent');
  orb.classList.toggle('lit', !!color);
  orb.querySelector('.label').textContent = label;
  orb.querySelector('.mark').textContent = mark;
}

function enableKeys(on) {
  app.querySelectorAll('.key').forEach((k) => { k.disabled = !on; });
  if (on) audio.wake();
}

function screenMessage(msg) {
  app.innerHTML = `<main class="center"><div class="card"><div class="brand">PERFECT&nbsp;PITCH</div><p>${esc(msg)}</p></div></main>`;
}

// ---------- training segments (time is counted while the training screen is open and visible) ----------
function openSeg() {
  if (state.seg >= 0) return;
  const now = Date.now();
  state.segs.push({ s: now, e: now, a: 0, i: 1, c: [0, 0, 0, 0, 0, 0, 0] });
  state.seg = state.segs.length - 1;
  lastTick = performance.now();
  markPending();
}
function closeSeg(interrupted) {
  if (state.seg < 0) return;
  const seg = state.segs[state.seg];
  seg.e = Date.now();
  seg.i = interrupted ? 1 : 0;
  state.seg = -1;
}
function tick() {
  const now = performance.now();
  if (state.seg >= 0 && !document.hidden) {
    const d = Math.min(now - lastTick, 5000);
    const seg = state.segs[state.seg];
    seg.a += d;
    seg.e = Date.now();
    state.trainMs += d;
  }
  lastTick = now;
  if (Date.now() - lastSave > 5000) save();
  renderTimer();
}
document.addEventListener('visibilitychange', () => {
  if (!state || !['train'].includes(state.phase)) return;
  if (document.hidden) { closeSeg(true); save(); } else { openSeg(); }
});

function renderTimer() {
  const el = $('#timer');
  if (!el) return;
  el.textContent = t('today_time', { t: mmss(state.trainMs) });
  const bar = $('#tbar');
  const btn = $('#go');
  if (plan.kind === 'main') {
    const left = minTrainMs() - state.trainMs;
    if (bar) bar.style.width = `${Math.min(100, (100 * state.trainMs) / minTrainMs())}%`;
    if (btn) btn.disabled = left > 0;
    const hint = $('#minhint');
    if (hint) hint.textContent = left > 0 ? t('min_left', { t: mmss(left) }) : t('min_ok');
  }
}

// ---------- screens ----------
function screenWelcome() {
  const main = plan.kind === 'main';
  const dots = NOTE_IDS.map((n) => `<i style="--k:${colors[n]}"></i>`).join('');
  app.innerHTML = `${header()}
    <main class="center">
      <div class="card hero">
        <h1>${esc(t(main ? 'title_main' : 'title_extra'))}</h1>
        <p class="lead">${esc(t(main ? 'lead_main' : 'lead_extra'))}</p>
        <div class="dots">${dots}</div>
        <p class="hint">🔊 ${esc(t('sound_hint'))}</p>
        <button class="ghost" id="soundcheck">🔊 ${esc(t('sound_check'))}</button>
        <p class="hint" id="soundmsg" hidden></p>
      </div>
      <div class="bar" id="loadbar" hidden><i></i></div>
      <button class="btn-gold" id="start">${esc(t('start'))}</button>
    </main>`;
  const loadSounds = async () => {
    const p = audio.unlock(); // first, inside the tap
    $('#loadbar').hidden = false;
    await p;
    await audio.load((f) => { $('#loadbar i').style.width = `${Math.round(f * 100)}%`; });
  };
  $('#soundcheck').onclick = async () => {
    const msg = $('#soundmsg');
    try {
      await loadSounds();
      audio.stopAll();
      audio.playNote('A', 0.05, plan.stim_s);
      msg.textContent = audio.state === 'running' ? t('sound_check_hint') : t('sound_blocked');
    } catch (e) {
      msg.textContent = `✕ ${e.message}`;
    }
    msg.hidden = false;
  };
  $('#start').onclick = async () => {
    const btn = $('#start');
    btn.disabled = true;
    btn.textContent = t('loading');
    try {
      await loadSounds();
    } catch (e) {
      screenMessage(`${t('loading')} ✕ ${e.message}`);
      return;
    }
    if (!state.st) state.st = Date.now();
    if (state.phase === 'welcome') state.phase = 'train';
    await save();
    route();
  };
}

function screenTrain() {
  const main = plan.kind === 'main';
  const seq = (plan.train && plan.train.seq) || 'ABCDEFG';
  app.innerHTML = `${header(t(main ? 'train_title' : 'title_extra'))}
    <main class="stage">
      <div class="row"><div class="timer" id="timer"></div><div class="hint small" id="minhint"></div></div>
      ${main ? '<div class="bar"><i id="tbar"></i></div>' : ''}
      <p class="prompt" id="prompt">${esc(t(state.demoDone ? 'train_ask' : 'demo'))}</p>
      <div class="orb" id="orb"><span class="label"></span><span class="mark">♪</span></div>
      <div class="under"><button class="ghost" id="replay">↻ ${esc(t('replay'))}</button><div class="score" id="score"></div></div>
      <div class="spacer"></div>
      ${keysHtml(false)}
      <div class="row2"><button class="link" id="demo">▶ ${esc(t('demo_again'))}</button></div>
      <button class="btn-gold" id="go" ${main ? 'disabled' : ''}>${esc(t(main ? 'start_test' : 'finish_extra'))}</button>
    </main>`;
  openSeg();
  clearInterval(ticker);
  ticker = setInterval(tick, 500);
  renderTimer();

  const keyEl = (n) => app.querySelector(`.key[data-n="${n}"]`);
  const count = (n) => { if (state.seg >= 0) state.segs[state.seg].c[NOTE_IDS.indexOf(n)] += 1; };
  const play = (n, dur = plan.stim_s) => { audio.stopAll(0.03); count(n); return audio.playNote(n, 0.05, dur); };
  const plain = (e) => (e[0] === 'r' ? e.slice(1) : e);
  state.rq = state.rq || [];   // notes answered wrong: they come back 2-3 tasks later
  state.tp = state.tp || 0;    // position in the plan's training order
  const showScore = () => {
    const ok = state.tr.filter((e) => plain(e)[0] === plain(e)[1]).length;
    $('#score').textContent = state.tr.length ? `✓ ${ok} / ${state.tr.length}` : '';
  };
  let run = 0; // bumps to stop a running demo / guess loop
  let current = null;

  const nextGuess = () => {
    const my = run;
    if (state.phase !== 'train') return;
    app.querySelectorAll('.key').forEach((k) => k.classList.remove('correct', 'wrong'));
    let note;
    let repeat = false;
    const due = state.rq.findIndex((q) => q.due <= state.tr.length);
    if (due >= 0) {
      note = state.rq.splice(due, 1)[0].n;
      repeat = true;
    } else {
      note = seq[state.tp % seq.length];
      state.tp += 1;
    }
    setOrb('', '', '?');
    $('#prompt').textContent = t(repeat ? 'train_repeat' : 'train_ask');
    enableKeys(false);
    const onset = play(note);
    current = { note, onset, answered: false, repeat };
    setTimeout(() => { if (my === run && current && !current.answered) enableKeys(true); }, Math.max(0, onset - performance.now()));
    showScore();
  };
  const answer = (resp) => {
    if (!current || current.answered) return;
    current.answered = true;
    const { note, onset, repeat } = current;
    const right = resp === note;
    enableKeys(false);
    audio.stopAll(0.05);
    state.tr.push(`${repeat ? 'r' : ''}${note}${resp}${Math.max(0, Math.round(performance.now() - onset)).toString(36)}`);
    keyEl(note).classList.add('correct');
    const my = run;
    if (right) {
      haptic();
      setOrb(colors[note], noteName(lang, note), '✓');
      $('#prompt').textContent = t('right');
    } else {
      // compare: first the note that was chosen, then the correct one; the mistake comes back soon
      keyEl(resp).classList.add('wrong');
      $('#prompt').textContent = t('wrong2', { c: noteName(lang, resp), n: noteName(lang, note) });
      setOrb(colors[resp], noteName(lang, resp), '');
      setTimeout(() => { if (my === run) play(resp, 1.0); }, 200);
      setTimeout(() => { if (my === run) { setOrb(colors[note], noteName(lang, note), ''); play(note, 1.6); } }, 1400);
      // at most one pending repeat per note and 3 in total, so repeats never crowd out the rest
      if (!state.rq.some((q) => q.n === note) && state.rq.length < 3) {
        state.rq.push({ n: note, due: state.tr.length + 2 + Math.floor(Math.random() * 2) });
      }
    }
    showScore();
    save();
    setTimeout(() => { if (my === run) nextGuess(); }, right ? 1300 : 3600);
  };
  const playDemo = async () => {
    const my = ++run;
    current = null;
    enableKeys(false);
    $('#demo').disabled = true;
    $('#replay').disabled = true;
    $('#prompt').textContent = t('demo');
    for (const n of NOTE_IDS) {
      if (my !== run || state.phase !== 'train') return;
      play(n, 1.4);
      setOrb(colors[n], noteName(lang, n));
      const k = keyEl(n);
      k.classList.remove('pulse'); void k.offsetWidth; k.classList.add('pulse');
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (my !== run) return;
    state.demoDone = true;
    save();
    $('#demo').disabled = false;
    $('#replay').disabled = false;
    nextGuess();
  };
  app.querySelectorAll('.key').forEach((k) => { k.onclick = () => answer(k.dataset.n); });
  $('#replay').onclick = () => {
    if (!current || current.answered) return;
    current.onset = play(current.note); // reaction time counts from the last hearing
  };
  $('#demo').onclick = playDemo;
  $('#go').onclick = async () => {
    if (main && state.trainMs < minTrainMs()) return;
    run += 1;
    current = null;
    audio.stopAll();
    clearInterval(ticker);
    tick();
    closeSeg(false);
    state.phase = main ? 'testintro' : 'done';
    if (!main) { state.done = true; state.ft = Date.now(); }
    await save();
    route();
  };
  if (!state.demoDone && main) playDemo(); else { state.demoDone = true; nextGuess(); }
}

function screenTestIntro() {
  app.innerHTML = `${header(t('test_title'))}
    <main class="center">
      <div class="card hero">
        <h1>${esc(t('test_title'))}</h1>
        <p class="lead">${esc(t('test_text', { n: plan.test.seq.length }))}</p>
        <div class="ornament">◇</div>
      </div>
      <button class="btn-gold" id="go">${esc(t('start'))}</button>
    </main>`;
  $('#go').onclick = async () => {
    state.phase = 'test';
    await save();
    route();
  };
}

function screenTest() {
  app.innerHTML = `${header(t('test_title'))}
    <main class="stage">
      <div class="bar"><i id="pbar"></i></div>
      <p class="prompt" id="prompt">${esc(t('test_wait'))}</p>
      <div class="orb" id="orb"><span class="label"></span><span class="mark">?</span></div>
      <div class="under"><div class="countdown"><i id="cbar"></i></div><div class="score" id="score"></div></div>
      <div class="spacer"></div>
      ${keysHtml(true)}
    </main>`;
  // a task that was on screen when the app closed counts as a timeout: no second hearing
  if (state.cur === state.te.length && state.cur < plan.test.seq.length) {
    state.te.push(testEntry(plan.test.seq[state.cur], '', 0));
    save();
  }
  nextTask();
}

let taskTimer = null, cdTimer = null;
function nextTask() {
  const seq = plan.test.seq;
  const i = state.te.length;
  $('#pbar').style.width = `${(100 * i) / seq.length}%`;
  if (i >= seq.length) {
    finishTest();
    return;
  }
  $('#score').textContent = `${i + 1} / ${seq.length}`;
  $('#prompt').textContent = t('test_wait');
  $('#cbar').style.width = '100%';
  enableKeys(false);
  state.cur = i;
  save();
  const note = seq[i];
  const noiseEnd = audio.playNoise(plan.test.noise[i] || 1500);
  const onset = audio.playNote(note, (noiseEnd - performance.now()) / 1000 + 0.05, plan.stim_s);
  let answered = false;
  const answer = (resp) => {
    if (answered) return;
    answered = true;
    clearTimeout(taskTimer);
    clearInterval(cdTimer);
    enableKeys(false);
    audio.stopAll(0.05);
    state.te.push(testEntry(note, resp, performance.now() - onset));
    save();
    setTimeout(nextTask, 250);
  };
  setTimeout(() => {
    if (answered) return;
    enableKeys(true);
    $('#prompt').textContent = t('p_test');
    cdTimer = setInterval(() => {
      const left = plan.test.timeout_ms - (performance.now() - onset);
      $('#cbar').style.width = `${Math.max(0, (100 * left) / plan.test.timeout_ms)}%`;
    }, 100);
  }, Math.max(0, onset - performance.now()));
  taskTimer = setTimeout(() => answer(''), Math.max(0, onset - performance.now()) + plan.test.timeout_ms);
  app.querySelectorAll('.key').forEach((k) => {
    k.onclick = () => { haptic(); answer(k.dataset.n); };
  });
}

async function finishTest() {
  state.done = true;
  state.ft = Date.now();
  state.cur = -1;
  state.phase = 'done';
  await save();
  route();
}

async function screenDone() {
  const main = plan.kind === 'main';
  const correct = state.te.filter((e) => e[0] === e[1]).length;
  const pct = main ? `${Math.round((100 * correct) / plan.test.seq.length)}%` : '';
  app.innerHTML = `${header()}
    <main class="center">
      <div class="card hero">
        <div class="ornament gold">✦</div>
        <h1>${esc(main ? t('done_title') : t('title_extra'))}</h1>
        <p class="stat">${esc(main ? t('done_pct', { a: pct }) : t('done_extra', { t: mmss(state.trainMs) }))}</p>
        <p class="hint">${esc(t('done_send'))}</p>
      </div>
      <button class="btn-gold" id="send">${esc(t('send'))}</button>
      <pre id="dev" hidden></pre>
    </main>`;
  const send = async () => {
    $('#send').disabled = true;
    const prev = [];
    for (const sid of await pendingList()) {
      if (sid === plan.sid) continue;
      try {
        const old = JSON.parse((await store.get(keyState(sid))) || 'null');
        if (old && !(await store.get(keySent(sid))) && (old.segs?.length || old.te?.length || old.tr?.length)) prev.push(packState(old));
      } catch { /* skip broken */ }
    }
    const ua = inTelegram ? `tg-${tg.platform}-${tg.version}` : 'browser';
    const payload = buildPayload(state, plan.kind, audio.hash, ua, prev);
    window.__payload = payload;
    if (inTelegram) {
      await store.set(keySent(plan.sid), '1');
      for (const p of prev) { await store.set(keySent(p.sid), '1'); await store.del(keyState(p.sid)); }
      await store.del(keyState(plan.sid));
      await store.set(KEY_PENDING, '[]');
      tg.sendData(payload); // closes the Mini App; the bot receives the data as a message
    } else {
      const dev = $('#dev');
      dev.hidden = false;
      dev.textContent = `${t('dev_sent')}\n${payload}`;
    }
  };
  $('#send').onclick = send;
  if (inTelegram && tg.MainButton) {
    tg.MainButton.setParams({ text: t('send'), color: '#C9A24D', text_color: '#0B1530' });
    tg.MainButton.onClick(send);
    tg.MainButton.show();
  }
}

function route() {
  if (inTelegram) {
    try {
      if (['train', 'test'].includes(state.phase)) tg.enableClosingConfirmation();
      else tg.disableClosingConfirmation();
    } catch { /* old client */ }
  }
  if (!['welcome', 'train', 'testintro', 'test', 'done'].includes(state.phase)) state.phase = 'welcome';
  if ((state.phase === 'testintro' || state.phase === 'test') && !plan.test) state.phase = 'done';
  if (!audio.ready && state.phase !== 'done') return screenWelcome();
  ({ welcome: screenWelcome, train: screenTrain, testintro: screenTestIntro, test: screenTest, done: screenDone })[state.phase]();
}

// ---------- boot ----------
async function boot() {
  if (inTelegram) {
    tg.ready();
    tg.expand();
    try {
      tg.setHeaderColor('#0A1430');
      tg.setBackgroundColor('#0A1430');
      if (tg.isVersionAtLeast('7.7')) tg.disableVerticalSwipes();
    } catch { /* old client */ }
  }
  try {
    plan = decodePlan(params.get('s') || '', params.get('p') || '');
  } catch {
    t = makeT((navigator.language || 'en').slice(0, 2));
    screenMessage(t('bad_link'));
    return;
  }
  lang = plan.lang;
  t = makeT(lang);
  colors = { ...COLORS, ...(plan.palette || {}) };
  document.documentElement.lang = lang;
  store = makeStore();
  if (await store.get(keySent(plan.sid))) {
    screenMessage(t('already'));
    return;
  }
  state = { sid: plan.sid, phase: 'welcome', trainMs: 0, segs: [], seg: -1, demoDone: false, tr: [], te: [], cur: -1, st: 0, ft: 0, done: false };
  const saved = await store.get(keyState(plan.sid));
  if (saved) {
    try { Object.assign(state, JSON.parse(saved)); } catch { /* ignore corrupt */ }
    state.seg = -1; // the last stretch was cut off when the app closed: it stays marked as interrupted
  }
  route();
}

boot();
