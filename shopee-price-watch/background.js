// Shopee Price Watch — service worker (MV3)
// Um alarme de 1 min dispara; cada produto tem seu próprio intervalo e só é checado quando vence.

const TICK = 'shopee-tick';
const MIN_INTERVAL = 1; // minutos

// ---------- storage (escritas serializadas) ----------
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}
async function getProducts() {
  const { products = [] } = await chrome.storage.local.get('products');
  return products;
}
function updateProduct(id, mutate) {
  return withLock(async () => {
    const products = await getProducts();
    const p = products.find((x) => x.id === id);
    if (!p) return null;
    mutate(p);
    await chrome.storage.local.set({ products });
    return p;
  });
}

// ---------- alarme ----------
async function ensureAlarm() {
  const a = await chrome.alarms.get(TICK);
  if (!a) chrome.alarms.create(TICK, { periodInMinutes: 1, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK) runDue();
});

// ---------- fila de checagens (uma aba por vez) ----------
let queue = Promise.resolve();
const pending = new Set();
const manual = new Set(); // checagens pedidas pelo botão (sem atraso e mesmo com o monitor desativado)

function enqueue(id) {
  if (pending.has(id)) return queue;
  pending.add(id);
  queue = queue
    .then(async () => {
      const force = manual.delete(id);
      if (await captchaState()) { // pausado: aguardando o usuário resolver a verificação
        if (id === 'coupon') await updateCoupon((c) => { c.lastStatus = 'pausado: resolva a verificação na janela aberta'; });
        return;
      }
      if (!force) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 7000)); // atraso aleatório entre produtos
      return id === 'coupon' ? checkCoupon(force) : checkProduct(id);
    })
    .catch((e) => console.error('check falhou', e))
    .finally(() => pending.delete(id));
  return queue;
}

async function runDue() {
  closeIdleReader();
  if (await captchaState()) { await checkCaptchaResolved(); return; }
  const now = Date.now();
  const { coupon } = await chrome.storage.local.get('coupon');
  if (coupon && coupon.enabled && coupon.url && coupon.value) {
    const every = Math.max(5, Number(coupon.interval) || 15) * 60000;
    if (!coupon.lastCheck || now - coupon.lastCheck >= every - 5000) enqueue('coupon');
  }
  const products = await getProducts();
  for (const p of products) {
    if (p.enabled === false) continue;
    const every = Math.max(MIN_INTERVAL, Number(p.interval) || 15) * 60000;
    if (!p.lastCheck || now - p.lastCheck >= every - 5000) enqueue(p.id);
  }
}

// ---------- leitura do preço ----------
function waitComplete(tabId, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout carregando a página')); }, ms);
    function onUpd(id, info) {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function cleanup() {
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(onUpd);
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') { cleanup(); resolve(); }
    }).catch(() => {});
  });
}

