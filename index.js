(() => {
  'use strict';

  const MODULE_KEY = 'janitor_script_importer';

  const defaultSettings = Object.freeze({
    enabled: true,
    namePrefix: 'Janitor - ',
    useServerDownloadFallback: true, // если CORS/Cloudflare не даст fetch
  });

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY]) extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings)) {
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k)) extensionSettings[MODULE_KEY][k] = defaultSettings[k];
    }
    return extensionSettings[MODULE_KEY];
  }

  // ---------- UI (Extensions settings) ----------

  async function mountSettingsUi() {
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;
    if ($('#jsi_settings_block').length) return;

    const s = getSettings();

    $(target).append(`
      <div id="jsi_settings_block">
        <div class="jsi_title">📥 Janitor /scripts → World Info</div>

        <div class="jsi_row">
          <input type="text" id="jsi_url"
            placeholder="https://janitorai.com/scripts/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          <button class="menu_button" id="jsi_import_btn">Импорт</button>
        </div>

        <div class="jsi_row">
          <label class="jsi_ck">
            <input type="checkbox" id="jsi_enabled" ${s.enabled ? 'checked' : ''}>
            <span>Включено</span>
          </label>

          <label class="jsi_ck" style="margin-left:10px">
            <input type="checkbox" id="jsi_fallback" ${s.useServerDownloadFallback ? 'checked' : ''}>
            <span>Fallback через сервер ST</span>
          </label>
        </div>

        <div class="jsi_help">
          Вставь ссылку вида <code>janitorai.com/scripts/UUID</code> и нажми Импорт.<br>
          Создаст новый World Info (лорбук) и добавит туда entries.
        </div>

        <div class="jsi_status" id="jsi_status"></div>
      </div>
    `);

    $('#jsi_enabled').on('change', () => {
      getSettings().enabled = $('#jsi_enabled').prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#jsi_fallback').on('change', () => {
      getSettings().useServerDownloadFallback = $('#jsi_fallback').prop('checked');
      ctx().saveSettingsDebounced();
    });

    $('#jsi_import_btn').on('click', async () => {
      const url = String($('#jsi_url').val() ?? '').trim();
      await importFromUrlFlow(url);
    });

    $('#jsi_url').on('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const url = String($('#jsi_url').val() ?? '').trim();
        await importFromUrlFlow(url);
      }
    });
  }

  function setStatus(t) { $('#jsi_status').text(t ? String(t) : ''); }

  // ---------- URL helpers ----------

  function isJanitorScriptsUrl(url) {
    return typeof url === 'string' && /https?:\/\/(www\.)?janitorai\.com\/scripts\/[a-f0-9\-]{36}/i.test(url);
  }

  function extractUuidFromUrl(url) {
    const m = String(url).match(/\/scripts\/([a-f0-9\-]{36})/i);
    return m ? m[1] : null;
  }

  function normalizeKeys(v) {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    const s = String(v ?? '').trim();
    if (!s) return [];
    return s.split(/[,;|\n]/g).map(x => x.trim()).filter(Boolean);
  }

  // ---------- Fetch (direct + fallback) ----------

  async function fetchTextDirect(url) {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.text();
  }

  async function fetchTextViaServer(url) {
    // Важно: эта возможность связана с whitelistImportDomains в config.yaml (ST 1.16+)
    // иначе сервер может отказать (и это правильно).
    // См. advisory: введён whitelist для asset download запросов. :contentReference[oaicite:4]{index=4}
    const resp = await fetch('/api/assets/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, category: 'world', filename: `janitor_${Date.now()}.txt` }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Server fallback failed: ${resp.status} ${resp.statusText} ${t}`.trim());
    }
    return await resp.text();
  }

  async function fetchText(url) {
    const s = getSettings();
    try {
      return await fetchTextDirect(url);
    } catch (e) {
      if (!s.useServerDownloadFallback) throw new Error('Direct fetch blocked (CORS/Cloudflare). Включи fallback.');
      // Разрешаем fallback только на janitorai.com, чтобы не делать “скачай что угодно”.
      if (!/^https?:\/\/(www\.)?janitorai\.com\//i.test(url)) throw new Error('Fallback разрешён только для janitorai.com');
      return await fetchTextViaServer(url);
    }
  }

  async function fetchJson(url) {
    const text = await fetchText(url);
    try { return JSON.parse(text); } catch {}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Не смог распарсить JSON');
  }

  function extractNextData(html) {
    const m = String(html).match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  function deepFindLikelyScript(obj) {
    const stack = [obj];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      const entries =
        cur.entries ||
        cur.lorebook?.entries ||
        cur.script?.entries ||
        cur.data?.entries;

      const title =
        cur.name || cur.title || cur.script?.name || cur.script?.title || cur.data?.name || cur.data?.title;

      if (title && Array.isArray(entries)) return cur;
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
    return null;
  }

  async function fetchJanitorScript(uuid36, pageUrl) {
    // Janitor endpoint’ы гуляли, поэтому пробуем несколько вариантов + __NEXT_DATA__ со страницы
    const candidates = [
      `https://janitorai.com/api/scripts/${uuid36}`,
      `https://janitorai.com/api/script/${uuid36}`,
    ];

    for (const u of candidates) {
      try {
        const j = await fetchJson(u);
        if (j && typeof j === 'object') return j;
      } catch {}
    }

    const html = await fetchText(pageUrl);
    const next = extractNextData(html);
    if (next) return next;

    throw new Error('Не смог получить данные (API и __NEXT_DATA__ не сработали)');
  }

  // ---------- Convert Janitor → ST World Info ----------

  function normalizeJanitor(raw, uuid36) {
    const root = deepFindLikelyScript(raw) || raw;

    const title =
      root.name || root.title ||
      root.script?.name || root.script?.title ||
      root.data?.name || root.data?.title ||
      `Script ${uuid36.slice(0, 8)}`;

    const sourceEntries =
      (Array.isArray(root.entries) && root.entries) ||
      (Array.isArray(root.script?.entries) && root.script.entries) ||
      (Array.isArray(root.lorebook?.entries) && root.lorebook.entries) ||
      (Array.isArray(root.data?.entries) && root.data.entries) ||
      [];

    const entries = [];
    for (const e of sourceEntries) {
      if (!e || typeof e !== 'object') continue;

      const keys = normalizeKeys(e.keywords ?? e.keys ?? e.triggers ?? e.trigger ?? e.triggerWords ?? []);
      const content = String(e.content ?? e.text ?? e.body ?? e.description ?? '').trim();
      const comment = String(e.name ?? e.title ?? e.comment ?? '').trim();

      if (!content && !keys.length) continue;

      entries.push({
        key: keys.length ? keys : ['*'],
        comment,
        content,
        order: Number.isFinite(+e.order) ? +e.order : (Number.isFinite(+e.priority) ? +e.priority : 100),
        constant: !!e.constant,
        disable: !!e.disable,
      });
    }

    return { title, entries };
  }

  // ---------- Save to World Info через world-info.js ----------

  async function worldInfoApi() {
    // В браузерном контексте ST world-info.js лежит в /scripts/world-info.js
    // Мы находимся в /scripts/extensions/<ext>/index.js → два уровня вверх.
    return await import('../../world-info.js');
  }

  function sanitizeName(name) {
    return String(name)
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || `Janitor - ${Date.now()}`;
  }

  async function createAndFillWorldInfo(title, entries) {
    const s = getSettings();
    const wi = await worldInfoApi();

    const baseName = sanitizeName(`${s.namePrefix || ''}${title}`);

    // если имя занято — добавим суффикс
    const existing = new Set((wi.world_names || []).map(x => String(x).toLowerCase()));
    let finalName = baseName;
    if (existing.has(baseName.toLowerCase())) {
      for (let i = 2; i < 999; i++) {
        const cand = `${baseName} (${i})`;
        if (!existing.has(cand.toLowerCase())) { finalName = cand; break; }
      }
    }

    await wi.createNewWorldInfo(finalName, { interactive: false });
    const book = await wi.loadWorldInfo(finalName);

    for (const e of entries) {
      const dst = wi.createWorldInfoEntry(null, book);
      dst.key = e.key;
      dst.comment = e.comment || '';
      dst.content = e.content || '';
      dst.order = Number.isFinite(+e.order) ? +e.order : 100;
      dst.constant = !!e.constant;
      dst.disable = !!e.disable;
    }

    await wi.saveWorldInfo(finalName, book, true);
    return finalName;
  }

  // ---------- Main flow ----------

  async function importFromUrlFlow(url) {
    const s = getSettings();
    if (!s.enabled) { toastr.warning('[JSI] Отключено'); return; }

    if (!isJanitorScriptsUrl(url)) {
      toastr.error('[JSI] Нужна ссылка вида https://janitorai.com/scripts/<UUID>');
      return;
    }

    const id = extractUuidFromUrl(url);
    if (!id) { toastr.error('[JSI] Не смог вытащить UUID'); return; }

    try {
      setStatus('Скачиваю…');
      const raw = await fetchJanitorScript(id, url);

      setStatus('Конвертирую…');
      const norm = normalizeJanitor(raw, id);
      if (!norm.entries.length) throw new Error('Entries не найдены (формат изменился или пусто)');

      setStatus('Сохраняю в World Info…');
      const name = await createAndFillWorldInfo(norm.title, norm.entries);

      setStatus(`Готово: ${name} (${norm.entries.length})`);
      toastr.success(`✅ Импортировано: ${name} (${norm.entries.length})`);
    } catch (e) {
      console.error('[JSI] import failed', e);
      setStatus('Ошибка');
      toastr.error(`[JSI] ${e?.message || e}`);
      // если fallback включён и всё равно не вышло — почти всегда это whitelistImportDomains на сервере
      // см. advisory про whitelist и config.yaml. :contentReference[oaicite:5]{index=5}
    }
  }

  // ---------- Init ----------
  jQuery(async () => {
    try {
      getSettings();
      await mountSettingsUi();
      console.log('[JSI] Loaded');
    } catch (e) {
      console.error('[JSI] init failed', e);
    }
  });

})();
