/**
 * fmt-theme.js — адаптация FMT под тему SillyTavern
 *
 * Читает реальные вычисленные цвета из DOM SillyTavern и прописывает
 * их как CSS-переменные на #fmt_drawer и #fmt_overlay.
 *
 * Вызывать: fmtApplyTheme() сразу после создания дровера
 * и слушать событие: document.addEventListener('fmt:theme-apply', ...)
 */

(function () {
  "use strict";

  /* ── helpers ──────────────────────────────────────────────────── */

  function gc(el) {
    return el ? getComputedStyle(el) : null;
  }

  function get(selector) {
    return document.querySelector(selector);
  }

  /**
   * Читает background-color элемента. Если прозрачный — идёт к родителю.
   */
  function getBg(el, depth = 6) {
    while (el && depth-- > 0) {
      const bg = gc(el)?.backgroundColor ?? "";
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Смешать два hex/rgb цвета: base + overlay с alpha
   */
  function mixRgba(base, overlay, t) {
    const p = parseRgb(base);
    const o = parseRgb(overlay);
    if (!p || !o) return base;
    const r = Math.round(p.r * (1 - t) + o.r * t);
    const g = Math.round(p.g * (1 - t) + o.g * t);
    const b = Math.round(p.b * (1 - t) + o.b * t);
    return `rgb(${r},${g},${b})`;
  }

  function parseRgb(str) {
    const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  function toRgba(str, a) {
    const m = parseRgb(str);
    if (!m) return str;
    return `rgba(${m.r},${m.g},${m.b},${a})`;
  }

  /**
   * Lightness 0–1 из rgb-строки
   */
  function luma(str) {
    const m = parseRgb(str);
    if (!m) return 0.5;
    return (0.299 * m.r + 0.587 * m.g + 0.114 * m.b) / 255;
  }

  /* ── основная функция ────────────────────────────────────────── */

  window.fmtApplyTheme = function () {
    const root = document.getElementById("fmt_drawer");
    if (!root) return;

    /* ── ST DOM-источники ── */
    const body       = document.body;
    const chat       = get("#chat");
    const mesEl      = get(".mes") || get(".last_mes");
    const mesText    = get(".mes_text");
    const inputEl    = get("#send_textarea") || get(".chat_textarea");
    const headerEl   = get("#top-bar") || get(".nav-bar") || get("header");
    const borderEl   = get(".mes") || get("#sheld") || get("#chat");

    /* ── Читаем реальные цвета ── */
    const rawBodyBg    = getBg(body)        ?? "rgb(24, 33, 46)";
    const rawChatBg    = getBg(chat)        ?? rawBodyBg;
    const rawMesBg     = getBg(mesEl)       ?? rawBodyBg;
    const rawInputBg   = getBg(inputEl)     ?? rawBodyBg;

    const rawBodyText  = gc(body)?.color          ?? "rgb(200, 222, 255)";
    const rawMesText   = gc(mesText)?.color       ?? rawBodyText;
    const rawInputText = gc(inputEl)?.color       ?? rawBodyText;
    const rawBorder    = gc(borderEl)?.borderColor
                        ?? gc(borderEl)?.borderTopColor
                        ?? toRgba(rawBodyText, 0.18);

    /* Акцент: пробуем button, link, heading */
    const accentCandidates = [
      get(".menu_button"),
      get("a"),
      get("h2"),
      get(".nav-item.active"),
      get(".btn-primary"),
    ].filter(Boolean);
    let rawAccent = null;
    for (const el of accentCandidates) {
      const c = gc(el)?.color;
      if (c && luma(c) > 0.35 && c !== rawBodyText) { rawAccent = c; break; }
    }
    rawAccent = rawAccent ?? toRgba(rawBodyText, 0.9);

    /* Тёмная или светлая тема? */
    const isDark = luma(rawBodyBg) < 0.45;

    /* ── Вычисляем переменные ── */
    const fmtBg       = rawBodyBg;
    const fmtBgDeep   = isDark
                        ? mixRgba(rawBodyBg, "rgb(0,0,0)", 0.25)
                        : mixRgba(rawBodyBg, "rgb(0,0,0)", 0.07);
    const fmtBgMid    = toRgba(isDark ? "255,255,255" : "0,0,0", isDark ? 0.04 : 0.03);
    const fmtBgHi     = toRgba(rawAccent.replace(/^rgba?\(/, "").replace(/,\s*[\d.]+\)$/, "").replace(/\)$/, ""), 0.08);

    const fmtBorder   = rawBorder !== "rgba(0, 0, 0, 0)"
                        ? toRgba(rawBorder.replace(/,\s*[\d.]+\)/, "").replace(/^rgba?\(/, ""), 0.3)
                        : toRgba(rawAccent.replace(/^rgba?\(/, "").replace(/,\s*[\d.]+\)$/, "").replace(/\)$/, ""), 0.22);

    const fmtText     = rawMesText || rawBodyText;
    const fmtTextDim  = toRgba(fmtText.replace(/^rgba?\(/, "").replace(/,\s*[\d.]+\)$/, "").replace(/\)$/, ""), 0.55);
    const fmtAccent   = rawAccent;

    const fmtHeaderBg = isDark
                        ? mixRgba(fmtBg, rawAccent, 0.06)
                        : mixRgba(fmtBg, rawAccent, 0.08);

    const fmtBlurTint = isDark
                        ? "rgba(0,0,0,0.5)"
                        : "rgba(0,0,0,0.25)";

    /* ── Записываем переменные ── */
    const targets = [root, document.getElementById("fmt_overlay")].filter(Boolean);
    targets.forEach(el => {
      el.style.setProperty("--fmt-bg",         fmtBg);
      el.style.setProperty("--fmt-bg-deep",    fmtBgDeep);
      el.style.setProperty("--fmt-bg-mid",     fmtBgMid);
      el.style.setProperty("--fmt-bg-hi",      fmtBgHi);
      el.style.setProperty("--fmt-border",     fmtBorder);
      el.style.setProperty("--fmt-text",       fmtText);
      el.style.setProperty("--fmt-text-dim",   fmtTextDim);
      el.style.setProperty("--fmt-accent",     fmtAccent);
      el.style.setProperty("--fmt-header-bg",  fmtHeaderBg);
      el.style.setProperty("--fmt-blur-tint",  fmtBlurTint);
    });

    /* Также на FAB */
    const fab = document.getElementById("fmt_fab");
    if (fab) {
      fab.style.setProperty("--fmt-bg",        fmtBg);
      fab.style.setProperty("--fmt-accent",    fmtAccent);
      fab.style.setProperty("--fmt-border",    fmtBorder);
      fab.style.setProperty("--fmt-text",      fmtText);
      fab.style.setProperty("--fmt-header-bg", fmtHeaderBg);
    }

    /* Сообщаем другим модулям */
    document.dispatchEvent(new CustomEvent("fmt:theme-apply", {
      detail: { isDark, accent: fmtAccent, bg: fmtBg, text: fmtText }
    }));
  };

  /* ── Авто-перезапуск при смене темы ST ───────────────────────── */

  // ST меняет тему через замену класса на body или через смену CSS-переменных
  const themeObserver = new MutationObserver(() => {
    window.fmtApplyTheme?.();
  });

  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });

  // Также перечитываем при открытии панели
  document.addEventListener("fmt:panel-open", () => {
    window.fmtApplyTheme?.();
  });

})();
