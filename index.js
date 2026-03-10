/**
 * ╔══════════════════════════════════════════╗
 * ║   EMOTION CANVAS — SillyTavern Extension ║
 * ║   v1.0.0                                 ║
 * ╚══════════════════════════════════════════╝
 */

(() => {
  'use strict';

  const MODULE_KEY = 'emotion_canvas';

  const EMOTIONS = Object.freeze({
    joy: {
      label: 'Радость', icon: '✨',
      color1: '#FFD700', color2: '#FF8C00', color3: '#FFA500',
      keywords: ['рад','счастлив','смеёт','смех','улыбка','весел','ура','отлично','восхит','joy','happy','laugh','smile','great','wonderful','excited','awesome','fantastic','delight','haha','hehe'],
    },
    love: {
      label: 'Любовь', icon: '💕',
      color1: '#E91E8C', color2: '#9B0050', color3: '#FF6BB5',
      keywords: ['люблю','любовь','нежн','тепло','обним','поцел','сердце','дорог','love','heart','darling','dear','tender','kiss','hug','adore','cherish','affection','romantic','sweetheart','honey','blush'],
    },
    sadness: {
      label: 'Грусть', icon: '🌧️',
      color1: '#4A6FA5', color2: '#1B3A5C', color3: '#6B8CBE',
      keywords: ['грустно','плачу','слезы','печаль','тоска','одиноко','потерял','sad','cry','tears','sorrow','lonely','grief','miss','mourn','depressed','hurt','pain','lost','hopeless','disappointed'],
    },
    anger: {
      label: 'Гнев', icon: '🔥',
      color1: '#C0392B', color2: '#7B0000', color3: '#E74C3C',
      keywords: ['злюсь','ненавиж','бесит','раздража','ярость','гнев','злой','angry','rage','furious','hate','annoyed','mad','frustrated','outraged','livid'],
    },
    fear: {
      label: 'Страх', icon: '🌑',
      color1: '#6C3483', color2: '#1A0533', color3: '#9B59B6',
      keywords: ['боюсь','страшно','ужас','дрожу','пугает','тревожно','опасно','fear','scared','horror','terrified','dread','panic','anxiety','tremble','nightmare','afraid','worried','nervous','shaking'],
    },
    wonder: {
      label: 'Удивление', icon: '🌊',
      color1: '#00BCD4', color2: '#006978', color3: '#4DD0E1',
      keywords: ['удивлен','невероятно','изумлен','поражен','интересно','загадочно','wonder','amazed','incredible','astonishing','mysterious','curious','fascinating','unbelievable','strange','wow'],
    },
    neutral: {
      label: 'Спокойствие', icon: '🌿',
      color1: '#2C3E50', color2: '#1A252F', color3: '#3D5266',
      keywords: [],
    },
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showWidget: true,
    cinematic: false,
    locked: false,
    lockedEmotion: null,
    particleCount: 16,
    showPanel: false,
    collapsed: false,
  });

  let currentEmotion = 'neutral';
  let emotionHistory = [];

  function ctx() { return SillyTavern.getContext(); }

  function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_KEY])
      extensionSettings[MODULE_KEY] = structuredClone(DEFAULT_SETTINGS);
    for (const k of Object.keys(DEFAULT_SETTINGS))
      if (!Object.hasOwn(extensionSettings[MODULE_KEY], k))
        extensionSettings[MODULE_KEY][k] = DEFAULT_SETTINGS[k];
    return extensionSettings[MODULE_KEY];
  }

  function detectEmotion(text) {
    const lower = text.toLowerCase();
    let bestEmotion = 'neutral';
    let bestScore = 0;
    for (const [emotion, def] of Object.entries(EMOTIONS)) {
      if (emotion === 'neutral') continue;
      let score = 0;
      for (const kw of def.keywords) {
        if (lower.includes(kw)) score += kw.length > 5 ? 2 : 1;
      }
      if (score > bestScore) { bestScore = score; bestEmotion = emotion; }
    }
    const intensity = bestScore === 0 ? 0.25 : Math.min(0.3 + bestScore * 0.12, 1.0);
    return { emotion: bestEmotion, intensity };
  }

  function ensureDOM() {
    if ($('#ec-gradient-layer').length) return;
    $('body').append('<div id="ec-gradient-layer"></div>');
    $('body').append('<div id="ec-particles"></div>');
    $('body').append(`
      <div id="ec-panel">
        <div id="ec-card">
          <div id="ec-card-title">Emotion Canvas</div>
          <div id="ec-lock-badge">🔒 Зафиксировано</div>
          <div id="ec-emotion-display">
            <div id="ec-emotion-icon">🌿</div>
            <div id="ec-emotion-info">
              <div id="ec-emotion-name">Спокойствие</div>
              <div id="ec-intensity-bar"><div id="ec-intensity-fill" style="width:30%"></div></div>
            </div>
          </div>
          <div id="ec-history-label">История</div>
          <div id="ec-history-chart"></div>
          <div id="ec-controls">
            <button class="ec-ctrl" id="ec-btn-lock">🔒 Lock</button>
            <button class="ec-ctrl" id="ec-btn-cinema">🎬 Cinema</button>
          </div>
        </div>
        <button id="ec-toggle-btn" title="Emotion Canvas">🎨</button>
      </div>
    `);

    $('#ec-toggle-btn').on('click', () => {
      const s = getSettings();
      s.showPanel = !s.showPanel;
      $('#ec-card').toggleClass('ec-visible', s.showPanel);
      ctx().saveSettingsDebounced();
    });

    $('#ec-btn-lock').on('click', () => {
      const s = getSettings();
      s.locked = !s.locked;
      if (s.locked) {
        s.lockedEmotion = currentEmotion;
        $('#ec-lock-badge').addClass('ec-visible');
        $('#ec-btn-lock').addClass('ec-active').text('🔓 Unlock');
      } else {
        s.lockedEmotion = null;
        $('#ec-lock-badge').removeClass('ec-visible');
        $('#ec-btn-lock').removeClass('ec-active').text('🔒 Lock');
      }
      ctx().saveSettingsDebounced();
    });

    $('#ec-btn-cinema').on('click', () => {
      const s = getSettings();
      s.cinematic = !s.cinematic;
      $('body').toggleClass('ec-cinematic', s.cinematic);
      $('#ec-btn-cinema').toggleClass('ec-active', s.cinematic);
      $('#ec-gradient-layer').css('opacity', s.cinematic ? '0.35' : '0.18');
      ctx().saveSettingsDebounced();
    });
  }

  function applyEmotion(emotion, intensity) {
    const def = EMOTIONS[emotion] || EMOTIONS.neutral;
    currentEmotion = emotion;
    emotionHistory.push({ emotion, intensity });
    if (emotionHistory.length > 20) emotionHistory.shift();

    const root = document.documentElement;
    root.style.setProperty('--ec-c1', def.color1);
    root.style.setProperty('--ec-c2', def.color2);
    root.style.setProperty('--ec-c3', def.color3);

    $('#ec-emotion-icon').text(def.icon).css('filter', `drop-shadow(0 0 10px ${def.color1})`);
    $('#ec-emotion-name').text(def.label).css('color', def.color1);
    $('#ec-intensity-fill').css('width', Math.round(intensity * 100) + '%');

    renderHistory();
    burstParticles(emotion, intensity);

    $('#ec-gradient-layer').css({
      background: `radial-gradient(ellipse at 30% 60%, ${def.color1}33 0%, transparent 70%),radial-gradient(ellipse at 75% 30%, ${def.color3}22 0%, transparent 60%)`,
    });
  }

  function renderHistory() {
    const $chart = $('#ec-history-chart').empty();
    emotionHistory.forEach(entry => {
      const def = EMOTIONS[entry.emotion] || EMOTIONS.neutral;
      const h = Math.max(3, Math.round(entry.intensity * 36));
      $('<div class="ec-bar"></div>').css({
        height: h + 'px',
        background: `linear-gradient(to top, ${def.color2}, ${def.color1})`,
      }).attr('title', `${def.label} ${Math.round(entry.intensity * 100)}%`).appendTo($chart);
    });
  }

  function burstParticles(emotion, intensity) {
    const s = getSettings();
    const count = Math.round((s.particleCount || 16) * intensity);
    for (let i = 0; i < count; i++) setTimeout(() => spawnParticle(emotion), i * 55);
  }

  function spawnParticle(emotion) {
    const container = document.getElementById('ec-particles');
    if (!container) return;
    const p = document.createElement('div');
    p.className = `ec-particle ec-${emotion}`;
    const size = Math.random() * 10 + 4;
    const isRain = emotion === 'sadness';
    p.style.cssText = `width:${size}px;height:${isRain ? Math.random()*14+10 : size}px;left:${Math.random()*100}%;${isRain ? 'top:-30px;' : `bottom:${Math.random()*30}%;`}--dur:${(Math.random()*4.5+2.5).toFixed(1)}s;--dx:${(Math.random()*120-60).toFixed(0)}px;`;
    container.appendChild(p);
    setTimeout(() => p.remove(), 8000);
  }

  function onMessage() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.locked && s.lockedEmotion) return;
    const { chat } = ctx();
    if (!Array.isArray(chat) || !chat.length) return;
    const last = chat[chat.length - 1];
    if (!last || last.is_user) return;
    const result = detectEmotion(last.mes || '');
    applyEmotion(result.emotion, result.intensity);
  }

  function applySettings() {
    const s = getSettings();
    if (s.showPanel) $('#ec-card').addClass('ec-visible');
    if (s.cinematic) { $('body').addClass('ec-cinematic'); $('#ec-btn-cinema').addClass('ec-active'); }
    if (s.locked && s.lockedEmotion) {
      $('#ec-lock-badge').addClass('ec-visible');
      $('#ec-btn-lock').addClass('ec-active').text('🔓 Unlock');
      applyEmotion(s.lockedEmotion, 0.7);
    }
    $('#ec-gradient-layer').addClass('ec-visible');
    if (!s.enabled) { $('#ec-gradient-layer').css('opacity', '0'); $('#ec-particles').hide(); }
    if (s.showWidget === false) $('#ec-panel').hide();
  }

  async function mountSettingsUi() {
    if ($('#ec-settings-block').length) return;
    const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
    if (!$(target).length) { console.warn('[EmotionCanvas] settings container not found'); return; }
    const s = getSettings();
    $(target).append(`
      <div id="ec-settings-block">
        <div class="ec-s-title">
          <span>🎨 Emotion Canvas</span>
          <button type="button" id="ec-collapse-btn">${s.collapsed ? '▸' : '▾'}</button>
        </div>
        <div class="ec-s-body"${s.collapsed ? ' style="display:none"' : ''}>
          <div class="ec-s-row ec-2col">
            <label class="ec-ck"><input type="checkbox" id="ec-enabled" ${s.enabled ? 'checked' : ''}><span>Эффекты</span></label>
            <label class="ec-ck"><input type="checkbox" id="ec-show-widget" ${s.showWidget !== false ? 'checked' : ''}><span>Кнопка 🎨</span></label>
          </div>
          <div class="ec-s-row ec-slider-row">
            <label>Частиц:</label>
            <input type="range" id="ec-particles-count" min="4" max="40" step="2" value="${s.particleCount || 16}">
            <span id="ec-particles-val">${s.particleCount || 16}</span>
          </div>
          <div class="ec-s-btns">
            <button class="menu_button" id="ec-open-btn">🎨 Открыть панель</button>
            <button class="menu_button" id="ec-reset-btn">↺ Сброс</button>
          </div>
        </div>
      </div>
    `);

    $('#ec-collapse-btn').on('click', () => {
      const s = getSettings();
      s.collapsed = !s.collapsed;
      $('#ec-settings-block .ec-s-body').toggle(!s.collapsed);
      $('#ec-collapse-btn').text(s.collapsed ? '▸' : '▾');
      ctx().saveSettingsDebounced();
    });

    $('#ec-enabled').on('change', function () {
      const s = getSettings();
      s.enabled = this.checked;
      ctx().saveSettingsDebounced();
      if (s.enabled) { $('#ec-gradient-layer').css('opacity', '').addClass('ec-visible'); $('#ec-particles').show(); }
      else { $('#ec-gradient-layer').css('opacity', '0'); $('#ec-particles').hide(); }
    });

    $('#ec-show-widget').on('change', function () {
      const s = getSettings();
      s.showWidget = this.checked;
      ctx().saveSettingsDebounced();
      $('#ec-panel').toggle(s.showWidget);
    });

    $('#ec-particles-count').on('input', function () {
      const v = +this.value;
      getSettings().particleCount = v;
      $('#ec-particles-val').text(v);
      ctx().saveSettingsDebounced();
    });

    $('#ec-open-btn').on('click', () => {
      const s = getSettings();
      s.showPanel = true;
      $('#ec-card').addClass('ec-visible');
      ctx().saveSettingsDebounced();
    });

    $('#ec-reset-btn').on('click', () => {
      const s = getSettings();
      s.locked = false; s.lockedEmotion = null;
      emotionHistory = []; currentEmotion = 'neutral';
      $('#ec-lock-badge').removeClass('ec-visible');
      $('#ec-btn-lock').removeClass('ec-active').text('🔒 Lock');
      applyEmotion('neutral', 0.3);
      ctx().saveSettingsDebounced();
      toastr.success('[EmotionCanvas] Сброшено');
    });
  }

  function wireEvents() {
    const { eventSource, event_types } = ctx();
    eventSource.on(event_types.APP_READY, async () => {
      ensureDOM();
      applySettings();
      await mountSettingsUi();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
      emotionHistory = [];
      currentEmotion = 'neutral';
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessage);
  }

  jQuery(() => {
    try { wireEvents(); console.log('[EmotionCanvas] v1.0.0 loaded'); }
    catch (e) { console.error('[EmotionCanvas] init failed', e); }
  });

})();
