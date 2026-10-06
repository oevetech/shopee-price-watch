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

async function getAutoScroll() {
  const { autoScroll } = await chrome.storage.local.get('autoScroll');
  return autoScroll ? !!autoScroll.enabled : true; // padrão: ligado
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
  await closeIdleReader();
  haHeartbeat();
  if (await captchaState()) { await checkCaptchaResolved(); return; }
  const now = Date.now();
  const { coupon } = await chrome.storage.local.get('coupon');
  if (coupon && coupon.enabled && coupon.url && (coupon.value || coupon.value2)) {
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
async function scrape(autoScroll) {
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
      await sleep(1200); // deixa a página assentar
      // rola como uma pessoa: às vezes até a metade, às vezes até o fim (carrega descrição/avaliações)
      const frac = Math.random() < 0.5 ? 0.5 : 1;
      let y = 0;
      for (let s = 0; s < (autoScroll ? 40 : 0); s++) { // só rola se "rolar a página automaticamente" estiver marcado
        const max = Math.max(0, document.documentElement.scrollHeight - innerHeight); // recalcula: a página cresce ao carregar
        const goal = max * frac;
        if (y >= goal - 5) break;
        y = Math.min(goal, y + innerHeight * (0.5 + Math.random() * 0.3));
        window.scrollTo({ top: y, behavior: 'smooth' });
        await sleep(450 + Math.random() * 450);
      }
      await sleep(800 + Math.random() * 700);
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
    width: 1000,
    height: 900,
    left: 20,
    top: 20,
  });
  return { winId: win.id, tabId: win.tabs[0].id };
}

// Janela de leitura única e reutilizada: fica aberta entre as checagens (só troca de página),
// em vez de abrir e fechar uma janela a cada produto. Fecha sozinha após ficar parada.
const READER_IDLE_MIN = 30;
let reader = null; // { winId, tabId, last } — espelhado em chrome.storage.session (o service worker do MV3 é desligado quando ocioso)

async function loadReader() {
  if (!reader) {
    try { reader = (await chrome.storage.session.get('reader')).reader || null; } catch (_) { reader = null; }
  }
  return reader;
}
function saveReader() {
  try { chrome.storage.session.set({ reader }).catch(() => {}); } catch (_) {}
}

// Fecha janelas de leitura "órfãs" (marcadas com #spw=1) que não são a atual nem a da verificação.
async function sweepStrays() {
  try {
    const cap = await captchaState();
    const tabs = await chrome.tabs.query({ url: 'https://shopee.com.br/*' });
    const wins = new Set();
    for (const t of tabs) {
      if (!/#spw=1/.test(t.url || '')) continue;
      if (reader && t.id === reader.tabId) continue;
      if (cap && t.id === cap.tabId) continue;
      wins.add(t.windowId);
    }
    for (const w of wins) chrome.windows.remove(w).catch(() => {});
  } catch (_) {}
}

async function getReader(url, focused) {
  const target = url.split('#')[0] + '#spw=1';
  await loadReader();
  if (reader) {
    try {
      await chrome.tabs.get(reader.tabId);
      await chrome.tabs.update(reader.tabId, { url: target });
      if (focused) await chrome.windows.update(reader.winId, { focused: true });
      reader.last = Date.now();
      saveReader();
      await new Promise((r) => setTimeout(r, 500)); // deixa o status virar "loading"
      return reader;
    } catch (_) { reader = null; saveReader(); }
  }
  await sweepStrays(); // antes de abrir uma nova, fecha as que ficaram para trás
  const w = await openReaderWindow(url, focused);
  reader = { ...w, last: Date.now() };
  saveReader();
  return reader;
}

async function closeIdleReader() {
  await loadReader();
  if (pending.size) return;
  if (await captchaState()) return;
  if (!reader) { await sweepStrays(); return; } // nenhuma janela conhecida: limpa qualquer sobra
  if (Date.now() - reader.last > READER_IDLE_MIN * 60000) {
    chrome.windows.remove(reader.winId).catch(() => {});
    reader = null;
    saveReader();
  }
}
chrome.windows.onRemoved.addListener(async (id) => { await loadReader(); if (reader && reader.winId === id) { reader = null; saveReader(); } });

async function fetchPrice(url) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000 * attempt)); // espera antes de tentar de novo
    let w = null;
    try {
      w = await getReader(url, attempt === 2); // 3ª tentativa: janela com foco (garante renderização)
      await waitComplete(w.tabId, 30000);
      const [res] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: scrape, args: [await getAutoScroll()] });
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
      if (reader) { reader.last = Date.now(); saveReader(); }
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
  await announce('A Shopee pediu verificação. Resolva na janela aberta.', (s['sound:captcha'] || {}).dataUrl || chrome.runtime.getURL('sounds/captcha.mp3')); // seu som > embutido
  await haAlert('captcha', 'Shopee pediu verificação', 'Resolva a verificação na janela aberta do Chrome. As checagens estão pausadas.', { url });
}

