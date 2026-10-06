// Roda no contexto da página (world MAIN) ANTES do código da Shopee, mas só nas abas
// abertas pela extensão (marcadas com #spw=1 na URL). A Shopee não carrega o preço
// quando a aba está em segundo plano (visibilityState = "hidden"), então fingimos "visible".
(() => {
  if (!/[#&]spw=1/.test(location.hash)) return;
  const def = (obj, prop, getter) => {
    try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); } catch (_) {}
  };
  def(document, 'visibilityState', () => 'visible');
  def(document, 'webkitVisibilityState', () => 'visible');
  def(document, 'hidden', () => false);
  def(document, 'webkitHidden', () => false);
  document.hasFocus = () => true;
  // impede que a página perceba a mudança para "hidden"
  const stop = (e) => e.stopImmediatePropagation();
  document.addEventListener('visibilitychange', stop, true);
  window.addEventListener('blur', stop, true);
  window.addEventListener('pagehide', stop, true);
})();
