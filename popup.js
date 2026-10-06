const $ = (id) => document.getElementById(id);
let editingId = null;
const isHit = (p) => p.lastPrice != null && (p.mode === 'lt' ? p.lastPrice < p.target : p.lastPrice <= p.target);
const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function parseBR(s) {
  s = String(s).trim().replace(/R\$\s?/i, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function cleanUrl(u) {
  try {
    const x = new URL(u);
    x.search = ''; x.hash = '';
    return x.toString();
  } catch { return null; }
}

function ago(t) {
  if (!t) return 'nunca';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'agora há pouco';
  if (m < 60) return `há ${m} min`;
  return `há ${Math.round(m / 60)} h`;
}

async function load() {
  const { products = [] } = await chrome.storage.local.get('products');
  return products;
}
let writeChain = Promise.resolve();
function mutate(fn) {
  writeChain = writeChain.then(async () => {
    const products = await load();
    fn(products);
    await chrome.storage.local.set({ products });
  });
  return writeChain;
}

async function render() {
  const products = await load();
  const meta = await getMeta();
  const list = $('list');
  list.textContent = '';
  if (!products.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Nenhum produto monitorado ainda.';
    list.append(d);
    return;
  }
  for (const p of products) {
    const hit = isHit(p);
    const el = document.createElement('div');
    el.className = 'item' + (hit ? ' hit' : '') + (p.id === editingId ? ' editing' : '');

    const name = document.createElement('div');
    name.className = 'name';
    const a = document.createElement('a');
    a.href = p.url; a.target = '_blank';
    a.textContent = p.name || p.url;
    a.title = p.name || p.url;
    name.append(a);

    const price = document.createElement('div');
    price.className = 'price' + (hit ? ' hit' : '');
    price.textContent = p.lastPrice != null ? fmt(p.lastPrice) : '—';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const status = p.lastStatus && p.lastStatus.startsWith('erro') ? ` · ${p.lastStatus}` : '';
    meta.textContent =
      `alvo ${p.mode === 'lt' ? '< ' : '≤ '}${fmt(p.target)} · menor visto ${p.lowest != null ? fmt(p.lowest) : '—'} · ` +
      `a cada ${p.interval} min · última ${ago(p.lastCheck)}` +
      (p.stock != null ? ` · estoque ${p.stock}` : '') + ` · som: ${meta[p.id] || 'padrão'}` + status;
    if (status) meta.classList.add('err');

    const tools = document.createElement('div');
    tools.className = 'tools';
    const bCheck = document.createElement('button');
    bCheck.textContent = 'Verificar agora';
    bCheck.onclick = async () => {
      bCheck.disabled = true; bCheck.textContent = 'Verificando…';
      await chrome.runtime.sendMessage({ type: 'checkNow', id: p.id });
      render();
    };
    const bEdit = document.createElement('button');
    bEdit.textContent = 'Editar';
    bEdit.onclick = () => startEdit(p);
    const bPlay = document.createElement('button');
    bPlay.textContent = '▶';
    bPlay.title = 'Ouvir o alerta deste produto (voz ou som, conforme a configuração)';
    bPlay.onclick = async () => {
      const { voice = {} } = await chrome.storage.local.get('voice');
      if (voice.enabled) speakPreview(p);   // voz ligada: fala o nome
      else previewSound(p.id);              // voz desligada: toca o som
    };
    const bDel = document.createElement('button');
    bDel.textContent = 'Remover';
    bDel.onclick = async () => {
      // guarda o produto (e o som dele) na lixeira antes de excluir, para poder desfazer
      const sk = 'sound:' + p.id;
      const snd = (await chrome.storage.local.get(sk))[sk] || null;
      let idx = -1;
      await mutate((ps) => { idx = ps.findIndex((x) => x.id === p.id); if (idx >= 0) ps.splice(idx, 1); });
      if (idx >= 0) {
        const { trash = [] } = await chrome.storage.local.get('trash');
        trash.push({ product: p, idx, sound: snd, at: Date.now() });
        await chrome.storage.local.set({ trash: trash.filter((t) => Date.now() - t.at < UNDO_MS).slice(-10) });
      }
      await removeSound(p.id);
      render();
    };
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = p.enabled !== false;
    cb.onchange = () => mutate((ps) => { const x = ps.find((y) => y.id === p.id); if (x) x.enabled = cb.checked; });
    lab.append(cb, 'ativo');
    tools.append(bCheck, bEdit, bPlay, bDel, lab);

    el.append(name, price, meta, tools);
    list.append(el);
  }
}

// ---------- sons (arquivos do PC guardados no storage da extensão) ----------
const MAX_SOUND = 3 * 1024 * 1024; // 3 MB por arquivo
let pendingFile = null;
let clearSound = false;
let previewAudio = null;

async function getMeta() {
  const { soundmeta = {} } = await chrome.storage.local.get('soundmeta');
  return soundmeta;
}
function readDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
async function saveSound(key, file) {
  const dataUrl = await readDataUrl(file);
  const meta = await getMeta();
  meta[key] = file.name;
  await chrome.storage.local.set({ ['sound:' + key]: { name: file.name, dataUrl }, soundmeta: meta });
}
async function removeSound(key) {
  const meta = await getMeta();
  delete meta[key];
  await chrome.storage.local.remove('sound:' + key);
  await chrome.storage.local.set({ soundmeta: meta });
}
function speakPreview(p) {
  if (previewAudio) previewAudio.pause();
  speechSynthesis.cancel();
  const nome = String(p.name || p.url).replace(/\s+/g, ' ').trim().slice(0, 90);
  const preco = p.lastPrice != null ? ` Preço ${Number(p.lastPrice).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}.` : '';
  const u = new SpeechSynthesisUtterance(`Atenção! ${nome} está com desconto.${preco}`);
  u.lang = 'pt-BR';
  const v = speechSynthesis.getVoices().find((x) => /^pt[-_]BR/i.test(x.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}
async function previewSound(key) {
  const k = 'sound:' + key;
  const s = await chrome.storage.local.get([k, 'sound:default']);
  const own = key === 'captcha' || key === 'coupon';
  const snd = s[k] || (own ? null : s['sound:default']);
  const src = snd ? snd.dataUrl : chrome.runtime.getURL(own ? `sounds/${key}.mp3` : 'sounds/alert.mp3');
  if (previewAudio) previewAudio.pause();
  previewAudio = new Audio(src);
  previewAudio.play().catch(() => alert('Não consegui tocar esse arquivo.'));
  setTimeout(() => previewAudio && previewAudio.pause(), 5000);
}
function okSize(file) {
  if (file.size > MAX_SOUND) { alert('Arquivo muito grande (máx. 3 MB). Escolha um som mais curto.'); return false; }
  return true;
}

async function updateSoundInfo() {
  const meta = await getMeta();
  const cur = editingId ? meta[editingId] : null;
  let txt, showClear = false;
  if (pendingFile) { txt = `Novo som: ${pendingFile.name}`; showClear = true; }
  else if (clearSound) txt = 'Vai voltar a usar o som padrão ao salvar.';
  else if (cur) { txt = `Som atual: ${cur}`; showClear = true; }
  else txt = meta.default ? `Usando o som padrão (${meta.default}).` : 'Usando o som padrão da extensão.';
  $('soundInfo').textContent = txt;
  $('soundClear').hidden = !showClear;

  $('defInfo').textContent = meta.default ? `Atual: ${meta.default}` : 'Usando o som padrão da extensão.';
  $('defClear').hidden = !meta.default;

  $('capInfo').textContent = meta.captcha ? `Atual: ${meta.captcha}` : 'Usando o som de verificação padrão da extensão.';
  $('capClear').hidden = !meta.captcha;

  $('cpSndInfo').textContent = meta.coupon ? `Atual: ${meta.coupon}` : 'Usando o som de cupom padrão da extensão.';
  $('cpSndClear').hidden = !meta.coupon;
}

$('soundFile').onchange = () => {
  const f = $('soundFile').files[0];
  if (f && !okSize(f)) { $('soundFile').value = ''; return; }
  pendingFile = f || null;
  if (f) clearSound = false;
  updateSoundInfo();
};
$('soundClear').onclick = () => {
  $('soundFile').value = '';
  if (pendingFile) pendingFile = null;
  else clearSound = true;
  updateSoundInfo();
};
$('defFile').onchange = async () => {
  const f = $('defFile').files[0];
  if (!f) return;
  if (!okSize(f)) { $('defFile').value = ''; return; }
  await saveSound('default', f);
  $('defFile').value = '';
  updateSoundInfo();
};
$('defClear').onclick = async () => { await removeSound('default'); updateSoundInfo(); };
$('defPlay').onclick = () => previewSound('default');

$('useTab').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /shopee\.com\.br/.test(tab.url)) {
    $('url').value = cleanUrl(tab.url) || tab.url;
    if (!$('name').value && tab.title) $('name').value = tab.title.replace(/\s*\|\s*Shopee.*$/i, '');
  } else {
    alert('A aba atual não é uma página da Shopee.');
  }
};

function startEdit(p) {
  editingId = p.id;
  $('url').value = p.url;
  $('name').value = p.customName ? p.name : '';
  $('target').value = String(p.target).replace('.', ',');
  $('interval').value = p.interval;
  $('mode').value = p.mode === 'lt' ? 'lt' : 'lte';
  $('submit').textContent = 'Salvar alterações';
  $('cancel').hidden = false;
  pendingFile = null; clearSound = false; $('soundFile').value = '';
  updateSoundInfo();
  render();
}

function resetForm() {
  editingId = null;
  const iv = $('interval').value;
  $('f').reset();
  $('interval').value = iv || 15;
  $('submit').textContent = 'Adicionar';
  $('cancel').hidden = true;
  pendingFile = null; clearSound = false;
  updateSoundInfo();
  render();
}
$('cancel').onclick = resetForm;

$('f').onsubmit = async (e) => {
  e.preventDefault();
  const url = cleanUrl($('url').value.trim());
  const target = parseBR($('target').value);
  const interval = Math.max(1, parseInt($('interval').value, 10) || 15);
  const mode = $('mode').value === 'lt' ? 'lt' : 'lte';
  if (!url || !/shopee\.com\.br/.test(url)) return alert('URL inválida (precisa ser shopee.com.br).');
  if (target == null) return alert('Preço alvo inválido.');
  const name = $('name').value.trim();

  if (editingId) {
    const id = editingId;
    await mutate((ps) => {
      const p = ps.find((x) => x.id === id);
      if (!p) return;
      const urlChanged = p.url !== url;
      p.url = url; p.target = target; p.interval = interval; p.mode = mode;
      if (name) { p.name = name; p.customName = true; }
      else { p.customName = false; if (urlChanged) p.name = url; }
      // regra mudou: reavalia do zero (pode avisar de novo se já estiver dentro da regra)
      p.alerted = false; p.alertedPrice = null;
      if (urlChanged) { p.lastPrice = null; p.lowest = null; p.history = []; }
    });
    if (pendingFile) await saveSound(id, pendingFile);
    else if (clearSound) await removeSound(id);
    resetForm();
    chrome.runtime.sendMessage({ type: 'checkNow', id }).then(render);
    return;
  }

  const id = crypto.randomUUID();
  await mutate((ps) => ps.push({
    id, url, name: name || url, customName: !!name, target, interval, mode,
    enabled: true, lastPrice: null, lowest: null, lastCheck: null, lastStatus: 'aguardando 1ª checagem', history: [],
    alerted: false, alertedPrice: null,
  }));
  if (pendingFile) await saveSound(id, pendingFile);
  resetForm();
  chrome.runtime.sendMessage({ type: 'checkNow', id }).then(render);
};

$('stop').onclick = () => chrome.runtime.sendMessage({ type: 'stopSound' });
chrome.storage.local.get('voice').then(({ voice = {} }) => { $('voiceOn').checked = !!voice.enabled; });
chrome.storage.local.get('autoScroll').then(({ autoScroll = {} }) => { $('autoScrollOn').checked = autoScroll.enabled !== false; });
$('autoScrollOn').onchange = () => chrome.storage.local.set({ autoScroll: { enabled: $('autoScrollOn').checked } });
$('voiceOn').onchange = () => chrome.storage.local.set({ voice: { enabled: $('voiceOn').checked } });
$('test').onclick = () => chrome.runtime.sendMessage({ type: 'testAlert' });

// Desfazer exclusão: restaura o último produto removido (guarda até 10).
const UNDO_MS = 15000;
let undoTimer = null;
async function updateUndo() {
  let { trash = [] } = await chrome.storage.local.get('trash');
  const live = trash.filter((t) => Date.now() - t.at < UNDO_MS);
  if (live.length !== trash.length) { trash = live; await chrome.storage.local.set({ trash }); }
  const bar = $('undoBar');
  bar.hidden = !trash.length;
  clearTimeout(undoTimer);
  if (trash.length) {
    const last = trash[trash.length - 1];
    const n = last.product;
    $('undoText').textContent = `Removido: ${String(n.name || n.url).slice(0, 40)}${trash.length > 1 ? ` (+${trash.length - 1})` : ''}`;
    undoTimer = setTimeout(updateUndo, Math.max(200, UNDO_MS - (Date.now() - last.at) + 50)); // some após 15 s
  }
}
$('undoBtn').onclick = async () => {
  const { trash = [] } = await chrome.storage.local.get('trash');
  const live = trash.filter((x) => Date.now() - x.at < UNDO_MS);
  const t = live.pop();
  if (!t) { await chrome.storage.local.set({ trash: [] }); return; }
  trash.length = 0; trash.push(...live);
  await mutate((ps) => { if (!ps.some((x) => x.id === t.product.id)) ps.splice(Math.min(t.idx, ps.length), 0, t.product); });
  if (t.sound) {
    const meta = await getMeta();
    meta[t.product.id] = t.sound.name;
    await chrome.storage.local.set({ ['sound:' + t.product.id]: t.sound, soundmeta: meta });
  }
  await chrome.storage.local.set({ trash });
  render();
};
chrome.storage.onChanged.addListener(() => { render(); updateSoundInfo(); updateUndo(); });
updateUndo();
render();
updateSoundInfo();


// Aviso de pausa por verificação (captcha)
(function () {
  const box = document.getElementById('cap');
  const show = async () => {
    const { captcha } = await chrome.storage.local.get('captcha');
    box.hidden = !captcha;
  };
  document.getElementById('capResume').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'resumeCaptcha' }).then(show).catch(() => {});
  });
  chrome.storage.onChanged.addListener((c) => { if (c.captcha) show(); });
  show();
})();


