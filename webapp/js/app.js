// Perfect Pitch Mini App: plays the session plan the bot put into the link and returns the answers.
import { Audio } from './audio.js';
import { COLORS, NOTE_IDS, buildPayload, decodePlan, parseTrain, testEntry, trainEntry } from './plan.js';
import { makeT, noteName } from './i18n.js';

const tg = window.Telegram?.WebApp;
const inTelegram = !!(tg && tg.initData);
const params = new URLSearchParams(location.search);
const FAST = params.get('fast') === '1'; // local testing: 20-second practice
const app = document.getElementById('app');
const audio = new Audio('sounds/');

let plan, t, lang, trainTrials = [], state, store;

// ---------- storage (Telegram CloudStorage, else localStorage) ----------
function makeStore() {
  const cloud = inTelegram && tg.isVersionAtLeast?.('6.9') && tg.CloudStorage;
  const ls = {
    get: (k) => Promise.resolve((() => { try { return localStorage.getItem(k); } catch { return null; } })()),
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } return Promise.resolve(); },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } return Promise.resolve(); },
  };
  if (!cloud) return ls;
  return {
    get: (k) => new Promise((ok) => cloud.getItem(k, (err, v) => ok(err ? null : v || null))),
    set: (k, v) => new Promise((ok) => cloud.setItem(k, v, () => ok())),
    del: (k) => new Promise((ok) => cloud.removeItem(k, () => ok())),
  };
}
const keyState = () => `pp_${plan.sid}`;
const keyDone = () => `ppdone_${plan.sid}`;
const save = () => store.set(keyState(), JSON.stringify(state));

// ---------- helpers ----------
const $ = (sel) => app.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (xs) => (xs.length ? `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}%` : '—');
const haptic = (kind) => {
  try {
    if (!inTelegram) return;
    if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success');
    else if (kind === 'bad') tg.HapticFeedback.notificationOccurred('error');
    else tg.HapticFeedback.impactOccurred('light');
  } catch { /* old client */ }
};
function confirmBox(text) {
  if (inTelegram && tg.isVersionAtLeast?.('6.2')) return new Promise((ok) => tg.showConfirm(text, ok));
  return Promise.resolve(window.confirm(text));
}

function header(sub) {
  const lv = plan.kind === 'baseline' || plan.kind === 'final' ? '' : ` · ${t('level', { l: plan.level })}`;
  return `<header class="top"><div class="brand">PERFECT&nbsp;PITCH</div>
    <div class="eyebrow">${esc(t('day', { d: plan.day }))}${esc(lv)}${sub ? ' · ' + esc(sub) : ''}</div></header>`;
}

/** All seven notes are always the answer options: coloured squares with the Latin name in black. */
function keysHtml(today = []) {
  return `<div class="keys">${NOTE_IDS.map((n) => {
    const mark = today.includes(n) ? ' today' : '';
    return `<button class="key${mark}" data-n="${n}" style="--k:${COLORS[n]}" disabled><span>${esc(noteName(lang, n))}</span></button>`;
  }).join('')}</div>`;
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
}

// ---------- screens ----------
function screenError(msg) {
  app.innerHTML = `<main class="center"><div class="card"><div class="brand">PERFECT&nbsp;PITCH</div><p>${esc(msg)}</p></div></main>`;
}

function screenWelcome() {
  const dots = plan.notes.map((n) => `<i style="--k:${COLORS[n]}" title="${esc(noteName(lang, n))}"></i>`).join('');
  const showColors = plan.kind === 'daily' || plan.kind === 'weekly';
  app.innerHTML = `${header()}
    <main class="center">
      <div class="card hero">
        <h1>${esc(t('title_' + plan.kind))}</h1>
        <p class="lead">${esc(t('lead_' + plan.kind))}</p>
        ${showColors ? `<div class="dots">${dots}</div>` : '<div class="ornament">♪</div>'}
        <p class="hint">🔊 ${esc(t('sound_hint'))}</p>
      </div>
      <div class="bar" id="loadbar" hidden><i></i></div>
      <button class="btn-gold" id="start">${esc(t('start'))}</button>
    </main>`;
  $('#start').onclick = async () => {
    const btn = $('#start');
    btn.disabled = true;
    btn.textContent = t('loading');
    $('#loadbar').hidden = false;
    try {
      await audio.unlock();
      await audio.load((f) => { $('#loadbar i').style.width = `${Math.round(f * 100)}%`; });
    } catch (e) {
      screenError(`${t('loading')} ✕ ${e.message}`);
      return;
    }
    if (!state.st) state.st = Date.now();
    if (state.phase === 'welcome') state.phase = plan.intro ? 'intro' : plan.train ? 'train' : 'testintro';
    await save();
    route();
  };
}