async function leaveCaptchaPause(msg) {
  const st = await captchaState();
  await chrome.storage.local.remove('captcha');
  chrome.notifications.clear('alert:captcha');
  stopSound();
  haSync().catch(() => {}); // captcha volta para "off" no Home Assistant
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
async function scanCoupon(src, flags, name, mode, kind, num, autoScroll) {
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
    if (autoScroll && i % 3 === 2) window.scrollBy(0, Math.max(400, innerHeight * 0.8)); // carrega itens "preguiçosos"
    await sleep(700);
  }
  return { found: false };
}

async function checkCoupon(force = false) {
  const { coupon } = await chrome.storage.local.get('coupon');
  if (!coupon || !coupon.url) return;
  if (!coupon.enabled && !force) return;
  // Até 2 cupons na mesma abertura da página; só checa os que estiverem preenchidos.
  const specs = [];
  if (coupon.value) specs.push({ k: 1, name: coupon.name || '', value: coupon.value, mode: coupon.mode, key: 'alerted', nid: 'alert:coupon' });
  if (coupon.value2) specs.push({ k: 2, name: coupon.name2 || '', value: coupon.value2, mode: coupon.mode2, key: 'alerted2', nid: 'alert:coupon2' });
  if (!specs.length) return;
  await updateCoupon((c) => { c.lastStatus = 'checando…'; });
  const now = Date.now();
  for (const sp of specs) {
    sp.pat = couponPattern(sp.value);
    if (!sp.pat) { await updateCoupon((c) => { c.lastCheck = now; c.lastStatus = `erro: valor do cupom ${sp.k} inválido`; }); return; }
  }

  let err = null;
  try {
    const w = await getReader(coupon.url, false);
    await waitComplete(w.tabId, 30000);
    const auto = await getAutoScroll();
    for (const sp of specs) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: scanCoupon, args: [sp.pat.src, sp.pat.flags, sp.name, sp.mode === 'gte' ? 'gte' : 'eq', sp.pat.kind, sp.pat.num, auto] });
      const r = res && res.result;
      if (!r) { err = 'sem resposta da página'; break; }
      if (r.captcha) { await enterCaptchaPause(w, coupon.url); err = 'captcha: resolva na janela aberta'; break; }
      if (r.login) { err = 'Shopee pediu login — entre na sua conta no Chrome'; break; }
      sp.r = r;
    }
  } catch (e) { err = e.message || String(e); }
  if (reader) { reader.last = Date.now(); saveReader(); }

  if (err) { await updateCoupon((c) => { c.lastCheck = now; c.lastStatus = 'erro: ' + err; }); return; }

  let cleared = false;
  await updateCoupon((c) => {
    c.lastCheck = now;
    const nFound = specs.filter((sp) => sp.r.found).length;
    c.lastStatus = nFound ? `cupom encontrado (${nFound}/${specs.length})` : 'ok (cupom não encontrado)';
    for (const sp of specs) {
      if (sp.r.found) { if (!c[sp.key]) { sp.alert = true; c[sp.key] = true; } }
      else { if (c[sp.key]) cleared = true; c[sp.key] = false; }
    }
  });
  if (cleared) haSync().catch(() => {});
  for (const sp of specs) {
    if (!sp.alert) continue;
    const cond = `${sp.mode === 'gte' ? '≥ ' : ''}${sp.value}`;
    await chrome.notifications.create(sp.nid, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Cupom encontrado!',
      message: `${sp.name ? sp.name + ' · ' : ''}Valor ${cond}\n${(sp.r.hits || []).join(' · ').slice(0, 160)}`,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: 'Silenciar' }, { title: 'Abrir página' }],
    });
    const cs = await chrome.storage.local.get('sound:coupon');
    await announce(`Cupom encontrado! ${sp.name ? sp.name + '. ' : ''}Valor ${sp.value}.`, (cs['sound:coupon'] || {}).dataUrl || chrome.runtime.getURL('sounds/coupon.mp3')); // seu som > embutido
    await haAlert('coupon', 'Cupom encontrado!', `${sp.name ? sp.name + ' · ' : ''}Valor ${cond}`, { url: coupon.url, hits: sp.r.hits || [] });
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

  let shouldAlert = false, cleared = false;
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
      cleared = !!x.alerted;
      x.alerted = false;
      x.alertedPrice = null;
    }
  });

  if (shouldAlert && updated) await fireAlert(updated, r.price);
  else if (cleared) haSync().catch(() => {}); // produto saiu do preço alvo: sensor volta para "off"
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
  await announce(`Atenção! ${shortName(p.name || p.url)} está com desconto. Preço ${fmt(price)}.`, pickSound(p.id));
  await notifyExternal(p, price);
}

