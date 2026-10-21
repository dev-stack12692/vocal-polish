// Pure DSP helpers. No UI code in here. All audio is Float32Array at SR.
export const SR = 48000;

export function toMono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, o = new Float32Array(n);
  for (let c = 0; c < chs.length; c++) { const d = chs[c]; for (let i = 0; i < n; i++) o[i] += d[i] / chs.length; }
  return o;
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ---- RNNoise ---------------------------------------------------------
let rnPromise = null;
function loadRnnoise() {
  if (!rnPromise) rnPromise = import('./rnnoise.js').then(m =>
    m.default({ locateFile: p => new URL('./' + p, import.meta.url).href }));
  return rnPromise;
}

// x: mono Float32 at 48 kHz. strength 0..1 blends cleaned and original.
export async function denoise(x, strength, onProgress) {
  const M = await loadRnnoise();
  const F = 480;
  const st = M._rnnoise_create();
  const ptr = M._malloc(F * 4);
  const out = new Float32Array(x.length);
  const frames = Math.ceil(x.length / F);
  // The first frames of RNNoise are a warm-up; run the first second twice so the start is not muffled.
  const warm = Math.min(frames, 100);
  const run = (i, write) => {
    const base = ptr >> 2, heap = M.HEAPF32, s = i * F;
    for (let k = 0; k < F; k++) heap[base + k] = (x[s + k] || 0) * 32768;
    M._rnnoise_process_frame(st, ptr, ptr);
    if (write) { const h2 = M.HEAPF32; for (let k = 0; k < F && s + k < x.length; k++) out[s + k] = h2[base + k] / 32768; }
  };
  for (let i = 0; i < warm; i++) run(i, false);
  for (let i = 0; i < frames; i++) {
    run(i, true);
    if (i % 400 === 0) { onProgress && onProgress(i / frames); await tick(); }
  }
  M._rnnoise_destroy(st); M._free(ptr);
  if (strength >= 0.999) return out;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = out[i] * strength + x[i] * (1 - strength);
  return y;
}

// ---- Onset envelope + tempo detection ----------------------------------
const ONSET_HOP = 512, ONSET_WIN = 1024;

// Onset strength envelope of a mono signal. Returns { env, fps, n } or null.
export function onsetEnvelope(x, sr = SR) {
  const hop = ONSET_HOP, win = ONSET_WIN;
  const n = Math.floor((x.length - win) / hop);
  if (n < 1) return null;
  const lowE = new Float32Array(n), hiE = new Float32Array(n);
  let lpState = 0;
  const a = Math.exp(-2 * Math.PI * 200 / sr);
  for (let f = 0; f < n; f++) {
    let le = 0, he = 0;
    const s = f * hop;
    for (let i = 0; i < win; i += 2) {
      const v = x[s + i];
      lpState = a * lpState + (1 - a) * v;
      le += lpState * lpState;
      const d = v - (x[s + i - 1] || 0);
      he += d * d;
    }
    lowE[f] = Math.log(1 + 1000 * le / (win / 2));
    hiE[f] = Math.log(1 + 1000 * he / (win / 2));
  }
  const onset = new Float32Array(n);
  for (let f = 1; f < n; f++) onset[f] = Math.max(0, lowE[f] - lowE[f - 1]) + Math.max(0, hiE[f] - hiE[f - 1]);
  // remove local mean
  const sm = new Float32Array(n);
  const W = 43;
  let acc = 0;
  for (let f = 0; f < n; f++) { acc += onset[f]; if (f >= W) acc -= onset[f - W]; sm[f] = acc / Math.min(f + 1, W); }
  const env = new Float32Array(n);
  for (let f = 0; f < n; f++) env[f] = Math.max(0, onset[f] - sm[f]);
  return { env, fps: sr / hop, n };
}