function screenIntro() {
  const heard = new Set();
  app.innerHTML = `${header(t('intro_title'))}
    <main class="stage">
      <p class="prompt">${esc(t('intro_text'))}</p>
      <div class="orb" id="orb"><span class="label"></span><span class="mark"></span></div>
      <div class="spacer"></div>
      ${keysHtml(plan.notes)}
      <button class="btn-gold" id="next" disabled>${esc(t('next'))}</button>
    </main>`;
  enableKeys(true);
  app.querySelectorAll('.key').forEach((k) => {
    k.onclick = () => {
      const n = k.dataset.n;
      audio.playNote(n, 0.01);
      haptic();
      setOrb(COLORS[n], noteName(lang, n));
      k.classList.remove('pulse'); void k.offsetWidth; k.classList.add('pulse');
      heard.add(n);
      if (plan.notes.every((x) => heard.has(x))) $('#next').disabled = false;
    };
  });
  $('#next').onclick = async () => {
    state.phase = 'train';
    await save();
    route();
  };
}

// ---------- practice ----------
let ticker = null;
function trainSeconds() { return FAST ? 20 : plan.train.secs; }

function screenTrain() {
  app.innerHTML = `${header()}
    <main class="stage">
      <div class="row"><div class="timer" id="timer"></div><button class="link" id="stop">${esc(t('stop'))}</button></div>
      <div class="bar"><i id="tbar"></i></div>
      <p class="prompt" id="prompt"></p>
      <div class="orb" id="orb"><span class="label"></span><span class="mark"></span></div>
      <div class="under"><button class="ghost" id="replay">${esc(t('replay'))}</button><div class="score" id="score"></div></div>
      <div class="spacer"></div>
      <div id="keyswrap"></div>
    </main>`;
  $('#stop').onclick = stopEarly;
  let last = performance.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    const now = performance.now();
    if (!document.hidden && state.phase === 'train') state.trainMs += now - last;
    last = now;
    const left = Math.max(0, trainSeconds() * 1000 - state.trainMs);
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    const el = $('#timer');
    if (el) el.textContent = t('time_left', { m, s: String(s).padStart(2, '0') });
    const bar = $('#tbar');
    if (bar) bar.style.width = `${Math.min(100, (100 * state.trainMs) / (trainSeconds() * 1000))}%`;
  }, 250);
  nextTrain();
}

function nextTrain() {
  if (state.phase !== 'train') return;
  if (state.trainMs >= trainSeconds() * 1000 || state.ti >= trainTrials.length) {
    clearInterval(ticker);
    state.phase = 'testintro';
    save().then(route);
    return;
  }
  const trial = trainTrials[state.ti];
  $('#keyswrap').innerHTML = keysHtml();
  $('#prompt').textContent = t(trial.mode === 'cue' ? 'p_cue' : 'p_test');
  setOrb(trial.mode === 'cue' ? COLORS[trial.note] : '', '', trial.mode === 'cue' ? '' : '?');
  const ok = state.tr.filter((e) => e[1] === e[2]).length;
  $('#score').textContent = state.tr.length ? `✓ ${ok} / ${state.tr.length}` : '';
  let replays = 0;
  let onset = audio.playNote(trial.note, 0.3);
  const enableAt = setTimeout(() => enableKeys(true), Math.max(0, onset - performance.now()));
  $('#replay').onclick = () => { replays += 1; audio.playNote(trial.note, 0.05); };
  app.querySelectorAll('.key').forEach((k) => {
    k.onclick = () => {
      clearTimeout(enableAt);
      enableKeys(false);
      $('#replay').onclick = null;
      const resp = k.dataset.n;
      const rt = performance.now() - onset;
      const right = resp === trial.note;
      state.tr.push(trainEntry(trial.code, trial.note, resp, rt, replays));
      state.ti += 1;
      save();
      const correctKey = app.querySelector(`.key[data-n="${trial.note}"]`);
      correctKey.classList.add('correct');
      if (!right) {
        k.classList.add('wrong');
        haptic('bad');
        setTimeout(() => audio.playNote(trial.note, 0.02), 250);
      } else haptic('ok');
      setOrb(COLORS[trial.note], noteName(lang, trial.note), right ? '✓' : '');
      $('#prompt').textContent = right ? t('right') : t('wrong', { n: noteName(lang, trial.note) });
      setTimeout(nextTrain, right ? 750 : 1700);
    };
  });
}

