/**
 * Chat Organizer (CO) — SillyTavern Extension
 * v1.1.0
 *
 * Заметки, теги, пин — прямо в списке чатов персонажа (#select_chat_div).
 * Также работает в списке персонажей (#rm_print_characters_block).
 */

(() => {
  'use strict';

  const MODULE_KEY = 'chat_organizer';

  const PRESET_TAGS = Object.freeze([
    { id: 'active',  label: '🔴 Активный', color: '#d44' },
    { id: 'paused',  label: '🟡 Пауза',    color: '#b83' },
    { id: 'done',    label: '🟢 Завершён', color: '#3a7' },
    { id: 'fav',     label: '💜 Любимый',  color: '#95c' },
    { id: 'serious', label: '🔵 Серьёзный',color: '#46b' },
    { id: 'casual',  label: '⚪ Лёгкий',   color: '#777' },
  ]);

  let searchQuery  = '';
  let filterPinned = false;
  let filterTag    = null;
  let chatObserver = null;
  let charObserver = null;

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = { chats: {}, chars: {}, collapsed: false };
    if (!extensionSettings[MODULE_KEY].chats) extensionSettings[MODULE_KEY].chats = {};
    if (!extensionSettings[MODULE_KEY].chars) extensionSettings[MODULE_KEY].chars = {};
    return extensionSettings[MODULE_KEY];
  }

  function getChatData(chatName) {
    const s   = getSettings();
    const key = String(chatName).trim();
    if (!s.chats[key]) s.chats[key] = { note: '', tags: [], pinned: false };
    return s.chats[key];
  }

  function getCharData(chid) {
    const s   = getSettings();
    const key = String(chid);
    if (!s.chars[key]) s.chars[key] = { note: '', tags: [], pinned: false };
    return s.chars[key];
  }

  function save() { ctx().saveSettingsDebounced(); }

  function escHtml(s) {
    return String(s)
      .replaceAll('&','&amp;').replaceAll('<','&lt;')
      .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }

  function formatTs(ts) {
    if (!ts) return '';
    const ms  = ts > 1e12 ? ts : ts * 1000;
    const d   = new Date(ms);
    const now = new Date();
    const dd  = Math.floor((now - d) / 86400000);
    if (dd === 0) return 'сегодня';
    if (dd === 1) return 'вчера';
    if (dd < 7)  return `${dd} дн. назад`;
    return d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit' });
  }

  function tagBadges(tags) {
    return (tags || []).map(tid => {
      const t = PRESET_TAGS.find(p => p.id === tid);
      return t ? `<span class="co-tag-badge" style="--co-tag-color:${t.color}">${t.label}</span>` : '';
    }).join('');
  }

  // ─── Get chat container ────────────────────────────────────────────────────────
  // ST может использовать разные id/классы в зависимости от версии

  function getChatContainer() {
    return document.getElementById('select_chat_div')
      || document.querySelector('.select_chat_div')
      || document.querySelector('[id*="select_chat"]');
  }

  // ─── Read chat name from a list item ──────────────────────────────────────────

  function getChatNameFromItem(el) {
    // ST usually puts filename in data-value or value
    const v = el.getAttribute('data-value') || el.getAttribute('value');
    if (v) return v.replace(/\.jsonl?$/, '').trim();

    // Try common child elements ST uses for the chat name
    const nameEl = el.querySelector('.select_chat_name, .chat_filename, b, strong');
    if (nameEl) return nameEl.textContent.trim().replace(/\.jsonl?$/, '');

    // Fall back to first meaningful text node
    const txt = [...el.childNodes]
      .filter(n => n.nodeType === 3 && n.textContent.trim().length > 4)
      .map(n => n.textContent.trim())[0] || '';
    return txt.replace(/\.jsonl?$/, '').trim();
  }

  // ─── Chat list overlay ────────────────────────────────────────────────────────

  function buildChatOverlay(chatName) {
    const data       = getChatData(chatName);
    const badgesHtml = tagBadges(data.tags);
    return `
      <div class="co-chat-overlay" data-chat="${escHtml(chatName)}">
        <div class="co-meta-row">
          <span class="co-meta-actions">
            <button class="co-pin-btn ${data.pinned ? 'active' : ''}"
              data-chat="${escHtml(chatName)}"
              title="${data.pinned ? 'Открепить' : 'Закрепить'}">📌</button>
            <button class="co-note-btn"
              data-chat="${escHtml(chatName)}"
              title="Заметка / Теги">📝</button>
          </span>
          ${badgesHtml ? `<span class="co-tags-inline">${badgesHtml}</span>` : ''}
        </div>
        ${data.note ? `<div class="co-note-preview">${escHtml(data.note.slice(0,100))}${data.note.length>100?'…':''}</div>` : ''}
      </div>`;
  }

  function injectChatItem(el) {
    el.querySelector('.co-chat-overlay')?.remove();
    const chatName = getChatNameFromItem(el);
    if (!chatName) return;
    el.classList.add('co-has-overlay');
    el.classList.toggle('co-pinned', !!getChatData(chatName).pinned);
    el.insertAdjacentHTML('beforeend', buildChatOverlay(chatName));
  }

  function injectAllChatItems() {
    const container = getChatContainer();
    if (!container) return;
    [...container.children].forEach(el => {
      if (el.id === 'co_chat_toolbar') return; // skip our own toolbar
      injectChatItem(el);
    });
    sortPinnedChatItems(container);
  }

  function refreshChatItem(chatName) {
    document.querySelectorAll('.co-has-overlay').forEach(el => {
      if (getChatNameFromItem(el) === chatName) injectChatItem(el);
    });
    const c = getChatContainer();
    if (c) sortPinnedChatItems(c);
  }

  function sortPinnedChatItems(container) {
    const items = [...container.querySelectorAll('.co-has-overlay')];
    const pinned   = items.filter(el => getChatData(getChatNameFromItem(el)).pinned);
    const unpinned = items.filter(el => !getChatData(getChatNameFromItem(el)).pinned);
    [...pinned, ...unpinned].forEach(el => container.appendChild(el));
  }

  function applyChatFilters() {
    document.querySelectorAll('.co-has-overlay').forEach(el => {
      const chatName = getChatNameFromItem(el);
      const data     = getChatData(chatName);
      const q        = searchQuery;
      const nameOk   = !q || chatName.toLowerCase().includes(q);
      const noteOk   = !q || (data.note || '').toLowerCase().includes(q);
      const pinOk    = !filterPinned || !!data.pinned;
      const tagOk    = !filterTag    || (data.tags || []).includes(filterTag);
      el.style.display = (nameOk || noteOk) && pinOk && tagOk ? '' : 'none';
    });
  }

  // ─── Chat toolbar (search + tag filters) ──────────────────────────────────────

  function ensureChatToolbar() {
    const container = getChatContainer();
    if (!container) return;
    if (document.getElementById('co_chat_toolbar')) return;

    const tagBtns = PRESET_TAGS.map(t =>
      `<button class="co-tag-filter" data-tag="${t.id}" style="--co-tag-color:${t.color}">${t.label}</button>`
    ).join('');

    const toolbar = document.createElement('div');
    toolbar.id        = 'co_chat_toolbar';
    toolbar.innerHTML = `
      <div class="co-search-row">
        <input type="text" id="co_chat_search" placeholder="🔍 Поиск по чатам и заметкам…" autocomplete="off">
        <button id="co_chat_pin_filter" title="Только закреплённые">📌</button>
        <button id="co_chat_reset" title="Сбросить фильтры">✕</button>
      </div>
      <div class="co-tag-filters">${tagBtns}</div>`;

    container.insertAdjacentElement('beforebegin', toolbar);

    document.getElementById('co_chat_search').addEventListener('input', function () {
      searchQuery = this.value.toLowerCase().trim();
      applyChatFilters();
    });
    document.getElementById('co_chat_pin_filter').addEventListener('click', function () {
      filterPinned = !filterPinned;
      this.classList.toggle('active', filterPinned);
      applyChatFilters();
    });
    document.getElementById('co_chat_reset').addEventListener('click', () => {
      searchQuery = ''; filterPinned = false; filterTag = null;
      document.getElementById('co_chat_search').value = '';
      document.getElementById('co_chat_pin_filter').classList.remove('active');
      document.querySelectorAll('#co_chat_toolbar .co-tag-filter').forEach(b => b.classList.remove('active'));
      applyChatFilters();
    });
    toolbar.querySelectorAll('.co-tag-filter').forEach(btn => {
      btn.addEventListener('click', function () {
        const tag = this.getAttribute('data-tag');
        filterTag = filterTag === tag ? null : tag;
        toolbar.querySelectorAll('.co-tag-filter').forEach(b => b.classList.remove('active'));
        if (filterTag) this.classList.add('active');
        applyChatFilters();
      });
    });
  }

  // ─── Character list overlay (secondary) ───────────────────────────────────────

  function buildCharOverlay(chid) {
    const { characters } = ctx();
    const char = characters?.[chid];
    if (!char) return '';
    const data       = getCharData(chid);
    const lastMes    = (char.last_mes || '').replace(/<[^>]*>/g, '').trim();
    const preview    = lastMes.slice(0, 80) + (lastMes.length > 80 ? '…' : '');
    const date       = formatTs(char.date_last_chat);
    const count      = char.chat_size || '';
    const badgesHtml = tagBadges(data.tags);
    return `
      <div class="co-card-overlay" data-chid="${chid}">
        <div class="co-meta-row">
          ${date  ? `<span class="co-meta-date">📅 ${escHtml(date)}</span>` : ''}
          ${count ? `<span class="co-meta-count">💬 ${count}</span>` : ''}
          <span class="co-meta-actions">
            <button class="co-pin-btn ${data.pinned?'active':''}" data-chid="${chid}" title="${data.pinned?'Открепить':'Закрепить'}">📌</button>
            <button class="co-note-btn" data-chid="${chid}" title="Заметка / Теги">📝</button>
          </span>
        </div>
        ${badgesHtml ? `<div class="co-tags-row">${badgesHtml}</div>` : ''}
        ${data.note  ? `<div class="co-note-preview">${escHtml(data.note.slice(0,100))}${data.note.length>100?'…':''}</div>` : ''}
        ${preview    ? `<div class="co-last-mes">${escHtml(preview)}</div>` : ''}
      </div>`;
  }

  function injectCharCard(el) {
    el.querySelector('.co-card-overlay')?.remove();
    const chid = el.getAttribute('chid');
    if (!chid) return;
    el.classList.toggle('co-pinned', !!getCharData(chid).pinned);
    const html = buildCharOverlay(chid);
    if (html) el.insertAdjacentHTML('beforeend', html);
  }

  function injectAllCharCards() {
    document.querySelectorAll('.character_select[chid]').forEach(el => injectCharCard(el));
  }

  function refreshCharCard(chid) {
    const el = document.querySelector(`.character_select[chid="${chid}"]`);
    if (el) injectCharCard(el);
  }

  // ─── Note editor (shared) ─────────────────────────────────────────────────────

  function openNoteEditor({ chatName, chid }) {
    const { Popup } = ctx();
    const isChat = !!chatName;
    const data   = isChat ? getChatData(chatName) : getCharData(chid);
    const title  = isChat ? chatName.slice(0, 55) : (ctx().characters?.[chid]?.name || 'Персонаж');

    const tagCbx = PRESET_TAGS.map(t => `
      <label class="co-tag-ck" style="--co-tag-color:${t.color}">
        <input type="checkbox" class="co-tag-cb" value="${t.id}" ${(data.tags||[]).includes(t.id)?'checked':''}>
        <span>${t.label}</span>
      </label>`).join('');

    Popup.show.text(`📝 ${escHtml(title)}`,
      `<div style="color:#c8deff;font-size:13px">
        <div style="margin-bottom:5px;font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.04em">Теги</div>
        <div class="co-tag-ck-grid">${tagCbx}</div>
        <div style="margin:12px 0 5px;font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.04em">Заметка</div>
        <textarea id="co_note_ta" rows="5"
          placeholder="Что происходит, на чём остановились…"
          style="width:100%;box-sizing:border-box;background:rgba(5,12,25,.9);border:1px solid rgba(100,160,255,.25);color:#c8deff;border-radius:8px;padding:9px 11px;font-size:12px;resize:vertical;font-family:inherit;line-height:1.55"
        >${escHtml(data.note||'')}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <button id="co_note_save"
            style="flex:1;padding:9px 12px;border-radius:8px;border:1px solid rgba(80,200,140,.5);background:rgba(60,180,120,.15);color:#70e8c0;cursor:pointer;font-size:13px;font-weight:700">
            💾 Сохранить
          </button>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;padding:9px 12px;border-radius:8px;border:1px solid rgba(255,200,60,.25);background:rgba(255,200,60,.06)">
            <input type="checkbox" id="co_pin_cb" ${data.pinned?'checked':''}>
            <span style="color:rgba(255,200,60,.9);font-size:12px;font-weight:600">📌 Закреплён</span>
          </label>
        </div>
      </div>`
    );

    setTimeout(() => {
      document.getElementById('co_note_save')?.addEventListener('click', () => {
        const note   = (document.getElementById('co_note_ta')?.value||'').trim();
        const pinned = document.getElementById('co_pin_cb')?.checked ?? false;
        const tags   = [...document.querySelectorAll('.co-tag-cb:checked')].map(cb=>cb.value);
        data.note = note; data.pinned = pinned; data.tags = tags;
        save();
        if (isChat) { refreshChatItem(chatName); applyChatFilters(); }
        else        { refreshCharCard(chid); }
        toastr.success('Заметка сохранена', '', { timeOut: 2000 });
      });
    }, 0);
  }

  // ─── Event delegation ─────────────────────────────────────────────────────────

  function wireEvents() {
    $(document)
      .off('click.co_chat_pin')
      .on('click.co_chat_pin', '.co-chat-overlay .co-pin-btn', function (e) {
        e.stopPropagation(); e.preventDefault();
        const chatName = this.getAttribute('data-chat');
        const data = getChatData(chatName);
        data.pinned = !data.pinned;
        save(); refreshChatItem(chatName); applyChatFilters();
        toastr.info(data.pinned ? '📌 Закреплено' : 'Откреплено', '', { timeOut: 1500 });
      })
      .off('click.co_chat_note')
      .on('click.co_chat_note', '.co-chat-overlay .co-note-btn', function (e) {
        e.stopPropagation(); e.preventDefault();
        openNoteEditor({ chatName: this.getAttribute('data-chat') });
      })
      .off('click.co_char_pin')
      .on('click.co_char_pin', '.co-card-overlay .co-pin-btn', function (e) {
        e.stopPropagation(); e.preventDefault();
        const chid = this.getAttribute('data-chid');
        const data = getCharData(chid);
        data.pinned = !data.pinned;
        save(); refreshCharCard(chid);
        toastr.info(data.pinned ? '📌 Закреплено' : 'Откреплено', '', { timeOut: 1500 });
      })
      .off('click.co_char_note')
      .on('click.co_char_note', '.co-card-overlay .co-note-btn', function (e) {
        e.stopPropagation(); e.preventDefault();
        openNoteEditor({ chid: this.getAttribute('data-chid') });
      });
  }

  // ─── Observers ────────────────────────────────────────────────────────────────

  function watchForChatList() {
    // Watch body for #select_chat_div being added dynamically
    new MutationObserver(() => {
      const c = getChatContainer();
      if (c && !c.dataset.coInit) {
        c.dataset.coInit = '1';
        ensureChatToolbar();
        injectAllChatItems();

        if (chatObserver) chatObserver.disconnect();
        chatObserver = new MutationObserver(() => {
          setTimeout(() => { ensureChatToolbar(); injectAllChatItems(); applyChatFilters(); }, 60);
        });
        chatObserver.observe(c, { childList: true });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function watchCharList() {
    const c = document.getElementById('rm_print_characters_block');
    if (!c || charObserver) return;
    charObserver = new MutationObserver(() => setTimeout(injectAllCharCards, 60));
    charObserver.observe(c, { childList: true });
  }

  // ─── Settings panel ───────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#co_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    const s = getSettings();
    $(target).append(`
      <div id="co_settings_block">
        <div class="co-settings-title">
          <span>📂 Органайзер чатов</span>
          <button id="co_collapse_btn">${s.collapsed?'▸':'▾'}</button>
        </div>
        <div id="co_settings_body" ${s.collapsed?'style="display:none"':''}>
          <div class="co-settings-desc">
            Заметки, теги и 📌 прямо в списке чатов.<br>
            Тулбар поиска появляется над списком чатов автоматически.
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
            <button class="menu_button" id="co_rescan_btn" style="font-size:11px;padding:5px 10px">🔄 Обновить</button>
            <button class="menu_button" id="co_clear_all_btn"
              style="font-size:11px;padding:5px 10px;color:rgba(210,140,140,.8);border-color:rgba(200,80,80,.2)">
              🗑️ Сбросить все заметки
            </button>
          </div>
        </div>
      </div>`);

    $('#co_collapse_btn').on('click', () => {
      s.collapsed = !s.collapsed;
      $('#co_settings_body').toggle(!s.collapsed);
      $('#co_collapse_btn').text(s.collapsed?'▸':'▾');
      save();
    });
    $('#co_rescan_btn').on('click', () => {
      injectAllChatItems(); injectAllCharCards();
      toastr.success('Обновлено','',{timeOut:1500});
    });
    $('#co_clear_all_btn').on('click', async () => {
      const ok = await ctx().Popup.show.confirm('Сбросить все заметки и теги?','Нельзя отменить.');
      if (!ok) return;
      const s2 = getSettings(); s2.chats={}; s2.chars={};
      save(); injectAllChatItems(); injectAllCharCards();
      toastr.success('Все заметки удалены');
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try {
      const { eventSource, event_types } = ctx();

      eventSource.on(event_types.APP_READY, async () => {
        wireEvents();
        watchForChatList();
        watchCharList();
        injectAllCharCards();
        await mountSettingsUi();
      });

      eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => { injectAllChatItems(); injectAllCharCards(); }, 400);
      });

      // Safety net: if chat list is already in DOM on load
      setTimeout(() => {
        const c = getChatContainer();
        if (c) { ensureChatToolbar(); injectAllChatItems(); }
        injectAllCharCards();
      }, 1500);

      console.log('[CO] v1.1.0 loaded');
    } catch(e) { console.error('[CO] init failed', e); }
  });

})();