// Tempo of one envelope slice via autocorrelation with a soft prior near 110 BPM.
function bpmFromEnv(env, fps, off, len) {
  if (len < 100) return null;
  const lagMin = Math.floor(fps * 60 / 200), lagMax = Math.ceil(fps * 60 / 55);
  const ac = new Float32Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0; for (let i = off + lag; i < off + len; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (len - lag);
  }
  let best = -1, bestScore = 0, mean = 0, cnt = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) { mean += ac[lag]; cnt++; }
  mean /= cnt;
  const score = lag => {
    const bpm = 60 * fps / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.8, 2));
    const h = ac[lag] + 0.5 * (ac[lag * 2] || 0) + 0.25 * (ac[lag * 4] || 0);
    return h * prior;
  };
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
      const sc = score(lag); if (sc > bestScore) { bestScore = sc; best = lag; }
    }
  }
  if (best < 0) return null;
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
  const den = (y0 - 2 * y1 + y2);
  const o = den ? 0.5 * (y0 - y2) / den : 0;
  const lag = best + Math.max(-0.5, Math.min(0.5, o));
  let bpm = 60 * fps / lag;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const conf = Math.max(0, Math.min(1, (ac[best] / (mean || 1) - 1) / 4));
  return { bpm, confidence: conf };
}

export function detectBPM(x, sr = SR) {
  const oe = onsetEnvelope(x, sr);
  if (!oe || oe.n < 200) return null;
  return bpmFromEnv(oe.env, oe.fps, 0, oe.n);
}

// ---- Backing segment search --------------------------------------------
// Pick the segSec-long window of a (possibly long) mono backing track that
// best fits a vocal: close tempo, steady typical energy, starting on a beat.
// Returns { startSec, bpm, density, searched } (searched = false when the
// track is barely longer than the window and position 0 is used).
export async function findBackingSegment(x, segSec, vocalBpm, onProgress, sr = SR) {
  const oe = onsetEnvelope(x, sr);
  if (!oe) return { startSec: 0, bpm: null, density: 0, searched: false };
  const { env, fps, n } = oe;
  const W = Math.max(16, Math.round(segSec * fps));
  if (n <= W + Math.round(2 * fps)) {
    const t = bpmFromEnv(env, fps, 0, n);
    return { startSec: 0, bpm: t ? t.bpm : null, density: 0, searched: false };
  }
  // per-frame signal energy, aligned to the envelope frames
  const hop = ONSET_HOP;
  const fe = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0; const s = f * hop;
    for (let i = 0; i < hop; i += 2) { const v = x[s + i] || 0; e += v * v; }
    fe[f] = Math.sqrt(e / (hop / 2));
  }
  let envMean = 0; for (let f = 0; f < n; f++) envMean += env[f]; envMean /= n;
  const denseThr = envMean * 0.5;
  const hopF = Math.max(1, Math.round(0.5 * fps));
  const starts = [];
  for (let s = 0; s + W <= n; s += hopF) starts.push(s);
  const K = starts.length;
  const winE = new Float32Array(K), winDen = new Float32Array(K);
  const winBpm = new Array(K).fill(null);
  for (let k = 0; k < K; k++) {
    const s = starts[k];
    let e = 0, dense = 0;
    for (let i = s; i < s + W; i++) { e += fe[i]; if (env[i] > denseThr) dense++; }
    winE[k] = e / W; winDen[k] = dense / W;
    const t = bpmFromEnv(env, fps, s, W);
    winBpm[k] = t ? t.bpm : null;
    if (k % 40 === 39) { onProgress && onProgress(k / K); await tick(); }
  }
  // energy target: 65th percentile of window energies (typical, not intro-quiet, not the loudest peak)
  const sorted = Array.from(winE).sort((a, b) => a - b);
  const tE = sorted[Math.floor(sorted.length * 0.65)] || 1;
  let bestK = 0, bestSc = -1;
  for (let k = 0; k < K; k++) {
    const es = Math.exp(-0.5 * Math.pow(Math.log((winE[k] + 1e-9) / (tE + 1e-9)) / 0.6, 2));
    let ts;
    if (vocalBpm && winBpm[k]) ts = Math.exp(-0.5 * Math.pow(Math.log2(winBpm[k] / vocalBpm) / 0.22, 2));
    else if (vocalBpm) ts = 0.35;
    else ts = 0.6;
    const sc = ts * (0.35 + 0.65 * es);
    if (sc > bestSc) { bestSc = sc; bestK = k; }
  }
  // snap the start to the strongest beat within +/-0.6 s
  let s = starts[bestK];
  const R = Math.round(0.6 * fps);
  const lo = Math.max(0, s - R), hi = Math.min(n - W, s + R);
  let bs = s, bv = -1;
  for (let i = lo; i <= hi; i++) {
    const v = env[i] + (env[i + 1] || 0) + (env[i + 2] || 0);
    if (v > bv) { bv = v; bs = i; }
  }
  return { startSec: bs / fps, bpm: winBpm[bestK], density: winDen[bestK], searched: true };
}