// ---------- test ----------
function screenTestIntro() {
  const type = plan.test.type;
  app.innerHTML = `${header()}
    <main class="center">
      <div class="card hero">
        <h1>${esc(t(type === 'full' ? 'test_title_full' : 'test_title_check'))}</h1>
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
  app.innerHTML = `${header(t(plan.test.type === 'full' ? 'test_title_full' : 'test_title_check'))}
    <main class="stage">
      <div class="bar"><i id="tbar"></i></div>
      <p class="prompt">${esc(t('p_test'))}</p>
      <div class="orb neutral" id="orb"><span class="label"></span><span class="mark">?</span></div>
      <div class="under"><button class="ghost" id="replay">${esc(t('replay'))}</button><div class="score" id="score"></div></div>
      <div class="spacer"></div>
      ${keysHtml()}
    </main>`;
  nextTest();
}

function playMasked(note) {
  const len = audio.playMask(0.25);
  return audio.playNote(note, 0.25 + len + 0.35);
}

function nextTest() {
  const seq = plan.test.seq;
  const i = state.te.length;
  $('#tbar').style.width = `${(100 * i) / seq.length}%`;
  $('#score').textContent = `${i + 1} / ${seq.length}`;
  if (i >= seq.length) {
    finish(true);
    return;
  }
  const note = seq[i];
  setOrb('', '', '?');
  let replays = 0;
  let onset = playMasked(note);
  let enableAt = setTimeout(() => enableKeys(true), Math.max(0, onset - performance.now()));
  $('#replay').onclick = () => {
    replays += 1;
    enableKeys(false);
    clearTimeout(enableAt);
    onset = playMasked(note);
    enableAt = setTimeout(() => enableKeys(true), Math.max(0, onset - performance.now()));
  };
  app.querySelectorAll('.key').forEach((k) => {
    k.onclick = () => {
      clearTimeout(enableAt);
      enableKeys(false);
      $('#replay').onclick = null;
      state.te.push(testEntry(note, k.dataset.n, performance.now() - onset, replays));
      save();
      haptic();
      k.classList.add('picked');
      setOrb('', t('accepted'), '·');
      setTimeout(nextTest, 500);
    };
  });
}

// ---------- end ----------
async function stopEarly() {
  if (!(await confirmBox(t('stop_confirm')))) return;
  finish(false);
}

async function finish(done) {
  clearInterval(ticker);
  state.done = done;
  state.ft = Date.now();
  state.phase = 'done';
  await save();
  route();
}

function screenDone() {
  const trOk = state.tr.map((e) => e[1] === e[2]);
  const teOk = state.te.map((e) => e[0] === e[1]);
  app.innerHTML = `${header()}
    <main class="center">
      <div class="card hero">
        <div class="ornament gold">✦</div>
        <h1>${esc(t('done_title'))}</h1>
        ${trOk.length ? `<p class="stat">${esc(t('done_train', { n: trOk.length, a: pct(trOk) }))}</p>` : ''}
        ${teOk.length ? `<p class="stat">${esc(t('done_test', { a: pct(teOk) }))}</p>` : ''}
        <p class="hint">${esc(t('done_send'))}</p>
      </div>
      <button class="btn-gold" id="send">${esc(t('send'))}</button>
      <pre id="dev" hidden></pre>
    </main>`;
  const send = async () => {
    const payload = buildPayload(state, inTelegram ? `tg-${tg.platform}-${tg.version}` : 'browser');
    await store.set(keyDone(), '1');
    await store.del(keyState());
    window.__payload = payload;
    if (inTelegram) {
      tg.sendData(payload); // closes the Mini App; the bot receives the data as a message
    } else {
      const dev = $('#dev');
      dev.hidden = false;
      dev.textContent = `${t('dev_sent')}\n${payload}`;
      $('#send').disabled = true;
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
      if (['intro', 'train', 'test'].includes(state.phase)) tg.enableClosingConfirmation();
      else tg.disableClosingConfirmation();
    } catch { /* old client */ }
  }
  const audioReady = audio.ctx && Object.keys(audio.buffers).length === 7;
  if (!audioReady && state.phase !== 'done') return screenWelcome();
  ({ welcome: screenWelcome, intro: screenIntro, train: screenTrain, testintro: screenTestIntro, test: screenTest,
    done: screenDone })[state.phase]();
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
    screenError(t('bad_link'));
    return;
  }
  lang = plan.lang;
  t = makeT(lang);
  document.documentElement.lang = lang;
  trainTrials = plan.train ? parseTrain(plan.train.seq) : [];
  store = makeStore();
  if (await store.get(keyDone())) {
    screenError(t('already'));
    return;
  }
  const saved = await store.get(keyState());
  state = { sid: plan.sid, phase: 'welcome', ti: 0, trainMs: 0, tr: [], te: [], st: 0, ft: 0, done: false };
  if (saved) {
    try { Object.assign(state, JSON.parse(saved)); } catch { /* ignore corrupt */ }
  }
  route();
}

boot();