// Integração com o Home Assistant: chamado a cada alerta de preço alvo.
async function notifyExternal(product, price) {
  if (product.id === 'test') return; // o "Testar alarme" não dispara o HA (use "Testar conexão")
  await haAlert('product', 'Preço alvo atingido!', `${product.name || product.url}\n${fmt(price)} (alvo ${product.mode === 'lt' ? '< ' : '≤ '}${fmt(product.target)})`,
    { url: product.url, product: product.name || product.url, price, target: product.target });
}

// ---------- Home Assistant ----------
// Cria/atualiza 3 entidades via API REST (POST /api/states/...), dispara o evento "shopee_price_watch"
// e, se configurado, chama um serviço notify.* (ex.: celular com o app do HA).
const HA_ENTITIES = {
  coupon:  { id: 'binary_sensor.shopee_cupom',        name: 'Shopee cupom encontrado',      icon: 'mdi:ticket-percent' },
  captcha: { id: 'binary_sensor.shopee_captcha',      name: 'Shopee verificação (captcha)', icon: 'mdi:robot-confused', device_class: 'problem' },
  product: { id: 'binary_sensor.shopee_produto_alvo', name: 'Shopee produto no preço alvo', icon: 'mdi:tag-check' },
};

async function haConfig() {
  const { ha = null } = await chrome.storage.local.get('ha');
  return ha && ha.enabled && ha.url && ha.token ? ha : null;
}

async function haCall(cfg, path, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(cfg.url.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(r.status === 401 ? 'token inválido (401)' : r.status === 404 ? 'não encontrado (404) — confira a URL/serviço' : 'HTTP ' + r.status);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'sem resposta do Home Assistant (timeout)' : (e.message === 'Failed to fetch' ? 'não consegui conectar (URL/porta/rede/permissão)' : e.message));
  } finally { clearTimeout(t); }
}

async function haStatus(ok, msg) {
  const { ha } = await chrome.storage.local.get('ha');
  if (!ha) return;
  await chrome.storage.local.set({ ha: { ...ha, lastStatus: (ok ? 'ok' : 'erro') + ': ' + msg, lastSync: ok ? Date.now() : ha.lastSync } });
}

