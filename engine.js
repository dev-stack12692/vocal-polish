import { SR, gatedRmsDb, peak, activityEnvelope, toMono, loopWithCrossfade } from './dsp.js';

function impulse(ctx, seconds, decayPow) {
  const n = Math.floor(seconds * SR);
  const b = ctx.createBuffer(2, n, SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // darker tail: one-pole low-pass that closes as the tail decays
      const k = 0.25 + 0.7 * (1 - t);
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - t, decayPow) * (i < 480 ? i / 480 : 1);
    }
  }
  return b;
}

// Vocal chain: low cut -> warmth -> presence -> air -> compressor -> reverb send.
// Returns stereo Float32 arrays, normalised to a fixed gated loudness so the mixer can balance against music.
export async function renderVocals(mono, p) {
  const tail = p.reverb > 0 ? p.reverbSeconds : 0.05;
  const len = mono.length + Math.floor(tail * SR);
  const ctx = new OfflineAudioContext(2, len, SR);
  const buf = ctx.createBuffer(1, mono.length, SR);
  buf.copyToChannel(mono, 0);
  const src = ctx.createBufferSource(); src.buffer = buf;

  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = p.lowCut; hp.Q.value = 0.707;
  const warm = ctx.createBiquadFilter(); warm.type = 'lowshelf'; warm.frequency.value = 220; warm.gain.value = p.warmth;
  const pres = ctx.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = p.presence;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 10000; air.gain.value = p.air;
  const comp = ctx.createDynamicsCompressor();
  const a = p.comp / 100;
  comp.threshold.value = -18 - 14 * a; comp.knee.value = 12; comp.ratio.value = 1 + 7 * a;
  comp.attack.value = 0.008; comp.release.value = 0.18;

  src.connect(hp); hp.connect(warm); warm.connect(pres); pres.connect(air); air.connect(comp);
  const dry = ctx.createGain(); dry.gain.value = 1;
  comp.connect(dry); dry.connect(ctx.destination);
  if (p.reverb > 0) {
    const conv = ctx.createConvolver(); conv.buffer = impulse(ctx, p.reverbSeconds, 2.6);
    const send = ctx.createGain(); send.gain.value = 0.55 * (p.reverb / 100);
    comp.connect(send); send.connect(conv); conv.connect(ctx.destination);
  }
  src.start();
  const out = await ctx.startRendering();
  const chs = [out.getChannelData(0), out.getChannelData(1)];
  // fixed loudness target: -20 dB gated RMS
  const g = Math.pow(10, (-20 - gatedRmsDb(chs)) / 20);
  const res = chs.map(c => { const o = new Float32Array(c.length); for (let i = 0; i < o.length; i++) o[i] = c[i] * g; return o; });
  return res;
}

// vocals: stereo (already shifted? no, shifted here). backing: stereo or null (already tempo-matched).
// p: musicDb (relative to vocals), duck (bool), loop (bool), offsetMs (+ = vocals later)
export function mixdown(vocals, backing, p) {
  const off = Math.round(p.offsetMs / 1000 * SR);
  const vStart = off > 0 ? off : 0;   // vocal later: push the vocal
  const bStart = off < 0 ? -off : 0;  // vocal earlier: push the backing, so nothing is cut off
  const vLen = vocals[0].length;
  const vEnd = vStart + vLen;
  const total = backing ? (p.loop ? vEnd : Math.max(vEnd, bStart + backing[0].length)) : vEnd;
  const L = new Float32Array(total), R = new Float32Array(total);
  for (let i = 0; i < vLen; i++) { L[vStart + i] += vocals[0][i]; R[vStart + i] += vocals[1][i]; }

  if (backing) {
    // Loop mode: pre-build the repeated backing with an equal-power crossfade
    // on every join (length from p.xfadeMs, 0 or off = hard joins).
    let src = backing;
    if (p.loop && backing[0].length < total - bStart) {
      src = loopWithCrossfade(backing, total - bStart, p.xfade ? p.xfadeMs / 1000 : 0, SR);
    }
    const bl = src[0].length;
    const gain = Math.pow(10, (-20 + p.musicDb - gatedRmsDb(src)) / 20);
    const duck = p.duck ? activityEnvelope(toMono([L, R])) : null;
    const duckGain = Math.pow(10, -4 / 20);
    for (let i = bStart; i < total; i++) {
      const k = i - bStart;
      if (k >= bl) break;
      let g = gain;
      if (duck) { const a = duck[(i / 480) | 0] || 0; g *= 1 - a * (1 - duckGain); }
      L[i] += src[0][k] * g; R[i] += src[1][k] * g;
    }
    if (p.loop) {
      const f = Math.min(total, Math.floor(0.25 * SR));
      for (let i = 0; i < f; i++) { const k = i / f; L[total - 1 - i] *= k; R[total - 1 - i] *= k; }
    }
  }
  const pk = peak([L, R]);
  const target = Math.pow(10, -1 / 20);
  if (pk > 0) { const g = target / pk; for (let i = 0; i < total; i++) { L[i] *= g; R[i] *= g; } }
  return [L, R];
}