// Equal-power fades, in place, on each channel.
export function applyFades(chs, fadeInSec, fadeOutSec, sr = SR) {
  const n = chs[0].length;
  const fi = Math.min(n >> 2, Math.round(fadeInSec * sr));
  const fo = Math.min(n >> 1, Math.round(fadeOutSec * sr));
  for (const d of chs) {
    for (let i = 0; i < fi; i++) { const g = Math.sin(0.5 * Math.PI * i / fi); d[i] *= g * g; }
    for (let i = 0; i < fo; i++) { const g = Math.sin(0.5 * Math.PI * (i + 1) / fo); d[n - 1 - i] *= g * g; }
  }
  return chs;
}


// Tile a (possibly short) loop out to `total` samples. When xfadeSec > 0 the
// repeats overlap and blend with an equal-power crossfade, so the join has no
// click and the loop's own tail melts into its next start.
export function loopWithCrossfade(chs, total, xfadeSec, sr = SR) {
  const bl = chs[0].length, nc = chs.length;
  let X = Math.min(Math.round(xfadeSec * sr), bl >> 1);
  if (X < 128 || total <= bl) {
    const out = chs.map(() => new Float32Array(total));
    for (let c = 0; c < nc; c++) for (let i = 0; i < total; i++) out[c][i] = chs[c][i % bl];
    return out;
  }
  const stride = bl - X;
  const reps = Math.max(1, Math.ceil((total - bl) / stride) + 1);
  const outLen = bl + (reps - 1) * stride;
  const out = chs.map(() => new Float32Array(outLen));
  for (let r = 0; r < reps; r++) {
    const base = r * stride;
    for (let c = 0; c < nc; c++) {
      const src = chs[c], dst = out[c];
      for (let i = 0; i < bl; i++) {
        let g = 1;
        if (r > 0 && i < X) g = Math.sin(0.5 * Math.PI * (i / X));
        if (i >= bl - X && base + i < outLen) g = Math.min(g, Math.cos(0.5 * Math.PI * ((i - (bl - X)) / X)));
        dst[base + i] += src[i] * g;
      }
    }
  }
  return out.map(o => o.subarray(0, total));
}

// ---- Time stretch (WSOLA), pitch preserved ---------------------------
// chs: array of Float32Array. ratio = outLen / inLen (>1 slower).
export async function timeStretch(chs, ratio, onProgress) {
  if (Math.abs(ratio - 1) < 0.002) return chs;
  const N = 2048, Hs = 1024, S = 384;
  const len = chs[0].length;
  const outLen = Math.round(len * ratio);
  const Ha = Hs / ratio;
  // decimated mono copy for alignment search
  const D = 4;
  const mono = toMono(chs);
  const dl = Math.floor(len / D);
  const dm = new Float32Array(dl);
  for (let i = 0; i < dl; i++) { let s = 0; for (let k = 0; k < D; k++) s += mono[i * D + k]; dm[i] = s / D; }
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const outs = chs.map(() => new Float32Array(outLen + N));
  const frames = Math.ceil(outLen / Hs);
  let prevStart = 0;
  const OL = Hs / D, SD = S / D;
  for (let k = 0; k < frames; k++) {
    const target = Math.round(k * Ha);
    let start = target;
    if (k > 0) {
      const ref = prevStart + Hs; // natural continuation in the input
      const refD = Math.floor(ref / D);
      let bestC = -Infinity, bestOff = 0;
      for (let o = -SD; o <= SD; o++) {
        const c0 = Math.floor(target / D) + o;
        if (c0 < 0 || c0 + OL >= dl || refD + OL >= dl) continue;
        let c = 0;
        for (let i = 0; i < OL; i += 2) c += dm[c0 + i] * dm[refD + i];
        if (c > bestC) { bestC = c; bestOff = o; }
      }
      start = target + bestOff * D;
    }
    if (start < 0) start = 0;
    const oPos = k * Hs;
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = outs[c];
      for (let i = 0; i < N; i++) {
        const si = start + i; if (si >= len) break;
        dst[oPos + i] += src[si] * win[i];
      }
    }
    prevStart = start;
    if (k % 300 === 0) { onProgress && onProgress(k / frames); await tick(); }
  }
  return outs.map(o => o.subarray(0, outLen));
}

