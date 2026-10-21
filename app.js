import { SR, toMono, denoise, detectBPM, findBackingSegment, applyFades, timeStretch, gatedRmsDb, encodeWav, encodeMp3 } from './dsp.js';
import { renderVocals, mixdown } from './engine.js';

const $ = id => document.getElementById(id);
let actx = null;
const audioCtx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR }));

const S = {
  vox: null, voxName: '', back: null, backName: '',
  backFull: null, backFullName: '', segInfo: null,
  bpmV: null, bpmB: null,
  denKey: '', den: null,
  toneKey: '', toned: null,
  stretchKey: '', stretched: null,
  mix: null, gen: 0, timer: null,
};

// ---- helpers ---------------------------------------------------------
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtMB = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
const sgn = v => (v > 0 ? '+' : '') + v;
function status(msg, busy) { const el = $('status'); el.textContent = msg; el.classList.toggle('busy', !!busy); }

async function decode(file) {
  const ab = await file.arrayBuffer();
  const buf = await audioCtx().decodeAudioData(ab);
  const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).slice());
  return chs;
}

function drawWave(canvas, chs, playFrac) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, Math.floor(canvas.clientWidth * dpr)), h = Math.floor(canvas.clientHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--wave').trim();
  if (chs) {
    const d = chs[0], n = d.length, per = n / w;
    if (!canvas._peaks || canvas._peaks.src !== d || canvas._peaks.w !== w) {
      const pk = new Float32Array(w);
      for (let x = 0; x < w; x++) { let m = 0; const s = Math.floor(x * per), e = Math.min(n, Math.floor((x + 1) * per)); const st = Math.max(1, Math.floor((e - s) / 64)); for (let i = s; i < e; i += st) { const v = Math.abs(d[i]); if (v > m) m = v; } pk[x] = m; }
      canvas._peaks = { src: d, w, pk };
    }
    const pk = canvas._peaks.pk;
    let mx = 0; for (let x = 0; x < w; x++) if (pk[x] > mx) mx = pk[x];
    const sc = mx > 0 ? 0.92 / mx : 1;
    for (let x = 0; x < w; x++) { const a = Math.max(1, pk[x] * sc * h / 2); g.fillRect(x, h / 2 - a, 1, a * 2); }
  }
  if (playFrac != null) { g.fillStyle = css.getPropertyValue('--accent').trim(); g.fillRect(Math.floor(playFrac * w), 0, Math.max(1, dpr), h); }
}

function refreshAutoButton() {
  $('autoEdit').disabled = !S.vox;
  $('autoHint').textContent = S.vox
    ? (S.backFull ? 'Ready. This takes a few seconds.' : 'Ready. Add a backing track first for a full mix.')
    : 'Load a vocal first. Add a backing track for a full mix.';
}

// ---- load files ------------------------------------------------------
async function loadVocal(file) {
  try {
    status('Reading vocal...', true);
    const chs = await decode(file);
    S.vox = toMono(chs); S.voxName = file.name; S.den = null; S.denKey = ''; S.toneKey = ''; S.stretchKey = '';
    $('nameVocal').textContent = `${file.name} (${fmtMB(file.size)})`;
    $('factsVocal').textContent = `${fmtTime(S.vox.length / SR)} long, ${chs.length === 1 ? 'mono' : 'stereo, mixed to mono'}`;
    drawWave($('wfVocal'), [S.vox]);
    const t = detectBPM(S.vox);
    S.bpmV = t ? Math.round(t.bpm * 10) / 10 : null;
    $('bpmV').value = S.bpmV ?? '';
    refreshAutoButton();
    schedule(0);
  } catch (e) { status('Could not read that file as audio. Try WAV or MP3.'); console.error(e); }
}

async function loadBack(file) {
  try {
    status('Reading backing track...', true);
    let chs = await decode(file);
    if (chs.length === 1) chs = [chs[0], chs[0]];
    S.backFull = [chs[0], chs[1]]; S.backFullName = file.name; S.segInfo = null;
    S.back = [chs[0], chs[1]]; S.backName = file.name; S.stretchKey = '';
    $('nameBack').textContent = `${file.name} (${fmtMB(file.size)})`;
    $('btnBackClear').hidden = false;
    $('btnFullBack').hidden = true;
    $('factsBack').textContent = `${fmtTime(S.back[0].length / SR)} long`;
    drawWave($('wfBack'), S.back);
    const t = detectBPM(toMono(S.back));
    S.bpmB = t ? Math.round(t.bpm * 10) / 10 : null;
    $('bpmB').value = S.bpmB ?? '';
    refreshAutoButton();
    schedule(0);
  } catch (e) { status('Could not read that file as audio. Try WAV or MP3.'); console.error(e); }
}