// Roda DENTRO da página (precisa ser autocontida).
async function scrape() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toNum = (s) => parseFloat(s.replace(/\./g, '').replace(',', '.'));

  function read() {
    const txt = document.body ? document.body.innerText : '';
    const start = txt.search(/R\$\s?\d/);
    if (start < 0) return null;
    // O bloco do preço termina onde começam moedas/parcelas/frete/quantidade.
    let end = txt.length;
    for (const m of ['Cupons De Loja', 'Moeda', 'Cartão De Crédito', 'Cartão de Crédito', 'Opções De Parcelamento', 'Frete', 'Quantidade', 'Adicionar Ao Carrinho']) {
      const i = txt.indexOf(m, start);
      if (i >= 0 && i < end) end = i;
    }
    const seg = txt.slice(start, end);
    const prices = [];
    const re = /R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/g;
    let m;
    while ((m = re.exec(seg))) {
      if (/\dx\s*$/i.test(seg.slice(Math.max(0, m.index - 4), m.index))) continue; // "12x R$..."
      if (/^\s*OFF/i.test(seg.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue; // cupom "R$30 OFF"
      const v = toNum(m[1]);
      if (v > 0) prices.push(v);
    }
    if (!prices.length) return null;
    const stock = txt.match(/(\d+)\s*quantidades?\s*dispon/i);
    return {
      price: prices[0], // preço principal (o primeiro da página, ex.: "no Pix com cupom")
      prices,
      stock: stock ? Number(stock[1]) : null,
      title: (document.querySelector('h1')?.innerText || document.title || '').replace(/\s*\|\s*Shopee.*$/i, '').trim(),
      soldOut: /esgotado|indispon[ií]vel/i.test(txt.slice(0, 4000)),
    };
  }

  const captchaNow = () => {
    if (/\/buyer\/login|\/verify\/|captcha/i.test(location.href)) return true;
    const t = document.body ? document.body.innerText : '';
    return !/R\$\s?\d/.test(t) && /verifica[cç][aã]o|captcha|arraste|deslize|quebra-cabe|prove que|n[aã]o sou (um )?rob[oô]|tráfego incomum|trafego incomum/i.test(t);
  };

  for (let i = 0; i < 60; i++) {
    if (captchaNow()) return { captcha: true };
    const r = read();
    if (r) {
      await sleep(1200); // deixa a página assentar e relê
      return read() || r;
    }
    await sleep(500);
  }
  return { error: `preço não carregou (url: ${location.pathname.slice(0, 40)}, texto: ${(document.body ? document.body.innerText.length : 0)} car.)` };
}

// Abre o produto numa janelinha pop-up SEM foco (não rouba o teclado). Diferente de uma aba em
// segundo plano, a janela conta como visível, então a Shopee renderiza o preço normalmente.
async function openReaderWindow(url, focused = false) {
  const win = await chrome.windows.create({
    url: url.split('#')[0] + '#spw=1', // #spw=1 ativa o fakevisible.js (reforço)
    type: 'popup',
    focused,
    width: 480,
    height: 420,
    left: 20,
    top: 20,
  });
  return { winId: win.id, tabId: win.tabs[0].id };
}

// Janela de leitura única e reutilizada: fica aberta entre as checagens (só troca de página),
// em vez de abrir e fechar uma janela a cada produto. Fecha sozinha após ficar parada.
const READER_IDLE_MIN = 30;
let reader = null; // { winId, tabId, last }

async function getReader(url, focused) {
  const target = url.split('#')[0] + '#spw=1';
  if (reader) {
    try {
      await chrome.tabs.get(reader.tabId);
      await chrome.tabs.update(reader.tabId, { url: target });
      if (focused) await chrome.windows.update(reader.winId, { focused: true });
      reader.last = Date.now();
      await new Promise((r) => setTimeout(r, 500)); // deixa o status virar "loading"
      return reader;
    } catch (_) { reader = null; }
  }
  const w = await openReaderWindow(url, focused);
  reader = { ...w, last: Date.now() };
  return reader;
}

async function closeIdleReader() {
  if (!reader || pending.size) return;
  if (await captchaState()) return;
  if (Date.now() - reader.last > READER_IDLE_MIN * 60000) {
    chrome.windows.remove(reader.winId).catch(() => {});
    reader = null;
  }
}
chrome.windows.onRemoved.addListener((id) => { if (reader && reader.winId === id) reader = null; });

async function fetchPrice(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000 * attempt)); // espera antes de tentar de novo
    let w = null;
    try {
      w = await getReader(url, attempt === 2); // 3ª tentativa: janela com foco (garante renderização)
      await waitComplete(w.tabId, 30000);
      const [res] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: scrape });
      const r = res?.result;
      if (!r) throw new Error('sem resposta da página');
      if (r.captcha) {
        await enterCaptchaPause(w, url);
        throw new Error('captcha: Shopee pediu verificação — resolva na janela aberta');
      }
      if (r.error) throw new Error(r.error);
      return r;
    } catch (e) {
      lastErr = e;
      if (/login|captcha/i.test(e.message || '')) break; // não adianta repetir
    } finally {
      if (reader) reader.last = Date.now();
    }
  }
  throw lastErr;
}

// ---------- pausa por verificação (captcha) ----------
// A extensão NÃO resolve a verificação: pausa as checagens, avisa e espera você resolver.
async function captchaState() {
  const { captcha = null } = await chrome.storage.local.get('captcha');
  return captcha;
}

async function enterCaptchaPause(w, url) {
  await chrome.storage.local.set({ captcha: { winId: w.winId, tabId: w.tabId, url, since: Date.now() } });
  await chrome.windows.update(w.winId, { focused: true, width: 520, height: 720 }).catch(() => {});
  await chrome.notifications.create('alert:captcha', {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Shopee pediu verificação',
    message: 'Resolva a verificação na janela aberta. As checagens ficam pausadas e voltam sozinhas depois.',
    priority: 2,
    requireInteraction: true,
  });
  const s = await chrome.storage.local.get('sound:captcha');
  await startSound((s['sound:captcha'] || {}).dataUrl || chrome.runtime.getURL('sounds/captcha.mp3')); // seu som > embutido
}

