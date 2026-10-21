import { SR, toMono, denoise, detectBPM, timeStretch, gatedRmsDb, encodeWav, encodeMp3 } from './dsp.js';
import { renderVocals, mixdown } from './engine.js';

const $ = id => document.getElementById(id);
let actx = null;
const audioCtx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR }));

const S = {
  vox: null, voxName: '', back: null, backName: '',
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
    schedule(0);
  } catch (e) { status('Could not read that file as audio. Try WAV or MP3.'); console.error(e); }
}

async function loadBack(file) {
  try {
    status('Reading backing track...', true);
    let chs = await decode(file);
    if (chs.length === 1) chs = [chs[0], chs[0]];
    S.back = [chs[0], chs[1]]; S.backName = file.name; S.stretchKey = '';
    $('nameBack').textContent = `${file.name} (${fmtMB(file.size)})`;
    $('btnBackClear').hidden = false;
    $('factsBack').textContent = `${fmtTime(S.back[0].length / SR)} long`;
    drawWave($('wfBack'), S.back);
    const t = detectBPM(toMono(S.back));
    S.bpmB = t ? Math.round(t.bpm * 10) / 10 : null;
    $('bpmB').value = S.bpmB ?? '';
    schedule(0);
  } catch (e) { status('Could not read that file as audio. Try WAV or MP3.'); console.error(e); }
}

function clearBack() {
  S.back = null; S.stretchKey = ''; S.stretched = null; S.bpmB = null; $('bpmB').value = '';
  $('nameBack').textContent = 'Instrumental, loop or full track.'; $('factsBack').textContent = '';
  $('btnBackClear').hidden = true; drawWave($('wfBack'), null); schedule(0);
}

// ---- pipeline --------------------------------------------------------
function params() {
  return {
    nrOn: $('nrOn').checked, nr: +$('nrAmt').value / 100,
    lowCut: +$('lowCut').value, warmth: +$('warmth').value, presence: +$('presence').value, air: +$('air').value,
    comp: +$('comp').value, reverb: +$('reverb').value, reverbSeconds: +$('room').value,
    tempoOn: $('tempoOn').checked, offsetMs: +$('offset').value, musicDb: +$('music').value,
    duck: $('duck').checked, loop: $('loop').checked,
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

const labels = {
  nrAmt: v => v + '%', lowCut: v => v + ' Hz', warmth: v => sgn(+v) + ' dB', presence: v => sgn(+v) + ' dB', air: v => sgn(+v) + ' dB',
  comp: v => v + '%', reverb: v => v + '%', room: v => (+v).toFixed(1) + ' s', offset: v => sgn(+v) + ' ms', music: v => v + ' dB',
};
for (const id of Object.keys(labels)) {
  const el = $(id), out = $(id + 'O');
  const upd = () => { out.textContent = labels[id](el.value); };
  el.addEventListener('input', () => { upd(); schedule(id === 'offset' || id === 'music' ? 120 : 350); });
  upd();
}
for (const id of ['nrOn', 'tempoOn', 'duck', 'loop']) $(id).addEventListener('change', () => schedule(0));
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
window.__vp = { S, params, run };
