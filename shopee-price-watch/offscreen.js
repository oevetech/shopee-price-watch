// Página offscreen: toca o alarme (service worker não pode tocar áudio).
// Se receber um arquivo de som (data URL) toca em loop; senão usa o beep embutido.
let ctx = null;
let timer = null;
let beatTimer = null;
let stopTimer = null;
let audio = null;

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

function stop() {
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
  if (msg.cmd === 'stop') stop();
});