function clearBack() {
  S.back = null; S.backFull = null; S.segInfo = null; S.stretchKey = ''; S.stretched = null; S.bpmB = null; $('bpmB').value = '';
  $('nameBack').textContent = 'Instrumental, loop or full track. A long track is fine.'; $('factsBack').textContent = '';
  $('btnBackClear').hidden = true; $('btnFullBack').hidden = true; drawWave($('wfBack'), null);
  refreshAutoButton(); schedule(0);
}

// Cut a segment out of the full backing track, with fades, and make it the working backing.
function useSegment(startSec, lenSec, bpm) {
  const a = Math.round(startSec * SR), n = Math.round(lenSec * SR);
  const L = S.backFull[0].slice(a, a + n), R = S.backFull[1].slice(a, a + n);
  applyFades([L, R], Math.min(1.5, lenSec / 6), Math.min(3, lenSec / 3));
  S.back = [L, R]; S.segInfo = { startSec, endSec: startSec + L.length / SR };
  S.backName = `${S.backFullName} @${startSec.toFixed(2)}s`; S.stretchKey = '';
  S.bpmB = bpm ?? S.bpmB; $('bpmB').value = S.bpmB ?? '';
  $('factsBack').textContent = `Using ${fmtTime(S.segInfo.startSec)} to ${fmtTime(S.segInfo.endSec)} of ${S.backFullName}, faded in and out.`;
  $('btnFullBack').hidden = false;
  drawWave($('wfBack'), S.back);
}

function useFullBack() {
  if (!S.backFull) return;
  S.back = [S.backFull[0], S.backFull[1]]; S.backName = S.backFullName; S.segInfo = null; S.stretchKey = '';
  const t = detectBPM(toMono(S.back));
  S.bpmB = t ? Math.round(t.bpm * 10) / 10 : null; $('bpmB').value = S.bpmB ?? '';
  $('factsBack').textContent = `${fmtTime(S.back[0].length / SR)} long`;
  $('btnFullBack').hidden = true;
  drawWave($('wfBack'), S.back);
  schedule(0);
}

// ---- pipeline --------------------------------------------------------
function params() {
  return {
    nrOn: $('nrOn').checked, nr: +$('nrAmt').value / 100,
    lowCut: +$('lowCut').value, warmth: +$('warmth').value, presence: +$('presence').value, air: +$('air').value,
    comp: +$('comp').value, reverb: +$('reverb').value, reverbSeconds: +$('room').value,
    tempoOn: $('tempoOn').checked, offsetMs: +$('offset').value, musicDb: +$('music').value,
    duck: $('duck').checked, loop: $('loop').checked, xfade: $('xfade').checked, xfadeMs: +$('xfadeMs').value,
  };
}

function schedule(delay = 300) { clearTimeout(S.timer); S.timer = setTimeout(run, delay); }

