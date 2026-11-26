// Decoding the session plan from the link and encoding the result for the bot.
// Mirrors ppbot/protocol.py (_keystream / encode_plan) and ppbot/service.py (_SEG_RE / _TEST_RE).

export const NOTE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
export const COLORS = { A: '#E5403A', B: '#F28A2E', C: '#F4D03F', D: '#3DB86B', E: '#5CC6F0', F: '#2F66DD', G: '#8E52D9' };
export const SAMPLE_FILE = { A: 'A3', B: 'B3', C: 'C4', D: 'D4', E: 'E4', F: 'F4', G: 'G4' };

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
  if (plan.sid !== sid || plan.v !== 2) throw new Error('plan mismatch');
  return plan;
}

/** Training segment -> "start36,end36,active36,interrupted,cA-cB-...-cG". */
export function segEntry(seg) {
  return [Math.round(seg.s).toString(36), Math.round(seg.e).toString(36), Math.round(seg.a).toString(36),
    seg.i ? 1 : 0, seg.c.join('-')].join(',');
}

/** Test task -> target + response (X = timeout) + reaction time in base 36 (empty for a timeout). */
export function testEntry(target, resp, rt) {
  return resp ? `${target}${resp}${Math.max(0, Math.round(rt)).toString(36)}` : `${target}X`;
}

export function packState(st) {
  return { sid: st.sid, segs: st.segs.map(segEntry).join(';'), tr: (st.tr || []).join('.'), te: st.te.join('.'), done: !!st.done };
}

/** Payload for Telegram.WebApp.sendData (max 4096 bytes). Older unsent sessions go along in `prev`. */
export function buildPayload(st, kind, snd, ua, prev = []) {
  const extra = [...prev];
  const make = () => JSON.stringify({ v: 2, ...packState(st), kind, snd, ua, prev: extra });
  let s = make();
  while (new TextEncoder().encode(s).length > 4000 && extra.length) {
    extra.shift();
    s = make();
  }
  // a very long extra training: keep the newest guesses (the bot also gets the counts per note)
  const st2 = { ...st, tr: [...(st.tr || [])] };
  let pos = 0; // place in the plan's training order of the first guess that is kept
  while (new TextEncoder().encode(s).length > 4000 && st2.tr.length) {
    const cut = st2.tr.splice(0, 20);
    pos += cut.filter((e) => e[0] !== 'r').length;
    s = JSON.stringify({ v: 2, ...packState(st2), kind, snd, ua, prev: extra,
      tr_cut: (st.tr || []).length - st2.tr.length, tr_pos: pos });
  }
  return s;
}
