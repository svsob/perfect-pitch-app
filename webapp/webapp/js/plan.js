// Decoding the session plan from the link and encoding the result for the bot.
// Mirrors ppbot/protocol.py (_keystream / encode_plan) and ppbot/service.py (result format).

export const NOTE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
export const COLORS = { A: '#E5403A', B: '#F28A2E', C: '#F4D03F', D: '#3DB86B', E: '#5CC6F0', F: '#2F66DD', G: '#8E52D9' };
export const SAMPLE_FILE = { A: 'A3', B: 'B3', C: 'C4', D: 'D4', E: 'E4', F: 'F4', G: 'G4' };
export const MODES = { c: 'cue', o: 'color', n: 'name' };

export function keystream(sid, n) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(sid)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let a = h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    t = (t ^ (t >>> 14)) >>> 0;
    out[i] = t & 0xff;
  }
  return out;
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodePlan(sid, token) {
  const data = b64urlToBytes(token);
  const ks = keystream(sid, data.length);
  for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
  const plan = JSON.parse(new TextDecoder().decode(data));
  if (plan.sid !== sid || plan.v !== 1) throw new Error('plan mismatch');
  return plan;
}

/** "cAoD..." -> [{mode:'cue', note:'A'}, ...] */
export function parseTrain(seq) {
  const out = [];
  for (let i = 0; i + 1 < seq.length; i += 2) out.push({ mode: MODES[seq[i]], code: seq[i], note: seq[i + 1] });
  return out;
}

export function trainEntry(code, target, resp, rt, replays) {
  return `${code}${target}${resp}${Math.max(0, Math.round(rt)).toString(36)}${replays ? 'r' + replays : ''}`;
}

export function testEntry(target, resp, rt, replays) {
  return `${target}${resp}${Math.max(0, Math.round(rt)).toString(36)}${replays ? 'r' + replays : ''}`;
}

/** Payload for Telegram.WebApp.sendData (max 4096 bytes): trims practice entries if needed. */
export function buildPayload(state, ua) {
  const tr = [...state.tr];
  const make = () => JSON.stringify({ v: 1, sid: state.sid, st: state.st, ft: state.ft || Date.now(),
    done: !!state.done, tr: tr.join('.'), te: state.te.join('.'), ua });
  let s = make();
  while (new TextEncoder().encode(s).length > 4000 && tr.length) {
    tr.pop();
    s = make();
  }
  return s;
}