async function run() {
  if (!S.vox) return;
  const gen = ++S.gen; const p = params();
  const stale = () => gen !== S.gen;
  try {
    // 1 noise removal
    const denKey = p.nrOn ? `nr${p.nr}` : 'off';
    let src = S.vox;
    if (p.nrOn && p.nr > 0) {
      if (S.denKey !== denKey || !S.den) {
        status('Removing noise... 0%', true);
        const d = await denoise(S.vox, p.nr, f => { if (!stale()) status(`Removing noise... ${Math.round(f * 100)}%`, true); });
        if (stale()) return;
        S.den = d; S.denKey = denKey; S.toneKey = '';
      }
      src = S.den;
    } else if (S.denKey !== 'off') { S.denKey = 'off'; S.den = null; S.toneKey = ''; }
    // 2 tone
    const toneKey = JSON.stringify([S.denKey, p.lowCut, p.warmth, p.presence, p.air, p.comp, p.reverb, p.reverb ? p.reverbSeconds : 0]);
    if (S.toneKey !== toneKey || !S.toned) {
      status('Shaping tone...', true);
      const t = await renderVocals(src, p);
      if (stale()) return;
      S.toned = t; S.toneKey = toneKey;
    }
    // 3 tempo match
    let backing = S.back, note = '';
    if (S.back && p.tempoOn && S.bpmV && S.bpmB) {
      let ratio = S.bpmB / S.bpmV;
      const clamped = Math.max(0.5, Math.min(2, ratio));
      if (clamped !== ratio) note = ' Out of the 0.5x to 2x range, so it was limited.';
      ratio = clamped;
      const key = `${S.backName}|${ratio.toFixed(4)}`;
      if (S.stretchKey !== key || !S.stretched) {
        status('Matching tempo... 0%', true);
        const st = await timeStretch(S.back, ratio, f => { if (!stale()) status(`Matching tempo... ${Math.round(f * 100)}%`, true); });
        if (stale()) return;
        S.stretched = st; S.stretchKey = key;
      }
      backing = Math.abs(ratio - 1) < 0.002 ? S.back : S.stretched;
      $('stretchNote').textContent = `Backing plays at ${(ratio === 1 ? 100 : 100 / ratio).toFixed(1)}% speed (${S.bpmB} to ${S.bpmV} BPM), pitch kept.${note}`;
    } else if (S.back) {
      $('stretchNote').textContent = 'Tempo match is off. Detected tempo is a guess; edit the numbers if it is off by half or double.';
    }
    // 4 mix
    status('Mixing...', true);
    await new Promise(r => setTimeout(r, 0));
    if (stale()) return;
    S.mix = mixdown(S.toned, backing, p);
    // original preview at matched loudness
    const og = Math.pow(10, (-20 - gatedRmsDb([S.vox])) / 20);
    const o = new Float32Array(S.vox.length); for (let i = 0; i < o.length; i++) o[i] = Math.max(-1, Math.min(1, S.vox[i] * og));
    S.orig = [o, o];
    onMixReady();
  } catch (e) { console.error(e); status('Something failed while processing: ' + (e.message || e)); }
}

// ---- Auto Edit ---------------------------------------------------------
const AUTO = { nrOn: true, nrAmt: 100, lowCut: 80, warmth: 0, presence: 2, air: 1.5, comp: 45, reverb: 12, room: 1.4, tempoOn: true, offset: 0, duck: true, xfade: true, xfadeMs: 300 };

function setCtl(id, v) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  el.dispatchEvent(new Event(el.type === 'checkbox' ? 'change' : 'input'));
}

function showAutoLog(lines) {
  const ul = $('autoResult');
  ul.innerHTML = '';
  for (const t of lines) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
  ul.hidden = false;
}

