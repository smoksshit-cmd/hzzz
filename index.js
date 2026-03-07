/**
 * Chat Notes Tracker (CNT) — SillyTavern Extension
 * v1.0.0
 *
 * Features:
 *  - Per-chat notes: write what's happening in each chat
 *  - Last message preview in the recent chats list
 *  - Pin important chats to the top
 *  - Quick note button inside active chat
 *  - All data stored in localStorage (per ST instance)
 */

(() => {
  'use strict';

  const MODULE_KEY  = 'chat_notes_tracker';
  const STORAGE_KEY = 'cnt_data_v1';

  // ─── Storage ──────────────────────────────────────────────────────────────────

  function loadData() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { return {}; }
  }

  function saveData(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }

  function getChatData(chatId) {
    const data = loadData();
    if (!data[chatId]) data[chatId] = { note: '', pinned: false, ts: Date.now() };
    return data[chatId];
  }

  function setChatData(chatId, patch) {
    const data = loadData();
    if (!data[chatId]) data[chatId] = { note: '', pinned: false, ts: Date.now() };
    Object.assign(data[chatId], patch);
    saveData(data);
  }

  // ─── ST context ───────────────────────────────────────────────────────────────

  function ctx() { return SillyTavern.getContext(); }

  function getCurrentChatId() {
    const c = ctx();
    return (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : null)
      || c.chatId || c.chat_id || null;
  }

  function getCurrentCharName() {
    const c = ctx();
    try {
      if (c.characterId !== undefined && c.characters?.[c.characterId]?.name)
        return c.characters[c.characterId].name;
      if (c.groupId !== undefined)
        return c.groups?.find?.(g => g.id === c.groupId)?.name ?? null;
    } catch {}
    return null;
  }

  // ─── Quick note FAB (inside active chat) ─────────────────────────────────────

  function ensureQuickNote() {
    if ($('#cnt_quick_btn').length) return;

    // Inject button near the send area
    const $target = $('#send_but_sheld, #rightSendForm, #chat_input_area').first();
    if (!$target.length) return;

    $target.css('position', 'relative');
    $target.append(`
      <button type="button" id="cnt_quick_btn" title="Заметка к этому чату">
        📝
      </button>
    `);

    $('#cnt_quick_btn').on('click', () => openQuickNotePopup());
  }

  function openQuickNotePopup() {
    const chatId = getCurrentChatId();
    if (!chatId) { toastr.warning('[CNT] Нет активного чата'); return; }

    const data    = getChatData(chatId);
    const charName = getCurrentCharName() || chatId;

    // No await — popup timing fix
    ctx().Popup.show.text(`📝 Заметка — ${charName}`,
      `<div style="font-size:13px">
        <div style="margin-bottom:8px;font-size:11px;opacity:.6">
          Напиши о чём этот чат — отображается в списке недавних
        </div>
        <textarea id="cnt_note_ta"
          placeholder="Напр.: детектив Алиса расследует убийство, подозревает Виктора…"
          style="width:100%;height:110px;background:rgba(5,12,25,.9);border:1px solid rgba(100,160,255,0.25);color:#c8deff;border-radius:8px;padding:9px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box"
          maxlength="300">${escHtml(data.note || '')}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:rgba(200,220,255,.8)">
            <input type="checkbox" id="cnt_pin_cb" ${data.pinned ? 'checked' : ''}> 📌 Закрепить в списке
          </label>
          <span id="cnt_char_count" style="font-size:10px;opacity:.45">${(data.note||'').length}/300</span>
        </div>
        <button id="cnt_note_save"
          style="width:100%;margin-top:10px;padding:9px;border-radius:8px;border:1px solid rgba(80,200,140,0.5);background:rgba(60,180,120,0.15);color:#70e8c0;cursor:pointer;font-size:13px;font-weight:700">
          💾 Сохранить
        </button>
      </div>`
    );

    setTimeout(() => {
      const $ta = $('#cnt_note_ta');
      $ta.on('input', () => {
        $('#cnt_char_count').text(`${$ta.val().length}/300`);
      });

      document.getElementById('cnt_note_save')?.addEventListener('click', () => {
        const note   = ($ta.val() || '').trim();
        const pinned = document.getElementById('cnt_pin_cb')?.checked ?? false;
        setChatData(chatId, { note, pinned, ts: Date.now() });
        toastr.success('Заметка сохранена', '', { timeOut: 2000 });
        decorateRecentChats();
      });
    }, 0);
  }

  // ─── Recent chats decoration ──────────────────────────────────────────────────

  // ST renders recent chats as .character_select elements inside #rm_print_characters_block
  // or similar. We hook into those and inject our note + pin indicator.

  function getChatIdFromElement(el) {
    // ST puts the chat filename in various data attrs — try them all
    return el.getAttribute('data-id')
      || el.getAttribute('data-chat')
      || el.getAttribute('data-filename')
      || el.querySelector('[data-id]')?.getAttribute('data-id')
      || null;
  }

  function getLastMessagePreview(chatId) {
    // Try to find the chat in ST's loaded chats
    try {
      const c = ctx();
      // If this is the current open chat
      if (getCurrentChatId() === chatId && Array.isArray(c.chat) && c.chat.length) {
        const last = [...c.chat].reverse().find(m => !m.is_system && (m.mes || '').trim());
        if (last) {
          const who = last.is_user ? '👤' : '🤖';
          return `${who} ${(last.mes || '').trim().slice(0, 80).replace(/\n/g, ' ')}…`;
        }
      }
    } catch {}
    return null;
  }

  function decorateRecentChats() {
    const data = loadData();

    // Target: list items in the recent chats panel
    // ST uses various selectors depending on version
    const selectors = [
      '#rm_print_characters_block .character_select',
      '#rm_print_characters_block .bogus_folder_select',
      '.recent_chat',
      '.select_chat_block',
      '[data-id]',
    ];

    let $items = $();
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length > 2) { $items = found; break; }
    }

    if (!$items.length) return;

    // Collect pinned IDs for sorting hint
    const pinned = new Set(Object.keys(data).filter(id => data[id]?.pinned));

    $items.each(function () {
      const $el   = $(this);
      const chatId = getChatIdFromElement(this);
      if (!chatId) return;

      const chatData = data[chatId];
      const note     = chatData?.note || '';
      const isPinned = chatData?.pinned || false;

      // Remove old decoration
      $el.find('.cnt-decoration').remove();
      $el.css('position', 'relative');

      // Pin indicator
      if (isPinned) {
        $el.prepend(`<span class="cnt-decoration cnt-pin-badge" title="Закреплён">📌</span>`);
        // Move pinned items visually to top (CSS order)
        $el.css('order', '-1');
      } else {
        $el.css('order', '');
      }

      // Note preview
      if (note) {
        // Check if note block already injected
        if (!$el.find('.cnt-note-preview').length) {
          $el.append(`
            <div class="cnt-decoration cnt-note-preview" title="${escHtml(note)}">
              📝 ${escHtml(note.slice(0, 70))}${note.length > 70 ? '…' : ''}
            </div>
          `);
        } else {
          $el.find('.cnt-note-preview')
            .attr('title', escHtml(note))
            .html(`📝 ${escHtml(note.slice(0, 70))}${note.length > 70 ? '…' : ''}`);
        }
      }

      // Last message preview (only for current open chat — others need file reads)
      const preview = getLastMessagePreview(chatId);
      if (preview && !$el.find('.cnt-last-msg').length) {
        $el.append(`
          <div class="cnt-decoration cnt-last-msg" title="${escHtml(preview)}">
            ${escHtml(preview.slice(0, 90))}${preview.length > 90 ? '…' : ''}
          </div>
        `);
      }

      // Add quick edit button on hover
      if (!$el.find('.cnt-edit-btn').length) {
        const $editBtn = $(`
          <button class="cnt-decoration cnt-edit-btn" title="Редактировать заметку">✏️</button>
        `);
        $editBtn.on('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          openNoteEditor(chatId, $el.find('.character_name_text, .ch_name, span').first().text().trim() || chatId);
        });
        $el.append($editBtn);
      }
    });

    // Apply flex column with order support to parent
    $items.parent().css('display', 'flex').css('flex-direction', 'column');
  }

  function openNoteEditor(chatId, label) {
    const data    = getChatData(chatId);

    ctx().Popup.show.text(`📝 Заметка — ${escHtml(label)}`,
      `<div style="font-size:13px">
        <div style="margin-bottom:8px;font-size:11px;opacity:.6">
          Напиши о чём этот чат — отображается в списке
        </div>
        <textarea id="cnt_note_ta2"
          placeholder="Напр.: детектив Алиса расследует убийство…"
          style="width:100%;height:110px;background:rgba(5,12,25,.9);border:1px solid rgba(100,160,255,0.25);color:#c8deff;border-radius:8px;padding:9px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box"
          maxlength="300">${escHtml(data.note || '')}</textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;color:rgba(200,220,255,.8)">
            <input type="checkbox" id="cnt_pin_cb2" ${data.pinned ? 'checked' : ''}> 📌 Закрепить
          </label>
          <button id="cnt_note_clear"
            style="background:none;border:1px solid rgba(200,80,80,0.3);color:rgba(210,140,140,.7);padding:3px 10px;border-radius:6px;cursor:pointer;font-size:11px">
            🗑 Очистить
          </button>
        </div>
        <button id="cnt_note_save2"
          style="width:100%;margin-top:10px;padding:9px;border-radius:8px;border:1px solid rgba(80,200,140,0.5);background:rgba(60,180,120,0.15);color:#70e8c0;cursor:pointer;font-size:13px;font-weight:700">
          💾 Сохранить
        </button>
      </div>`
    );

    setTimeout(() => {
      document.getElementById('cnt_note_save2')?.addEventListener('click', () => {
        const note   = (document.getElementById('cnt_note_ta2')?.value || '').trim();
        const pinned = document.getElementById('cnt_pin_cb2')?.checked ?? false;
        setChatData(chatId, { note, pinned, ts: Date.now() });
        toastr.success('Заметка сохранена', '', { timeOut: 2000 });
        decorateRecentChats();
      });

      document.getElementById('cnt_note_clear')?.addEventListener('click', () => {
        const ta = document.getElementById('cnt_note_ta2');
        if (ta) ta.value = '';
      });
    }, 0);
  }

  // ─── Utils ────────────────────────────────────────────────────────────────────

  function escHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  // ─── MutationObserver: re-decorate when list refreshes ───────────────────────

  let _decorateTimer = null;
  function scheduleDecorate() {
    clearTimeout(_decorateTimer);
    _decorateTimer = setTimeout(decorateRecentChats, 250);
  }

  function observeCharacterList() {
    const target = document.getElementById('rm_print_characters_block')
      || document.getElementById('character_list')
      || document.querySelector('.character_list');
    if (!target) return;

    const obs = new MutationObserver(scheduleDecorate);
    obs.observe(target, { childList: true, subtree: true });
  }

  // ─── Settings panel ───────────────────────────────────────────────────────────

  async function mountSettingsUi() {
    if ($('#cnt_settings_block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) return;

    $(target).append(`
      <div class="cnt-settings-block" id="cnt_settings_block">
        <div class="cnt-settings-title">
          <span>📝 Заметки к чатам</span>
          <button type="button" id="cnt_collapse_btn">▾</button>
        </div>
        <div class="cnt-settings-body" id="cnt_settings_body">
          <div style="font-size:12px;color:rgba(180,200,240,.7);margin-bottom:10px;line-height:1.6">
            Добавляет заметки и пины к чатам в списке «Недавние».<br>
            Кнопка 📝 в области ввода позволяет быстро записать мысль не выходя из чата.
          </div>
          <button class="menu_button" id="cnt_redecorate_btn" style="font-size:11px;padding:5px 10px">
            🔄 Обновить список
          </button>
          <button class="menu_button" id="cnt_clear_all_btn" style="font-size:11px;padding:5px 10px;margin-top:5px">
            🗑 Очистить все заметки
          </button>
          <div id="cnt_stats" style="font-size:10px;color:rgba(180,200,240,.4);margin-top:8px"></div>
        </div>
      </div>
    `);

    updateStats();

    $('#cnt_collapse_btn').on('click', () => {
      const $body = $('#cnt_settings_body');
      const open  = $body.is(':visible');
      $body.toggle(!open);
      $('#cnt_collapse_btn').text(open ? '▸' : '▾');
    });

    $('#cnt_redecorate_btn').on('click', () => {
      decorateRecentChats();
      toastr.success('Список обновлён', '', { timeOut: 1500 });
    });

    $('#cnt_clear_all_btn').on('click', async () => {
      const { Popup } = ctx();
      const ok = await Popup.show.confirm('Очистить все заметки?', 'Действие нельзя отменить.');
      if (!ok) return;
      localStorage.removeItem(STORAGE_KEY);
      decorateRecentChats();
      updateStats();
      toastr.success('Все заметки удалены');
    });
  }

  function updateStats() {
    const data  = loadData();
    const total  = Object.keys(data).length;
    const noted  = Object.values(data).filter(d => d.note).length;
    const pinned = Object.values(data).filter(d => d.pinned).length;
    $('#cnt_stats').text(`Всего чатов с данными: ${total} · с заметками: ${noted} · закреплённых: ${pinned}`);
  }

  // ─── Events ───────────────────────────────────────────────────────────────────

  function wireChatEvents() {
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.APP_READY, async () => {
      await mountSettingsUi();
      ensureQuickNote();
      setTimeout(() => {
        observeCharacterList();
        decorateRecentChats();
      }, 800);
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
      setTimeout(() => {
        ensureQuickNote();
        decorateRecentChats();
        updateStats();
      }, 400);
    });

    // Re-inject quick note button if UI refreshes
    const bodyObs = new MutationObserver(() => {
      if (!document.getElementById('cnt_quick_btn')) {
        setTimeout(ensureQuickNote, 200);
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: false });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  jQuery(() => {
    try { wireChatEvents(); console.log('[CNT] v1.0.0 loaded'); }
    catch (e) { console.error('[CNT] init failed', e); }
  });

})();