async function leaveCaptchaPause(msg) {
  const st = await captchaState();
  await chrome.storage.local.remove('captcha');
  chrome.notifications.clear('alert:captcha');
  stopSound();
  if (msg) {
    chrome.notifications.create('info:resume', {
      type: 'basic', iconUrl: 'icon128.png', title: 'Shopee Price Watch', message: msg, priority: 0,
    });
  }
}

// Roda DENTRO da página: ainda há verificação? já carregou preço?
function probe() {
  const t = document.body ? document.body.innerText : '';
  const hasPrice = /R\$\s?\d/.test(t);
  const captcha = /\/buyer\/login|\/verify\/|captcha/i.test(location.href) ||
    (!hasPrice && /verifica[cç][aã]o|captcha|arraste|deslize|quebra-cabe|prove que|n[aã]o sou (um )?rob[oô]|tráfego incomum|trafego incomum/i.test(t));
  return { captcha, hasPrice };
}

async function checkCaptchaResolved() {
  const st = await captchaState();
  if (!st) return;
  let alive = true, res = null;
  try {
    await chrome.tabs.get(st.tabId);
    [res] = await chrome.scripting.executeScript({ target: { tabId: st.tabId }, func: probe });
  } catch (_) { alive = false; }
  if (!alive) return leaveCaptchaPause('Janela fechada — checagens retomadas.');
  const r = res && res.result;
  if (r && !r.captcha && r.hasPrice) return leaveCaptchaPause('Verificação resolvida — checagens retomadas.');
  if (Date.now() - st.since > 30 * 60000) return leaveCaptchaPause('Verificação não resolvida em 30 min — tentando de novo.');
}

chrome.windows.onRemoved.addListener(async (winId) => {
  const st = await captchaState();
  if (st && st.winId === winId) leaveCaptchaPause('Janela fechada — checagens retomadas.');
});


// ---------- monitor de cupons ----------
function updateCoupon(mutate) {
  return withLock(async () => {
    const { coupon } = await chrome.storage.local.get('coupon');
    if (!coupon) return null;
    mutate(coupon);
    await chrome.storage.local.set({ coupon });
    return coupon;
  });
}

// Monta o padrão a partir do que o usuário digitou: "50" -> R$50 / R$ 50,00 ; "50%" -> 50%.
function couponPattern(value) {
  const v = String(value).trim().replace(/\s+/g, '');
  const pct = v.match(/^(\d+(?:[.,]\d+)?)%$/);
  if (pct) return { src: '(?<![\\d.,])' + pct[1].replace(/[.,]/, '[.,]') + '\\s?%', flags: 'i', kind: 'pct', num: parseFloat(pct[1].replace(',', '.')) };
  const n = v.replace(/^R\$/i, '').replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(n)) return null;
  const [int, dec] = n.split('.');
  const cents = dec ? '[,.]' + dec.padEnd(2, '0') : '(?:,00)?';
  return { src: '(?<![\\d.,])R\\$\\s?' + int + cents + '(?![\\d])', flags: 'i', kind: 'money', num: parseFloat(n) };
}