async function autoEdit() {
  if (!S.vox) return;
  audioCtx().resume(); // inside the click so playback can start by itself
  const btn = $('autoEdit'); btn.disabled = true;
  const log = [];
  try {
    // 1. reset the chain to the auto choices
    status('Auto Edit: setting up...', true);
    for (const [id, v] of Object.entries(AUTO)) setCtl(id, v);
    // 2. pick and cut the backing segment
    const vLenSec = S.vox.length / SR;
    const tail = 3.2; // room for the vocal tail plus the music fade out
    if (S.backFull) {
      const backSec = S.backFull[0].length / SR;
      if (backSec > vLenSec + tail + 2) {
        status('Auto Edit: finding the best part of the backing track... 0%', true);
        const seg = await findBackingSegment(toMono(S.backFull), vLenSec + tail, S.bpmV,
          f => status(`Auto Edit: finding the best part of the backing track... ${Math.round(f * 100)}%`, true));
        useSegment(seg.startSec, vLenSec + tail, seg.bpm ? Math.round(seg.bpm * 10) / 10 : null);
        setCtl('loop', false);
        const musicDb = seg.density > 0.12 ? -10 : seg.density > 0.05 ? -9 : -7.5;
        setCtl('music', musicDb);
        log.push(`Backing track is ${fmtTime(backSec)} long. Chose ${fmtTime(S.segInfo.startSec)} to ${fmtTime(S.segInfo.endSec)}: a steady section${seg.bpm ? ` at about ${Math.round(seg.bpm)} BPM` : ''}, starting on a beat, faded in and out.`);
        if (S.bpmV && S.bpmB && Math.abs(S.bpmB - S.bpmV) > 0.3) {
          log.push(`Tempo: backing ${S.bpmB} BPM matched to your vocal's ${S.bpmV} BPM, pitch kept.`);
        } else if (S.bpmV && S.bpmB) {
          log.push(`Tempo already matches (${S.bpmB} vs ${S.bpmV} BPM), no stretch needed.`);
        } else {
          log.push('Could not find a clear beat in the vocal or the backing, so no tempo matching. Set the BPM boxes under Advanced if you know them.');
        }
        log.push(`Music sits ${musicDb} dB under the vocal and ducks a little while you sing.`);
        log.push('Crossfade is on (300 ms) in case the backing loops; adjust it under Advanced.');
      } else {
        S.back = [S.backFull[0], S.backFull[1]]; S.backName = S.backFullName; S.segInfo = null; S.stretchKey = '';
        setCtl('loop', true);
        setCtl('music', -9);
        log.push(`Backing track (${fmtTime(backSec)}) is shorter than the vocal, so it loops to the full length, with a 300 ms crossfade on every join so the repeat has no click.`);
        if (S.bpmV && S.bpmB && Math.abs(S.bpmB - S.bpmV) > 0.3) log.push(`Tempo: backing ${S.bpmB} BPM matched to your vocal's ${S.bpmV} BPM, pitch kept.`);
      }
    }
    log.push('Cleaned the vocal: noise removal, low cut, gentle presence and air, compression, light reverb.');
    // 3. render everything, then play
    await run();
    if (S.mix) {
      P.offset = 0;
      play();
    }
    showAutoLog(log);
    refreshAutoButton();
  } catch (e) {
    console.error(e);
    status('Auto Edit failed: ' + (e.message || e));
    refreshAutoButton();
  }
}

// ---- player ----------------------------------------------------------
const P = { node: null, startedAt: 0, offset: 0, playing: false, buf: null, raf: 0 };
function currentBuffers() {
  const v = document.querySelector('input[name=src]:checked').value;
  return v === 'vox' ? S.toned : v === 'orig' ? S.orig : S.mix;
}
function makeBuf(chs) {
  const b = audioCtx().createBuffer(2, chs[0].length, SR);
  b.copyToChannel(chs[0], 0); b.copyToChannel(chs[1], 1); return b;
}
function duration() { const c = currentBuffers(); return c ? c[0].length / SR : 0; }
function position() { return P.playing ? Math.min(duration(), P.offset + audioCtx().currentTime - P.startedAt) : P.offset; }
function stopNode() { if (P.node) { P.node.onended = null; try { P.node.stop(); } catch { } P.node.disconnect(); P.node = null; } }
function pause() { if (!P.playing) return; P.offset = position(); stopNode(); P.playing = false; $('play').textContent = 'Play'; cancelAnimationFrame(P.raf); updateTime(); }
async function play() {
  const chs = currentBuffers(); if (!chs) return;
  await audioCtx().resume();
  stopNode();
  const n = audioCtx().createBufferSource(); n.buffer = makeBuf(chs); n.connect(audioCtx().destination);
  if (P.offset >= duration() - 0.05) P.offset = 0;
  n.start(0, P.offset); P.startedAt = audioCtx().currentTime; P.node = n; P.playing = true;
  n.onended = () => { if (P.node === n) { P.playing = false; P.offset = 0; P.node = null; $('play').textContent = 'Play'; updateTime(); } };
  $('play').textContent = 'Pause'; tickUI();
}
function tickUI() { cancelAnimationFrame(P.raf); const f = () => { updateTime(); if (P.playing) P.raf = requestAnimationFrame(f); }; f(); }
function updateTime() {
  const d = duration(); $('time').textContent = `${fmtTime(position())} / ${fmtTime(d)}`;
  drawWave($('wfMix'), currentBuffers(), d ? position() / d : 0);
}
function seekTo(frac) { const was = P.playing; if (was) { stopNode(); P.playing = false; } P.offset = frac * duration(); if (was) play(); else updateTime(); }

