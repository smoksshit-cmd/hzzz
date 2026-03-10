/**
 * EMOTION CANVAS v1.1.0 — SillyTavern Extension
 * Atmospheric visual effects based on message emotion
 */

(() => {
  'use strict';

  const MODULE_KEY = 'emotion_canvas';

  // ─── Emotions ────────────────────────────────────────────────────────────────

  const EMOTIONS = {
    joy: {
      label: 'Радость', icon: '✨',
      color1: '#FFD700', color2: '#FF8C00', color3: '#FFA500',
      keywords: ['рад','счастлив','смеёт','смех','улыбка','весел','ура','отлично','восхит',
        'happy','laugh','smile','great','wonderful','excited','yay','awesome','haha','hehe'],
    },
    love: {
      label: 'Любовь', icon: '💕',
      color1: '#E91E8C', color2: '#9B0050', color3: '#FF6BB5',
      keywords: ['люблю','любовь','нежн','тепло','обним','поцел','сердце','дорог',
        'love','heart','darling','dear','tender','kiss','hug','adore','cherish'],
    },
    sadness: {
      label: 'Грусть', icon: '🌧️',
      color1: '#4A6FA5', color2: '#1B3A5C', color3: '#6B8CBE',
      keywords: ['грустно','плачу','слезы','слёзы','печаль','тоска','одиноко','потерял',
        'sad','cry','tears','sorrow','lonely','grief','miss','hurt','hopeless'],
    },
    anger: {
      label: 'Гнев', icon: '🔥',
      color1: '#C0392B', color2: '#7B0000', color3: '#E74C3C',
      keywords: ['злюсь','ненавиж','бесит','раздража','ярость','гнев','злой',
        'angry','rage','furious','hate','mad','outraged','livid'],
    },
    fear: {
      label: 'Страх', icon: '🌑',
      color1: '#6C3483', color2: '#1A0533', color3: '#9B59B6',
      keywords: ['боюсь','страшно','ужас','дрожу','пугает','тревожно','опасно',
        'fear','scared','horror','terrified','dread','panic','anxiety'],
    },
    wonder: {
      label: 'Удивление', icon: '🌊',
      color1: '#00BCD4', color2: '#006978', color3: '#4DD0E1',
      keywords: ['удивлен','невероятно','изумлен','поражен','интересно','загадочно',
        'wonder','amazed','incredible','astonishing','mysterious','curious','wow'],
    },
    neutral: {
      label: 'Спокойствие', icon: '🌿',
      color1: '#2C3E50', color2: '#1A252F', color3: '#3D5266',
      keywords: [],
    },
  };

  // ─── Settings ─────────────────────────────────────────────────────────────────

  const DEFAULTS = {
    enabled:       true,
    cinematic:     false,
    locked:        false,
    lockedEmotion: null,
    particles:     18,
    showPanel:     false,
    collapsed:     false,
  };

  function getSettings() {
    const ext = SillyTavern.getContext().extensionSettings;
    if (!ext[MODULE_KEY]) ext[MODULE_KEY] = {};
    const s = ext[MODULE_KEY];
    for (const k in DEFAULTS)
      if (s[k] === undefined) s[k] = DEFAULTS[k];
    return s;
  }

  function save() {
    SillyTavern.getContext().saveSettingsDebounced();
  }

  // ─── State ────────────────────────────────────────────────────────────────────

  let emotion   = 'neutral';
  let intensity = 0.25;
  const history = [];

  // ─── Emotion detection ────────────────────────────────────────────────────────

  function detect(text) {
    const t = text.toLowerCase();
    let best = 'neutral', score = 0;
    for (const [key, def] of Object.entries(EMOTIONS)) {
      if (key === 'neutral') continue;
      let s = 0;
      for (const kw of def.keywords)
        if (t.includes(kw)) s += kw.length > 5 ? 2 : 1;
      if (s > score) { score = s; best = key; }
    }
    return {
      emotion:   best,
      intensity: score === 0 ? 0.25 : Math.min(0.3 + score * 0.12, 1.0),
    };
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────────────

  function r(id) { return document.getElementById(id); }

  // ─── Gradient ─────────────────────────────────────────────────────────────────

  function setGradient(em) {
    const s   = getSettings();
    const def = EMOTIONS[em] || EMOTIONS.neutral;
    const root = document.documentElement;
    root.style.setProperty('--ec-c1', def.color1);
    root.style.setProperty('--ec-c2', def.color2);
    root.style.setProperty('--ec-c3', def.color3);

    const layer = r('ec-gradient');
    if (layer) layer.style.opacity = !s.enabled ? '0' : s.cinematic ? '0.32' : '0.15';
  }

  // ─── Particles ────────────────────────────────────────────────────────────────

  function rand(a, b) { return Math.random() * (b - a) + a; }

  function burst(em, ints) {
    const box = r('ec-particles');
    if (!box) return;
    const n = Math.round(getSettings().particles * ints);
    for (let i = 0; i < n; i++)
      setTimeout(() => {
        const p  = document.createElement('div');
        const sz = rand(4, 13);
        p.className = 'ec-p ec-p-' + em;
        p.style.cssText =
          'left:' + rand(0, 100) + '%;' +
          'bottom:' + (em === 'sadness' ? '100%' : rand(0, 25) + '%') + ';' +
          'width:' + (em === 'sadness' ? 2 : sz) + 'px;' +
          'height:' + (em === 'sadness' ? rand(8, 22) : sz) + 'px;' +
          '--dur:' + rand(2.5, 6.5) + 's;' +
          '--dx:' + rand(-55, 55) + 'px;';
        box.appendChild(p);
        setTimeout(() => p.remove(), 7500);
      }, i * 55);
  }

  // ─── Apply emotion ────────────────────────────────────────────────────────────

  function apply(em, ints) {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.locked && s.lockedEmotion) em = s.lockedEmotion;

    emotion   = em;
    intensity = ints;
    history.push({ em, ints });
    if (history.length > 20) history.shift();

    setGradient(em);
    burst(em, ints);
    refreshPanel();
  }

  // ─── Panel ────────────────────────────────────────────────────────────────────

  function buildPanel() {
    if (r('ec-wrap')) return;
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="ec-wrap">
        <div id="ec-card">
          <div id="ec-card-head">EMOTION CANVAS</div>
          <div id="ec-lock-tag" style="display:none">🔒 LOCKED</div>
          <div id="ec-row">
            <span id="ec-icon">🌿</span>
            <div id="ec-info">
              <div id="ec-name">Спокойствие</div>
              <div id="ec-bar"><div id="ec-fill"></div></div>
            </div>
          </div>
          <div id="ec-hist-label">ИСТОРИЯ</div>
          <div id="ec-hist"></div>
          <div id="ec-btns">
            <button id="ec-lock" class="ec-btn">🔒 Lock</button>
            <button id="ec-cine" class="ec-btn">🎬 Cinema</button>
          </div>
        </div>
        <button id="ec-fab" title="Emotion Canvas">🎨</button>
      </div>
      <div id="ec-gradient"></div>
      <div id="ec-particles"></div>
    `;
    document.body.appendChild(div);

    const s = getSettings();
    if (s.showPanel)  r('ec-card').classList.add('ec-show');
    if (s.cinematic)  { document.body.classList.add('ec-cine'); r('ec-cine').classList.add('ec-on'); }
    if (s.locked)     { r('ec-lock-tag').style.display = ''; r('ec-lock').classList.add('ec-on'); r('ec-lock').textContent = '🔓 Unlock'; }

    setGradient('neutral');

    r('ec-fab').addEventListener('click', () => {
      const s = getSettings();
      s.showPanel = !s.showPanel;
      r('ec-card').classList.toggle('ec-show', s.showPanel);
      save();
    });

    r('ec-lock').addEventListener('click', () => {
      const s = getSettings();
      s.locked = !s.locked;
      if (s.locked) {
        s.lockedEmotion = emotion;
        r('ec-lock-tag').style.display = '';
        r('ec-lock').classList.add('ec-on');
        r('ec-lock').textContent = '🔓 Unlock';
      } else {
        s.lockedEmotion = null;
        r('ec-lock-tag').style.display = 'none';
        r('ec-lock').classList.remove('ec-on');
        r('ec-lock').textContent = '🔒 Lock';
      }
      save();
    });

    r('ec-cine').addEventListener('click', () => {
      const s = getSettings();
      s.cinematic = !s.cinematic;
      document.body.classList.toggle('ec-cine', s.cinematic);
      r('ec-cine').classList.toggle('ec-on', s.cinematic);
      setGradient(emotion);
      save();
    });
  }

  function refreshPanel() {
    if (!r('ec-icon')) return;
    const def = EMOTIONS[emotion] || EMOTIONS.neutral;

    r('ec-icon').textContent = def.icon;
    r('ec-icon').style.filter = 'drop-shadow(0 0 10px ' + def.color1 + ')';
    r('ec-name').textContent  = def.label;
    r('ec-name').style.color  = def.color1;
    r('ec-fill').style.width  = Math.round(intensity * 100) + '%';
    r('ec-fill').style.background = 'linear-gradient(90deg,' + def.color2 + ',' + def.color1 + ')';

    const hist = r('ec-hist');
    hist.innerHTML = '';
    history.forEach(e => {
      const d = EMOTIONS[e.em] || EMOTIONS.neutral;
      const b = document.createElement('div');
      b.className = 'ec-hbar';
      b.style.height     = Math.max(3, Math.round(e.ints * 36)) + 'px';
      b.style.background = 'linear-gradient(to top,' + d.color2 + ',' + d.color1 + ')';
      b.title = d.label;
      hist.appendChild(b);
    });
  }

  // ─── Settings UI ─────────────────────────────────────────────────────────────

  function buildSettings() {
    if (r('ec-settings')) return;
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) return;

    const s = getSettings();
    const wrap = document.createElement('div');
    wrap.id = 'ec-settings';
    wrap.innerHTML = `
      <div id="ec-s-head">
        <span>🎨 Emotion Canvas</span>
        <button id="ec-s-tog">${s.collapsed ? '▸' : '▾'}</button>
      </div>
      <div id="ec-s-body"${s.collapsed ? ' style="display:none"' : ''}>
        <label class="ec-ck"><input type="checkbox" id="ec-s-on" ${s.enabled ? 'checked' : ''}><span>Включить эффекты</span></label>
        <div class="ec-srow">
          <span class="ec-slabel">Частиц:</span>
          <input type="range" id="ec-s-ptc" min="5" max="40" value="${s.particles}">
          <span id="ec-s-ptc-v">${s.particles}</span>
        </div>
        <button class="menu_button" id="ec-s-open">🎨 Открыть панель</button>
      </div>
    `;
    target.appendChild(wrap);

    r('ec-s-tog').addEventListener('click', () => {
      s.collapsed = !s.collapsed;
      r('ec-s-body').style.display = s.collapsed ? 'none' : '';
      r('ec-s-tog').textContent = s.collapsed ? '▸' : '▾';
      save();
    });

    r('ec-s-on').addEventListener('change', function () {
      s.enabled = this.checked;
      setGradient(emotion);
      save();
    });

    r('ec-s-ptc').addEventListener('input', function () {
      s.particles = +this.value;
      r('ec-s-ptc-v').textContent = this.value;
      save();
    });

    r('ec-s-open').addEventListener('click', () => {
      s.showPanel = true;
      r('ec-card') && r('ec-card').classList.add('ec-show');
      save();
    });
  }

  // ─── Events ───────────────────────────────────────────────────────────────────

  function init() {
    buildPanel();
    buildSettings();
    setGradient('neutral');
  }

  function onMessage(idx) {
    const chat = SillyTavern.getContext().chat;
    const msg  = chat?.[idx];
    if (!msg) return;
    const res = detect(msg.mes || '');
    apply(res.emotion, res.intensity);
  }

  jQuery(document).ready(() => {
    try {
      const { eventSource, event_types } = SillyTavern.getContext();

      // Init immediately (in case APP_READY already fired) + on APP_READY as backup
      init();
      eventSource.on(event_types.APP_READY, init);

      eventSource.on(event_types.CHAT_CHANGED, () => {
        history.length = 0;
        emotion = 'neutral'; intensity = 0.25;
        setGradient('neutral');
        refreshPanel();
      });

      eventSource.on(event_types.MESSAGE_RECEIVED, (idx) => {
        const chat = SillyTavern.getContext().chat;
        const msg  = chat?.[idx];
        if (msg && !msg.is_user) onMessage(idx);
      });

      eventSource.on(event_types.MESSAGE_SENT, onMessage);

      console.log('[EmotionCanvas] v1.1.0 loaded');
    } catch(e) {
      console.error('[EmotionCanvas] init error:', e);
    }
  });

})();
