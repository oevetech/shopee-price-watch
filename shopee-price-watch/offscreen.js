// Página offscreen: toca o alarme (service worker não pode tocar áudio).
// Se receber um arquivo de som (data URL) toca em loop; senão usa o beep embutido.
let ctx = null;
let timer = null;
let beatTimer = null;
let stopTimer = null;
let audio = null;
let speakTimer = null;

function beep(freq, startAt, dur) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.value = 0.15;
  o.connect(g);
  g.connect(ctx.destination);
  o.start(startAt);
  o.stop(startAt + dur);
}

function pattern() {
  const t = ctx.currentTime;
  beep(988, t, 0.18);
  beep(1319, t + 0.25, 0.18);
  beep(988, t + 0.5, 0.18);
  beep(1319, t + 0.75, 0.3);
}

function startBeeps() {
  ctx = new AudioContext();
  ctx.resume();
  pattern();
  timer = setInterval(pattern, 2000);
}

function play(src) {
  stop();
  if (src) {
    audio = new Audio(src);
    audio.loop = true;
    audio.play().catch(() => { audio = null; startBeeps(); }); // arquivo inválido -> beep
  } else {
    startBeeps();
  }
  stopTimer = setTimeout(stop, 60000); // toca no máximo 1 minuto
  // Confere se a notificação ainda está na tela; se foi fechada, para o som.
  beatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'soundHeartbeat' })
      .then((r) => { if (r && r.active === false) stop(); })
      .catch(() => {});
  }, 2000);
}

// Voz: fala o texto (pt-BR) e repete até silenciar / fechar a notificação / 1 minuto.
function speakOnce(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR';
  const v = speechSynthesis.getVoices().find((x) => /^pt[-_]BR/i.test(x.lang));
  if (v) u.voice = v;
  u.rate = 1;
  speechSynthesis.speak(u);
}

function speak(text, repeat = true) {
  stop();
  speakOnce(text);
  if (!repeat) return;
  speakTimer = setInterval(() => { if (!speechSynthesis.speaking) speakOnce(text); }, 5000);
  stopTimer = setTimeout(stop, 60000);
  beatTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'soundHeartbeat' })
      .then((r) => { if (r && r.active === false) stop(); })
      .catch(() => {});
  }, 2000);
}

function stop() {
  clearInterval(speakTimer); speakTimer = null;
  try { speechSynthesis.cancel(); } catch (e) {}
  clearInterval(timer);
  clearInterval(beatTimer);
  clearTimeout(stopTimer);
  timer = beatTimer = stopTimer = null;
  if (audio) { audio.pause(); audio = null; }
  if (ctx) { ctx.close().catch(() => {}); ctx = null; }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.cmd === 'play') play(msg.src || null);
  if (msg.cmd === 'speak') speak(msg.text || '', msg.repeat !== false);
  if (msg.cmd === 'stop') stop();
});