function onMixReady() {
  const wasPlaying = P.playing; const pos = position();
  if (wasPlaying) { stopNode(); P.playing = false; }
  P.offset = Math.min(pos, Math.max(0, duration() - 0.05));
  $('play').disabled = false; $('dlWav').disabled = false; $('dlMp3').disabled = false;
  const sec = S.mix[0].length / SR;
  $('sizeHint').textContent = `WAV about ${fmtMB(sec * SR * 4)}, MP3 about ${fmtMB(sec * (+$('kbps').value) * 125)}`;
  status('Ready. Changes re-render automatically.');
  if (wasPlaying) play(); else updateTime();
}

// ---- export ----------------------------------------------------------
function save(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const baseName = () => (S.voxName.replace(/\.[^.]+$/, '') || 'vocal') + '-polished';
$('dlWav').onclick = () => { if (S.mix) save(encodeWav(S.mix), baseName() + '.wav'); };
$('dlMp3').onclick = async () => {
  if (!S.mix) return;
  try {
    status('Encoding MP3... 0%', true);
    const b = await encodeMp3(S.mix, +$('kbps').value, SR, f => status(`Encoding MP3... ${Math.round(f * 100)}%`, true));
    save(b, baseName() + '.mp3'); status(`MP3 saved (${fmtMB(b.size)}).`);
  } catch (e) { status('MP3 encoding failed: ' + e.message); }
};
$('kbps').onchange = () => { if (S.mix) onMixReady(); };

// ---- wiring ----------------------------------------------------------
function bindDrop(zone, input, btn, handler) {
  btn.onclick = () => input.click();
  input.onchange = () => { if (input.files[0]) handler(input.files[0]); input.value = ''; };
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
}
bindDrop($('dropVocal'), $('fileVocal'), $('btnVocal'), loadVocal);
bindDrop($('dropBack'), $('fileBack'), $('btnBack'), loadBack);
$('btnBackClear').onclick = clearBack;
$('btnFullBack').onclick = useFullBack;
$('autoEdit').onclick = autoEdit;

const labels = {
  nrAmt: v => v + '%', lowCut: v => v + ' Hz', warmth: v => sgn(+v) + ' dB', presence: v => sgn(+v) + ' dB', air: v => sgn(+v) + ' dB',
  comp: v => v + '%', reverb: v => v + '%', room: v => (+v).toFixed(1) + ' s', offset: v => sgn(+v) + ' ms', music: v => v + ' dB', xfadeMs: v => v + ' ms',
};
for (const id of Object.keys(labels)) {
  const el = $(id), out = $(id + 'O');
  const upd = () => { out.textContent = labels[id](el.value); };
  el.addEventListener('input', () => { upd(); schedule(id === 'offset' || id === 'music' ? 120 : 350); });
  upd();
}
for (const id of ['nrOn', 'tempoOn', 'duck', 'loop', 'xfade']) $(id).addEventListener('change', () => schedule(0));
$('bpmV').addEventListener('change', () => { S.bpmV = parseFloat($('bpmV').value) || null; schedule(200); });
$('bpmB').addEventListener('change', () => { S.bpmB = parseFloat($('bpmB').value) || null; schedule(200); });
document.querySelectorAll('[data-bpm]').forEach(b => b.onclick = () => {
  const k = b.dataset.bpm === 'v' ? 'bpmV' : 'bpmB'; if (!S[k]) return;
  S[k] = Math.round(Math.max(40, Math.min(220, S[k] * +b.dataset.f)) * 10) / 10; $(k).value = S[k]; schedule(100);
});
document.querySelectorAll('[data-nudge]').forEach(b => b.onclick = () => {
  const el = $('offset'); el.value = Math.max(-1000, Math.min(1000, +el.value + +b.dataset.nudge)); el.dispatchEvent(new Event('input'));
});
$('play').onclick = () => (P.playing ? pause() : play());
document.querySelectorAll('input[name=src]').forEach(r => r.onchange = () => { const w = P.playing; const frac = duration() ? position() / duration() : 0; if (w) { stopNode(); P.playing = false; } P.offset = 0; const d = duration(); P.offset = frac * d; if (w) play(); else updateTime(); });
$('wfMix').addEventListener('click', e => { if (!S.mix) return; const r = e.currentTarget.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width); });
window.addEventListener('resize', () => { drawWave($('wfVocal'), S.vox ? [S.vox] : null); drawWave($('wfBack'), S.back); updateTime(); });
refreshAutoButton();
window.__vp = { S, params, run, autoEdit, findBackingSegment, useSegment };