// Roda DENTRO da página: procura o valor do cupom no texto (rolando para carregar listas).
async function scanCoupon(src, flags, name, mode, kind, num) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const re = new RegExp(src, flags);
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const want = name ? norm(name.trim()) : '';
  // modo "gte": aceita qualquer valor >= ao configurado (ignora "compras acima de R$ X" / mínimos)
  const numRe = kind === 'pct' ? /(\d+(?:[.,]\d+)?)\s?%/g : /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(?![\d])/gi;
  const lineOk = (l) => {
    if (mode !== 'gte') return re.test(l);
    numRe.lastIndex = 0;
    let m;
    while ((m = numRe.exec(l))) {
      if (kind !== 'pct' && /(acima|m[ií]n|a partir|pedidos?|gast|compras?|de\s*R\$\s*$)/i.test(l.slice(Math.max(0, m.index - 22), m.index))
          && !/desconto|off|cupom/i.test(l.slice(Math.max(0, m.index - 22), m.index))) continue; // é valor mínimo, não desconto
      const v = kind === 'pct' ? parseFloat(m[1].replace(',', '.'))
        : parseFloat(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2].padEnd(2, '0') : ''));
      if (v >= num) return true;
    }
    return false;
  };
  for (let i = 0; i < 40; i++) {
    if (/\/verify\/|captcha/i.test(location.href)) return { captcha: true };
    if (/\/buyer\/login/i.test(location.href)) return { login: true };
    const t = document.body ? document.body.innerText : '';
    const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
    const hits = [];
    lines.forEach((l, k) => {
      if (!lineOk(l)) return;
      // com nome: ele precisa aparecer no mesmo cartão (linha do valor ± 2 linhas)
      const ctx = lines.slice(Math.max(0, k - 2), k + 3).join(' ');
      if (!want || norm(ctx).includes(want)) hits.push(want ? ctx : l);
    });
    if (hits.length) return { found: true, hits: hits.slice(0, 3) };
    if (i % 3 === 2) window.scrollBy(0, Math.max(400, innerHeight * 0.8)); // carrega itens "preguiçosos"
    await sleep(700);
  }
  return { found: false };
}

async function checkCoupon(force = false) {
  const { coupon } = await chrome.storage.local.get('coupon');
  if (!coupon || !coupon.url || !coupon.value) return;
  if (!coupon.enabled && !force) return;
  await updateCoupon((c) => { c.lastStatus = 'checando…'; });
  const pat = couponPattern(coupon.value);
  const now = Date.now();
  if (!pat) { await updateCoupon((c) => { c.lastCheck = now; c.lastStatus = 'erro: valor do cupom inválido'; }); return; }

  let r = null, err = null;
  try {
    const w = await getReader(coupon.url, false);
    await waitComplete(w.tabId, 30000);
    const [res] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: scanCoupon, args: [pat.src, pat.flags, coupon.name || '', coupon.mode === 'gte' ? 'gte' : 'eq', pat.kind, pat.num] });
    r = res && res.result;
    if (!r) err = 'sem resposta da página';
    else if (r.captcha) { await enterCaptchaPause(w, coupon.url); err = 'captcha: resolva na janela aberta'; }
    else if (r.login) err = 'Shopee pediu login — entre na sua conta no Chrome';
  } catch (e) { err = e.message || String(e); }
  if (reader) reader.last = Date.now();

  if (err) { await updateCoupon((c) => { c.lastCheck = now; c.lastStatus = 'erro: ' + err; }); return; }

  let shouldAlert = false;
  await updateCoupon((c) => {
    c.lastCheck = now;
    c.lastStatus = r.found ? 'cupom encontrado' : 'ok (cupom não encontrado)';
    if (r.found) { if (!c.alerted) { shouldAlert = true; c.alerted = true; } }
    else c.alerted = false;
  });
  if (shouldAlert) {
    await chrome.notifications.create('alert:coupon', {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Cupom encontrado!',
      message: `${coupon.name ? coupon.name + ' · ' : ''}Valor ${coupon.mode === 'gte' ? '≥ ' : ''}${coupon.value}\n${(r.hits || []).join(' · ').slice(0, 160)}`,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: 'Silenciar' }, { title: 'Abrir página' }],
    });
    const cs = await chrome.storage.local.get('sound:coupon');
    await startSound((cs['sound:coupon'] || {}).dataUrl || chrome.runtime.getURL('sounds/coupon.mp3')); // seu som > embutido
  }
}

// ---------- checagem + regra de alerta ----------
async function checkProduct(id) {
  const products = await getProducts();
  const p = products.find((x) => x.id === id);
  if (!p) return;

  let r = null, err = null;
  try { r = await fetchPrice(p.url); } catch (e) { err = e.message || String(e); }
  const now = Date.now();

  if (err) {
    await updateProduct(id, (x) => { x.lastCheck = now; x.lastStatus = 'erro: ' + err; });
    return;
  }

  let shouldAlert = false;
  const updated = await updateProduct(id, (x) => {
    x.lastCheck = now;
    x.lastStatus = r.soldOut ? 'ok (possível esgotado)' : 'ok';
    if (!x.customName && r.title) x.name = r.title;
    x.stock = r.stock;
    x.history = x.history || [];
    if (x.lastPrice !== r.price) x.history.push({ t: now, p: r.price });
    if (x.history.length > 500) x.history = x.history.slice(-500);
    x.lastPrice = r.price;
    x.lowest = x.lowest == null ? r.price : Math.min(x.lowest, r.price);

    const hit = x.mode === 'lt' ? r.price < x.target : r.price <= x.target;
    if (hit && !r.soldOut) {
      if (!x.alerted || r.price < x.alertedPrice) {
        shouldAlert = true;
        x.alerted = true;
        x.alertedPrice = r.price;
      }
    } else {
      x.alerted = false;
      x.alertedPrice = null;
    }
  });

  if (shouldAlert && updated) await fireAlert(updated, r.price);
}

