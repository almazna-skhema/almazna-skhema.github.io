/* Сайт как программа: сохраняется на компьютере для работы без интернета (sw.js)
 * и ставится отдельным окном с иконкой — кнопка #install внизу панели. */
(function (A) {
  'use strict';

  const T = A.T || function (s) { return s; };
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* без работы офлайн, сайт работает как раньше */ });
  });

  const btn = document.getElementById('install');
  if (!btn) return;
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  let prompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    if (standalone) return;
    prompt = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', function () {
    if (!prompt) return;
    const p = prompt;
    prompt = null;
    p.prompt();
    btn.hidden = true; // окно установки показывается один раз; отказались — браузер позже предложит снова
  });

  window.addEventListener('appinstalled', function () {
    prompt = null;
    btn.hidden = true;
  });

  btn.title = T('Поставить сервис на компьютер отдельной программой со значком — будет работать и без интернета');
})(window.ALMAZ = window.ALMAZ || {});