// Som geral da verificação (captcha)
$('capFile').onchange = async () => {
  const f = $('capFile').files[0];
  if (!f) return;
  if (!okSize(f)) { $('capFile').value = ''; return; }
  await saveSound('captcha', f);
  $('capFile').value = '';
  updateSoundInfo();
};
$('capClear').onclick = async () => { await removeSound('captcha'); updateSoundInfo(); };
$('capPlay').onclick = () => previewSound('captcha');


// Abas do popup
(function () {
  const tabs = document.querySelectorAll('.tab');
  const show = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.getElementById('pane-prod').hidden = name !== 'prod';
    document.getElementById('pane-cfg').hidden = name !== 'cfg';
    chrome.storage.local.set({ popupTab: name }).catch(() => {});
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  chrome.storage.local.get('popupTab').then(({ popupTab }) => { if (popupTab) show(popupTab); }).catch(() => {});
})();


// Monitor de cupons
(function () {
  const $c = (id) => document.getElementById(id);
  const ago = (t) => { if (!t) return 'nunca'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'agora' : `há ${m} min`; };
  async function load(fillForm) {
    const { coupon } = await chrome.storage.local.get('coupon');
    const c = coupon || {};
    if (fillForm) {
      $c('cpUrl').value = c.url || '';
      $c('cpName').value = c.name || '';
      $c('cpValue').value = c.value || '';
      $c('cpMode').value = c.mode === 'gte' ? 'gte' : 'eq';
      $c('cpInterval').value = String(c.interval || 15);
      $c('cpOn').checked = !!c.enabled;
    }
    const st = c.lastStatus ? ` · ${c.lastStatus}` : '';
    $c('cpInfo').textContent = c.enabled
      ? `Ativo · última checagem ${ago(c.lastCheck)}${st}`
      : (c.lastStatus ? `Desativado (checagem manual)${st}` : 'Desativado.');
  }
  $c('cpSave').onclick = async () => {
    const url = $c('cpUrl').value.trim();
    const value = $c('cpValue').value.trim();
    const name = $c('cpName').value.trim();
    const on = $c('cpOn').checked;
    if (on && (!/^https:\/\/([\w-]+\.)*shopee\.com\.br\//.test(url) || !value)) {
      return alert('Para ativar, informe um link de shopee.com.br e o valor do cupom.');
    }
    const { coupon = {} } = await chrome.storage.local.get('coupon');
    await chrome.storage.local.set({ coupon: { ...coupon, url, value, name, mode: $c('cpMode').value, interval: Number($c('cpInterval').value), enabled: on, lastCheck: null, alerted: false, lastStatus: '' } });
    load(false);
  };
  $c('cpNow').onclick = async () => {
    const url = $c('cpUrl').value.trim();
    const value = $c('cpValue').value.trim();
    if (!/^https:\/\/([\w-]+\.)*shopee\.com\.br\//.test(url) || !value) {
      return alert('Informe um link de shopee.com.br e o valor do cupom.');
    }
    const { coupon = {} } = await chrome.storage.local.get('coupon');
    await chrome.storage.local.set({ coupon: { ...coupon, url, value, name: $c('cpName').value.trim(), mode: $c('cpMode').value, interval: Number($c('cpInterval').value), enabled: $c('cpOn').checked, lastStatus: 'na fila…' } });
    chrome.runtime.sendMessage({ type: 'checkCoupon' }).then(() => load(false)).catch(() => load(false));
  };
  chrome.storage.onChanged.addListener((ch) => { if (ch.coupon) load(false); });
  load(true);
})();


// Som do cupom encontrado
$('cpSndFile').onchange = async () => {
  const f = $('cpSndFile').files[0];
  if (!f) return;
  if (!okSize(f)) { $('cpSndFile').value = ''; return; }
  await saveSound('coupon', f);
  $('cpSndFile').value = '';
  updateSoundInfo();
};
$('cpSndClear').onclick = async () => { await removeSound('coupon'); updateSoundInfo(); };
$('cpSndPlay').onclick = () => previewSound('coupon');


// Integração com o Home Assistant
(function () {
  const $h = (id) => document.getElementById(id);
  const ago = (t) => { if (!t) return 'nunca'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'agora' : `há ${m} min`; };
  async function load(fill) {
    const { ha } = await chrome.storage.local.get('ha');
    const c = ha || {};
    if (fill) {
      $h('haOn').checked = !!c.enabled;
      $h('haUrl').value = c.url || 'http://homeassistant.local';
      $h('haToken').value = c.token || '';
      $h('haNotify').value = c.notify || '';
    }
    $h('haInfo').textContent = !c.enabled ? 'Desativado.' : `Ativo${c.lastStatus ? ' · ' + c.lastStatus : ''}${c.lastSync ? ' · sincronizado ' + ago(c.lastSync) : ''}`;
    $h('haInfo').classList.toggle('err', !!(c.lastStatus && c.lastStatus.startsWith('erro')));
  }
  function normUrl(u) {
    u = u.trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
    try { const x = new URL(u); return x.origin; } catch { return null; }
  }
  // Salva e pede ao Chrome permissão para falar com o endereço do HA (precisa vir de um clique).
  async function save() {
    const on = $h('haOn').checked;
    const url = normUrl($h('haUrl').value || 'http://homeassistant.local');
    const token = $h('haToken').value.trim();
    if (on && (!url || !token)) { alert('Para ativar, informe o endereço do Home Assistant (ex.: http://homeassistant.local) e o token.'); return false; }
    if (url) {
      const u = new URL(url);
      const granted = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] }).catch(() => false);
      if (!granted && on) { alert('O Chrome precisa de permissão para acessar esse endereço. Tente salvar de novo e aceite.'); return false; }
    }
    const { ha = {} } = await chrome.storage.local.get('ha');
    await chrome.storage.local.set({ ha: { ...ha, enabled: on, url: url || '', token, notify: $h('haNotify').value.trim(), lastStatus: '' } });
    if (url) $h('haUrl').value = url;
    return true;
  }
  $h('haSave').onclick = async () => {
    if (!(await save())) return;
    if ($h('haOn').checked) await chrome.runtime.sendMessage({ type: 'haSync' }).catch(() => {});
    load(false);
  };
  $h('haTest').onclick = async () => {
    $h('haOn').checked = true;
    if (!(await save())) return;
    $h('haInfo').textContent = 'testando…';
    const r = await chrome.runtime.sendMessage({ type: 'haTest' }).catch((e) => ({ ok: false, error: String(e) }));
    await load(false);
    if (r && !r.ok) $h('haInfo').textContent = 'erro: ' + (r.error || 'falhou');
  };
  chrome.storage.onChanged.addListener((ch) => { if (ch.ha) load(false); });
  load(true);
})();