// ---------- alertas ----------
const fmt = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

async function fireAlert(p, price) {
  await chrome.notifications.create('alert:' + p.id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: 'Preço alvo atingido!',
    message: `${p.name || p.url}\n${fmt(price)} (alvo ${p.mode === 'lt' ? '< ' : '≤ '}${fmt(p.target)})`,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: 'Silenciar' }, { title: 'Abrir produto' }],
  });
  await startSound(await pickSound(p.id));
  await notifyExternal(p, price);
}

// Gancho para a integração com o Home Assistant (próximo passo).
// Será chamado a cada alerta; hoje não faz nada.
async function notifyExternal(product, price) {
  // ex.: fetch(haWebhookUrl, { method: 'POST', body: JSON.stringify({ ... }) })
}

// Som do produto; se não tiver, o som padrão geral; se também não tiver, null (beep embutido).
async function pickSound(id) {
  const k = 'sound:' + id;
  const s = await chrome.storage.local.get([k, 'sound:default']);
  return (s[k] || s['sound:default'] || {}).dataUrl || chrome.runtime.getURL('sounds/alert.mp3'); // próprio > padrão > embutido
}

async function startSound(src = null) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Tocar alarme quando o preço atingir o alvo',
    });
    await new Promise((r) => setTimeout(r, 300));
  }
  chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'play', src }).catch(() => {});
}

async function stopSound() {
  chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'stop' }).catch(() => {});
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function openProduct(nid) {
  if (nid === 'alert:coupon') {
    const { coupon } = await chrome.storage.local.get('coupon');
    if (coupon && coupon.url) chrome.tabs.create({ url: coupon.url });
    return;
  }
  if (!nid.startsWith('alert:')) return;
  const p = (await getProducts()).find((x) => x.id === nid.slice(6));
  if (p) chrome.tabs.create({ url: p.url });
}

chrome.notifications.onClicked.addListener(async (nid) => {
  stopSound();
  chrome.notifications.clear(nid);
  openProduct(nid);
});
chrome.notifications.onButtonClicked.addListener((nid, idx) => {
  stopSound();
  chrome.notifications.clear(nid);
  if (idx === 1) openProduct(nid);
});
chrome.notifications.onClosed.addListener(() => stopSound());

// O Chrome nem sempre dispara onClosed (ex.: notificação dispensada pelo Windows).
// Por isso o som confere a cada 2 s se ainda existe uma notificação de alerta; se sumiu, para.
function alertNotificationActive() {
  return new Promise((resolve) => {
    chrome.notifications.getAll((all) => resolve(Object.keys(all || {}).some((k) => k.startsWith('alert:'))));
  });
}

// ---------- mensagens do popup ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  if (msg.type === 'soundHeartbeat') alertNotificationActive().then((active) => sendResponse({ active }));
  else if (msg.type === 'checkNow') enqueue(msg.id).then(() => sendResponse({ ok: true }));
  else if (msg.type === 'checkCoupon') { manual.add('coupon'); enqueue('coupon').then(() => sendResponse({ ok: true })); }
  else if (false) enqueue('coupon').then(() => sendResponse({ ok: true }));
  else if (msg.type === 'resumeCaptcha') leaveCaptchaPause('Checagens retomadas.').then(() => sendResponse({ ok: true }));
  else if (msg.type === 'stopSound') {
    chrome.notifications.getAll((all) => Object.keys(all || {}).filter((k) => k.startsWith('alert:')).forEach((k) => chrome.notifications.clear(k)));
    stopSound().then(() => sendResponse({ ok: true }));
  }
  else if (msg.type === 'testAlert') {
    fireAlert({ id: 'test', name: 'Teste de alarme', url: 'https://shopee.com.br', target: 100 }, 99)
      .then(() => sendResponse({ ok: true }));
  } else return;
  return true; // resposta assíncrona
});