// Publica o estado atual das 3 entidades (espelha o que está no storage).
async function haSync(cfgIn) {
  const cfg = cfgIn || await haConfig();
  if (!cfg) return;
  try {
    const st = await chrome.storage.local.get(['coupon', 'captcha', 'products']);
    const hot = (st.products || []).filter((p) => p.alerted);
    const states = {
      coupon:  { on: !!(st.coupon && (st.coupon.alerted || st.coupon.alerted2)), attrs: { valor: st.coupon && st.coupon.value, nome: st.coupon && st.coupon.name, valor2: st.coupon && st.coupon.value2, nome2: st.coupon && st.coupon.name2, url: st.coupon && st.coupon.url } },
      captcha: { on: !!st.captcha, attrs: { desde: st.captcha ? new Date(st.captcha.since).toISOString() : null, url: st.captcha && st.captcha.url } },
      product: { on: hot.length > 0, attrs: { quantidade: hot.length, produtos: hot.map((p) => ({ nome: p.name, preco: p.alertedPrice, alvo: p.target, url: p.url })) } },
    };
    for (const [k, v] of Object.entries(states)) {
      const e = HA_ENTITIES[k];
      const attributes = { friendly_name: e.name, icon: e.icon, ...v.attrs };
      if (e.device_class) attributes.device_class = e.device_class;
      await haCall(cfg, '/api/states/' + e.id, { state: v.on ? 'on' : 'off', attributes });
    }
    await haStatus(true, 'entidades atualizadas');
  } catch (e) { await haStatus(false, e.message); throw e; }
}

// Alerta: atualiza as entidades, dispara o evento e (opcional) manda a notificação direta.
async function haAlert(kind, title, message, extra = {}) {
  const cfg = await haConfig();
  if (!cfg) return;
  try {
    await haSync(cfg);
    await haCall(cfg, '/api/events/shopee_price_watch', { type: kind, title, message, ...extra });
    const svc = String(cfg.notify || '').trim().replace(/^notify\./, '');
    if (svc) await haCall(cfg, '/api/services/notify/' + svc, { title, message, data: { url: extra.url, tag: 'shopee-' + kind } });
    await haStatus(true, `alerta "${kind}" enviado`);
  } catch (e) { await haStatus(false, e.message); }
}

// O HA apaga entidades criadas por REST quando reinicia; republica a cada ~10 min enquanto ativo.
async function haHeartbeat() {
  const cfg = await haConfig();
  if (cfg && Date.now() - (cfg.lastSync || 0) > 10 * 60000) haSync(cfg).catch(() => {});
}

// Botão "Testar conexão": cria as entidades, dispara um evento de teste e a notificação (se configurada).
async function haTest() {
  const cfg = await haConfig();
  if (!cfg) return { ok: false, error: 'ative a integração e preencha URL e token' };
  try {
    await haSync(cfg);
    await haCall(cfg, '/api/events/shopee_price_watch', { type: 'test', title: 'Shopee Price Watch', message: 'Teste de conexão' });
    const svc = String(cfg.notify || '').trim().replace(/^notify\./, '');
    if (svc) await haCall(cfg, '/api/services/notify/' + svc, { title: 'Shopee Price Watch', message: 'Teste de conexão' });
    await haStatus(true, 'teste enviado');
    return { ok: true };
  } catch (e) { await haStatus(false, e.message); return { ok: false, error: e.message }; }
}

// Som do produto; se não tiver, o som padrão geral; se também não tiver, null (beep embutido).
async function pickSound(id) {
  const k = 'sound:' + id;
  const s = await chrome.storage.local.get([k, 'sound:default']);
  return (s[k] || s['sound:default'] || {}).dataUrl || chrome.runtime.getURL('sounds/alert.mp3'); // próprio > padrão > embutido
}

// Voz: se ativada nas configurações, fala o texto em vez de tocar o som; senão toca o som normal.
async function announce(text, srcPromise) {
  const { voice = {} } = await chrome.storage.local.get('voice');
  if (voice.enabled) return startSpeech(text);
  return startSound(await srcPromise);
}

async function startSpeech(text, repeat = true) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Anunciar por voz quando o preço atingir o alvo',
    });
    await new Promise((r) => setTimeout(r, 300));
  }
  chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'speak', text, repeat }).catch(() => {});
}

const shortName = (n) => String(n || 'Produto').replace(/\s+/g, ' ').trim().slice(0, 90);

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
  if (nid === 'alert:coupon' || nid === 'alert:coupon2') {
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
  else if (msg.type === 'haTest') haTest().then(sendResponse);
  else if (msg.type === 'haSync') haSync().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
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
