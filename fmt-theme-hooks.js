/**
 * fmt-theme-hooks.js — автоматически вызывает fmtApplyTheme()
 * в нужные моменты, не требуя правки index.js
 *
 * Загружать ПОСЛЕ fmt-theme.js и index.js (см. manifest.json)
 */

(function () {
  'use strict';

  /* ── Дёргаем тему сразу и с дебаунсом ──────────────────────── */
  let _pending = null;
  function scheduleTheme(delay) {
    clearTimeout(_pending);
    _pending = setTimeout(() => window.fmtApplyTheme?.(), delay ?? 80);
  }

  /* ── MutationObserver: ловим момент появления fmt_drawer/fmt_fab ── */
  const bodyObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const id = node.id;
        if (id === 'fmt_drawer' || id === 'fmt_fab' || id === 'fmt_overlay') {
          scheduleTheme(0);
        }
      }
    }
  });
  bodyObserver.observe(document.body, { childList: true, subtree: false });

  /* ── Патчим openDrawer через перехват клика на FAB ─────────── */
  /* Слушаем кастомное событие которое fmt-theme.js уже ждёт */
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('#fmt_fab_btn') || e.target?.closest?.('#fmt_open_drawer_btn')) {
      scheduleTheme(30);
    }
  }, true);

  /* ── Патчим через событие APP_READY SillyTavern ────────────── */
  const hookST = () => {
    const c = window.SillyTavern?.getContext?.();
    if (!c?.eventSource || !c?.event_types) {
      setTimeout(hookST, 500);
      return;
    }

    /* APP_READY — применяем тему как только ST готов */
    c.eventSource.on(c.event_types.APP_READY, () => scheduleTheme(150));

    /* CHAT_CHANGED — тема могла измениться для другого персонажа */
    c.eventSource.on(c.event_types.CHAT_CHANGED, () => scheduleTheme(200));
  };
  hookST();

  /* ── Первый запуск после загрузки DOM ─────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scheduleTheme(300));
  } else {
    scheduleTheme(300);
  }

  /* ── Повторный запуск через секунду — для медленных тем ───── */
  setTimeout(() => window.fmtApplyTheme?.(), 1200);

})();