// ---- Level helpers ---------------------------------------------------
// Gated RMS in dBFS: blocks of 400 ms, ignore blocks > 35 dB below the loudest.
export function gatedRmsDb(chs) {
  const n = chs[0].length, B = Math.round(0.4 * SR);
  const ms = [];
  for (let s = 0; s + B <= n; s += B) {
    let e = 0;
    for (const d of chs) for (let i = s; i < s + B; i += 3) e += d[i] * d[i];
    ms.push(e / (B / 3) / chs.length);
  }
  if (!ms.length) { let e = 0; for (const d of chs) for (let i = 0; i < n; i++) e += d[i] * d[i]; return 10 * Math.log10(e / n / chs.length + 1e-12); }
  const mx = Math.max(...ms);
  const kept = ms.filter(v => v > mx * 3.2e-4);
  const avg = kept.reduce((a, b) => a + b, 0) / kept.length;
  return 10 * Math.log10(avg + 1e-12);
}

export function peak(chs) { let p = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > p) p = v; } return p; }

// Smoothed vocal activity envelope 0..1 (one value per sample would be heavy; per 480 samples).
export function activityEnvelope(x) {
  const F = 480, n = Math.ceil(x.length / F), env = new Float32Array(n);
  let mx = 0;
  for (let f = 0; f < n; f++) { let e = 0; const s = f * F; for (let i = 0; i < F && s + i < x.length; i++) e += x[s + i] * x[s + i]; env[f] = Math.sqrt(e / F); if (env[f] > mx) mx = env[f]; }
  const thr = mx * 0.06;
  const act = new Float32Array(n);
  let st = 0;
  for (let f = 0; f < n; f++) {
    const t = env[f] > thr ? 1 : 0;
    st += (t > st ? 0.35 : 0.02) * (t - st); // fast attack, ~0.5 s release
    act[f] = st;
  }
  return act;
}

// ---- Encoders --------------------------------------------------------
export function encodeWav(chs, sr = SR) {
  const n = chs[0].length, nc = chs.length;
  const buf = new ArrayBuffer(44 + n * nc * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * nc * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, chs[c][i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let lameLoad = null;
function loadLame() {
  if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
  if (!lameLoad) lameLoad = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('./lame.min.js', import.meta.url).href;
    s.onload = res; s.onerror = () => rej(new Error('Could not load the MP3 encoder'));
    document.head.appendChild(s);
  });
  return lameLoad;
}

export async function encodeMp3(chs, kbps, sr = SR, onProgress) {
  await loadLame();
  const lame = (typeof lamejs === 'function' && !lamejs.Mp3Encoder) ? lamejs() : lamejs;
  const nc = chs.length;
  const enc = new lame.Mp3Encoder(nc, sr, kbps);
  const toI16 = a => { const o = new Int16Array(a.length); for (let i = 0; i < a.length; i++) { const s = Math.max(-1, Math.min(1, a[i])); o[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; };
  const L = toI16(chs[0]), R = nc > 1 ? toI16(chs[1]) : null;
  const parts = [], B = 1152 * 20;
  for (let i = 0; i < L.length; i += B) {
    const d = nc > 1 ? enc.encodeBuffer(L.subarray(i, i + B), R.subarray(i, i + B)) : enc.encodeBuffer(L.subarray(i, i + B));
    if (d.length) parts.push(new Uint8Array(d));
    if ((i / B) % 25 === 0) { onProgress && onProgress(i / L.length); await tick(); }
  }
  const e = enc.flush(); if (e.length) parts.push(new Uint8Array(e));
  return new Blob(parts, { type: 'audio/mpeg' });
}
