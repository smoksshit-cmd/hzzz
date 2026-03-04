(() => {
  'use strict';

  const MODULE_KEY = 'janitor_script_importer';

  const defaultSettings = Object.freeze({
    enabled: true,
    namePrefix: 'Janitor - ',

    // Порядок: direct -> proxies -> (optional) server fallback
    tryDirectFetch: true,

    // Несколько прокси: какие-то могут умереть/резать/переписывать.
    // allorigins обычно отдаёт сырой контент и лучше для JSON, чем jina.
    proxyMode: 'auto', // auto|off
    proxies: [
      // allorigins raw
      (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
      // jina reader (иногда полезно, иногда нет)
      (url) => `https://r.jina.ai/${url}`,
    ],

    // server fallback выключен (у многих 403 без whitelist)
    useServerDownloadFallback: false,
  });

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY]) extensionSettings[MODULE_KEY] = structuredClone(defaultSettings);
    for (const k of Object.keys(defaultSettings)) {
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k)) {
        extensionSettings[MODULE_KEY][k] = defaultSettings[k];
      }
    }
    return extensionSettings[MODULE_KEY];
  }

  // ---------- UI ----------

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

        <div class="jsi_btnrow">
          <button class="menu_button" id="jsi_import_json_btn" title="Вставить готовый JSON формата World Info">
            Импорт из JSON (вставить)
          </button>
          <button class="menu_button" id="jsi_debug_btn" title="Показать отладочную информацию последней загрузки">
            Debug
          </button>
        </div>

        <div class="jsi_row">
          <label class="jsi_ck">
            <input type="checkbox" id="jsi_enabled" ${s.enabled ? 'checked' : ''}>
            <span>Включено</span>
          </label>

          <label class="jsi_ck" style="margin-left:10px">
            <input type="checkbox" id="jsi_direct" ${s.tryDirectFetch ? 'checked' : ''}>
            <span>Сначала direct fetch</span>
          </label>

          <label class="jsi_ck" style="margin-left:10px">
            <input type="checkbox" id="jsi_proxy" ${s.proxyMode !== 'off' ? 'checked' : ''}>
            <span>Использовать прокси (если надо)</span>
          </label>

          <label class="jsi_ck" style="margin-left:10px">
            <input type="checkbox" id="jsi_server" ${s.useServerDownloadFallback ? 'checked' : ''}>
            <span>Server fallback (/api/assets/download)</span>
          </label>
        </div>

        <div class="jsi_warn">
          Если Janitor режет CORS/Cloudflare — расширение попробует прокси (allorigins/jina).<br>
          Server fallback часто даёт 403 без whitelist — поэтому по умолчанию выключен.
        </div>

        <div class="jsi_help">
          Поддерживает <code>https://janitorai.com/scripts/UUID</code>.<br>
          Создаёт новый World Info и добавляет entries (keys/content/order и дефолты ST).
        </div>

        <div class="jsi_status" id="jsi_status"></div>
      </div>
    `);

    $('#jsi_enabled').on('change', () => { getSettings().enabled = $('#jsi_enabled').prop('checked'); ctx().saveSettingsDebounced(); });
    $('#jsi_direct').on('change',  () => { getSettings().tryDirectFetch = $('#jsi_direct').prop('checked'); ctx().saveSettingsDebounced(); });
    $('#jsi_proxy').on('change',   () => { getSettings().proxyMode = $('#jsi_proxy').prop('checked') ? 'auto' : 'off'; ctx().saveSettingsDebounced(); });
    $('#jsi_server').on('change',  () => { getSettings().useServerDownloadFallback = $('#jsi_server').prop('checked'); ctx().saveSettingsDebounced(); });

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

    $('#jsi_import_json_btn').on('click', async () => {
      await importFromPastedJsonFlow();
    });

    $('#jsi_debug_btn').on('click', async () => {
      await showDebug();
    });
  }

  function setStatus(t) {
    $('#jsi_status').text(t ? String(t) : '');
  }

  // ---------- URL helpers ----------

  function isJanitorScriptsUrl(url) {
    return typeof url === 'string'
      && /https?:\/\/(www\.)?janitorai\.com\/scripts\/[a-f0-9\-]{36}/i.test(url);
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

  // ---------- Debug storage ----------

  let LAST_DEBUG = null;
  function saveDebug(info) { LAST_DEBUG = info; }
  async function showDebug() {
    const { Popup } = ctx();
    const text = LAST_DEBUG ? JSON.stringify(LAST_DEBUG, null, 2) : 'Нет данных. Сначала попробуй импорт.';
    await Popup.show.text('JSI Debug', `<pre style="white-space:pre-wrap;max-height:60vh;overflow:auto">${escapeHtml(text)}</pre>`);
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  // ---------- Fetch methods ----------

  async function fetchTextDirect(url) {
    const r = await fetch(url, { method: 'GET' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.text();
  }

  async function fetchTextViaServer(url) {
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

  function looksLikeHtml(t) {
    const s = String(t ?? '').trim().slice(0, 300).toLowerCase();
    return s.startsWith('<!doctype') || s.startsWith('<html') || s.includes('<head') || s.includes('<body');
  }

  function looksLikeCloudflare(t) {
    const s = String(t ?? '').toLowerCase();
    return s.includes('cloudflare') || s.includes('attention required') || s.includes('checking your browser');
  }

  async function fetchTextSmart(url) {
    const s = getSettings();
    const attempts = [];
    const errors = [];

    if (s.tryDirectFetch) attempts.push({ kind: 'direct', run: () => fetchTextDirect(url) });

    if (s.proxyMode !== 'off') {
      for (const build of (s.proxies || [])) {
        attempts.push({ kind: 'proxy', run: () => fetchTextDirect(build(url)), proxy: build(url) });
      }
    }

    if (s.useServerDownloadFallback) attempts.push({ kind: 'server', run: () => fetchTextViaServer(url) });

    for (const a of attempts) {
      try {
        const text = await a.run();
        // если пришёл cloudflare/html вместо json — считаем это неуспехом для API
        if (looksLikeCloudflare(text)) throw new Error('Cloudflare/challenge page');
        saveDebug({ step: 'fetchTextSmart', url, attempt: a, sample: String(text).slice(0, 600) });
        return text;
      } catch (e) {
        errors.push(`${a.kind}${a.proxy ? `(${a.proxy})` : ''}: ${e?.message || e}`);
      }
    }

    saveDebug({ step: 'fetchTextSmart_failed', url, errors });
    throw new Error(`Не удалось скачать: ${errors.join(' | ')}`);
  }

  // ---------- Robust JSON parsing ----------

  function stripBom(s) { return String(s ?? '').replace(/^\uFEFF/, ''); }
  function tryParseJson(s) { try { return JSON.parse(s); } catch { return null; } }

  function extractFromFences(text) {
    const t = String(text ?? '');
    const re = /```(?:json)?\s*([\s\S]*?)```/gi;
    const blocks = [];
    let m;
    while ((m = re.exec(t))) blocks.push(m[1]);
    for (let i = blocks.length - 1; i >= 0; i--) {
      const p = tryParseJson(stripBom(blocks[i].trim()));
      if (p !== null) return p;
    }
    return null;
  }

  function extractNextData(html) {
    const m = String(html).match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    return tryParseJson(stripBom(m[1]));
  }

  function extractBalancedJson(text) {
    const s = String(text ?? '');
    const startObj = s.indexOf('{');
    const startArr = s.indexOf('[');
    let start = -1;
    if (startObj === -1) start = startArr;
    else if (startArr === -1) start = startObj;
    else start = Math.min(startObj, startArr);
    if (start === -1) return null;

    const openChar = s[start];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];

      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = false; continue; }
        continue;
      } else {
        if (ch === '"') { inStr = true; continue; }
        if (ch === openChar) depth++;
        if (ch === closeChar) depth--;
        if (depth === 0) {
          const candidate = s.slice(start, i + 1);
          const parsed = tryParseJson(stripBom(candidate));
          if (parsed !== null) return parsed;
        }
      }
    }
    return null;
  }

  async function fetchJsonSmart(url) {
    const text = stripBom(await fetchTextSmart(url));

    // 1) чистый JSON
    const direct = tryParseJson(text.trim());
    if (direct !== null) return direct;

    // 2) fenced JSON (прокси иногда так отдаёт)
    const fenced = extractFromFences(text);
    if (fenced !== null) return fenced;

    // 3) __NEXT_DATA__ (если это HTML страница)
    const next = extractNextData(text);
    if (next !== null) return next;

    // 4) балансная эвристика
    const balanced = extractBalancedJson(text);
    if (balanced !== null) return balanced;

    saveDebug({ step: 'fetchJsonSmart_failed', url, sample: text.slice(0, 1200) });
    throw new Error('Не смог распарсить JSON/NextData');
  }

  // ---------- Locate likely script object ----------

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
        cur.data?.entries ||
        cur.props?.pageProps?.entries ||
        cur.props?.pageProps?.script?.entries ||
        cur.props?.pageProps?.lorebook?.entries;

      const title =
        cur.name || cur.title ||
        cur.script?.name || cur.script?.title ||
        cur.data?.name || cur.data?.title ||
        cur.props?.pageProps?.name || cur.props?.pageProps?.title ||
        cur.props?.pageProps?.script?.name || cur.props?.pageProps?.script?.title;

      if (title && Array.isArray(entries)) return cur;

      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }

    return null;
  }

  // ---------- Download Janitor (API first) ----------

  async function fetchJanitorScript(uuid36, pageUrl) {
    const apiCandidates = [
      `https://janitorai.com/api/scripts/${uuid36}`,
      `https://janitorai.com/api/script/${uuid36}`,
    ];

    // 1) API
    for (const u of apiCandidates) {
      try {
        const j = await fetchJsonSmart(u);
        if (j && typeof j === 'object') return j;
      } catch (_) {}
    }

    // 2) Page (последний шанс)
    const pageObj = await fetchJsonSmart(pageUrl);
    if (pageObj && typeof pageObj === 'object') return pageObj;

    throw new Error('Не смог получить данные Janitor ни через API, ни через страницу');
  }

  // ---------- Convert Janitor → entries[] ----------

  function normalizeJanitor(raw, uuid36) {
    const root = deepFindLikelyScript(raw) || raw;

    const title =
      root.name || root.title ||
      root.script?.name || root.script?.title ||
      root.data?.name || root.data?.title ||
      root.props?.pageProps?.name || root.props?.pageProps?.title ||
      root.props?.pageProps?.script?.name || root.props?.pageProps?.script?.title ||
      `Script ${uuid36.slice(0, 8)}`;

    const sourceEntries =
      (Array.isArray(root.entries) && root.entries) ||
      (Array.isArray(root.script?.entries) && root.script.entries) ||
      (Array.isArray(root.lorebook?.entries) && root.lorebook.entries) ||
      (Array.isArray(root.data?.entries) && root.data.entries) ||
      (Array.isArray(root.props?.pageProps?.entries) && root.props.pageProps.entries) ||
      (Array.isArray(root.props?.pageProps?.script?.entries) && root.props.pageProps.script.entries) ||
      (Array.isArray(root.props?.pageProps?.lorebook?.entries) && root.props.pageProps.lorebook.entries) ||
      [];

    const entries = [];
    for (const e of sourceEntries) {
      if (!e || typeof e !== 'object') continue;

      const keys = normalizeKeys(
        e.keywords ?? e.keys ?? e.triggers ?? e.trigger ?? e.triggerWords ?? e.activation ?? e.match ?? []
      );

      const content = String(e.content ?? e.text ?? e.body ?? e.description ?? e.value ?? '').trim();
      const comment = String(e.name ?? e.title ?? e.comment ?? e.memo ?? '').trim();

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

  // ---------- Save to World Info using ST internals ----------

  async function worldInfoApi() {
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

  // ---------- Extra: import from pasted JSON (WorldInfo format like Eldoria.json) ----------

  async function importFromPastedJsonFlow() {
    const { Popup } = ctx();
    const raw = await Popup.show.input(
      'Импорт World Info JSON',
      'Вставь JSON книги World Info (формат как у Eldoria.json: {"entries":{...}} )',
      ''
    );
    if (!raw) return;

    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.entries || typeof obj.entries !== 'object') {
        throw new Error('Неверный формат: ожидался объект с полем "entries"');
      }

      const title = `Imported ${Date.now()}`;
      const wi = await worldInfoApi();

      const name = sanitizeName(`${getSettings().namePrefix}${title}`);
      await wi.createNewWorldInfo(name, { interactive: false });

      // saveWorldInfo ожидает объект книги; проще загрузить пустую и заменить entries
      const book = await wi.loadWorldInfo(name);
      book.entries = obj.entries;

      await wi.saveWorldInfo(name, book, true);
      toastr.success(`✅ Импортировано World Info: ${name}`);
      setStatus(`Готово: ${name}`);
    } catch (e) {
      toastr.error(`Ошибка импорта JSON: ${e?.message || e}`);
      setStatus(`Ошибка: ${e?.message || e}`);
    }
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
      setStatus('Скачиваю Janitor (API → page)…');
      const raw = await fetchJanitorScript(id, url);

      setStatus('Конвертирую entries…');
      const norm = normalizeJanitor(raw, id);
      if (!norm.entries.length) throw new Error('Entries не найдены (Janitor формат изменился или пусто)');

      setStatus('Сохраняю в World Info…');
      const name = await createAndFillWorldInfo(norm.title, norm.entries);

      setStatus(`Готово: ${name}\nentries: ${norm.entries.length}`);
      toastr.success(`✅ Импортировано: ${name} (${norm.entries.length})`);
    } catch (e) {
      console.error('[JSI] import failed', e);
      setStatus(`Ошибка: ${e?.message || e}`);
      toastr.error(`[JSI] ${e?.message || e}`);
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
