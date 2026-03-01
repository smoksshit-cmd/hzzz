// =====================================================
// PHONE WIDGET EXTENSION for SillyTavern
// =====================================================

import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';

const EXT_NAME = 'phone-widget';

// Default settings
const defaultSettings = {
    enabled: true,
    position: 'bottom-right',
};

function loadSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    Object.assign(extension_settings[EXT_NAME], {
        ...defaultSettings,
        ...extension_settings[EXT_NAME],
    });
}

// =====================================================
// PHONE HTML TEMPLATE
// =====================================================

const PHONE_HTML = `
<div id="phone-overlay">
  <div class="phone-shell">

    <!-- Status Bar -->
    <div class="phone-status-bar">
      <span class="phone-time" id="phone-clock">12:00</span>
      <div class="phone-status-icons">
        <span>▲▲▲</span>
        <span>WiFi</span>
        <span>🔋</span>
      </div>
    </div>

    <!-- Notch -->
    <div class="phone-notch"></div>

    <!-- Screen -->
    <div class="phone-screen" id="phone-screen">

      <!-- HOME SCREEN -->
      <div class="phone-home" id="phone-home">
        <div class="phone-home-title">Games</div>
        <div class="phone-apps-grid">
          <div class="phone-app-icon" data-app="snake">
            <div class="phone-app-icon-img" style="background: linear-gradient(135deg, #0f3d0f, #1a6b1a);">🐍</div>
            <div class="phone-app-icon-label">Snake</div>
          </div>
          <div class="phone-app-icon" data-app="2048">
            <div class="phone-app-icon-img" style="background: linear-gradient(135deg, #3d2f00, #7a5f00);">🟨</div>
            <div class="phone-app-icon-label">2048</div>
          </div>
          <div class="phone-app-icon" data-app="flappy">
            <div class="phone-app-icon-img" style="background: linear-gradient(135deg, #001f3d, #003d7a);">🐦</div>
            <div class="phone-app-icon-label">Flappy</div>
          </div>
          <div class="phone-app-icon" data-app="breakout">
            <div class="phone-app-icon-img" style="background: linear-gradient(135deg, #3d001f, #7a003d);">🧱</div>
            <div class="phone-app-icon-label">Breakout</div>
          </div>
        </div>
      </div>

    </div><!-- /phone-screen -->

    <!-- Home Indicator -->
    <div class="phone-home-indicator">
      <div class="phone-home-indicator-bar" id="phone-home-btn" title="Home"></div>
    </div>

  </div><!-- /phone-shell -->
</div><!-- /phone-overlay -->

<!-- Toggle Button -->
<button id="phone-widget-btn" title="Open Phone">📱</button>
`;

// =====================================================
// CLOCK
// =====================================================

function updateClock() {
    const el = document.getElementById('phone-clock');
    if (!el) return;
    const now = new Date();
    el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// =====================================================
// PHONE CONTROLLER
// =====================================================

let clockInterval = null;
let currentApp = null;
let appCleanupFn = null;

function openPhone() {
    const overlay = document.getElementById('phone-overlay');
    overlay.classList.add('visible');
    updateClock();
    if (!clockInterval) clockInterval = setInterval(updateClock, 10000);
}

function closePhone() {
    const overlay = document.getElementById('phone-overlay');
    overlay.classList.remove('visible');
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
    goHome();
}

function goHome() {
    if (appCleanupFn) { appCleanupFn(); appCleanupFn = null; }
    currentApp = null;

    // Remove any open app screens
    document.querySelectorAll('.phone-app-screen').forEach(el => el.remove());

    const home = document.getElementById('phone-home');
    if (home) home.style.display = '';
}

function openApp(appName) {
    const home = document.getElementById('phone-home');
    if (home) home.style.display = 'none';

    const screen = document.getElementById('phone-screen');

    // Create app screen wrapper
    const appScreen = document.createElement('div');
    appScreen.className = 'phone-app-screen';
    appScreen.id = 'phone-app-active';

    const apps = {
        snake: { title: '🐍 Snake', fn: initSnake },
        '2048': { title: '🟨 2048', fn: init2048 },
        flappy: { title: '🐦 Flappy Bird', fn: initFlappy },
        breakout: { title: '🧱 Breakout', fn: initBreakout },
    };

    const app = apps[appName];
    if (!app) return;

    currentApp = appName;

    appScreen.innerHTML = `
      <div class="phone-app-header">
        <div class="phone-back-btn" id="phone-back">‹</div>
        <div class="phone-app-title">${app.title}</div>
      </div>
      <div class="phone-app-content" id="phone-app-content"></div>
    `;

    screen.appendChild(appScreen);

    document.getElementById('phone-back').addEventListener('click', goHome);

    const content = document.getElementById('phone-app-content');
    appCleanupFn = app.fn(content);
}

// =====================================================
// GAME: SNAKE
// =====================================================

function initSnake(container) {
    const W = 220, H = 220, CELL = 11;

    container.innerHTML = `
      <div class="snake-ui">
        <div class="snake-score-block">
          <div class="snake-score-label">Score</div>
          <div class="snake-score-value" id="snake-score">0</div>
        </div>
        <div class="snake-score-block">
          <div class="snake-score-label">Best</div>
          <div class="snake-score-value" id="snake-best">0</div>
        </div>
        <button class="snake-btn" id="snake-restart">New</button>
      </div>
      <canvas id="snake-canvas" width="${W}" height="${H}"></canvas>
      <div class="snake-dpad">
        <div class="dpad-btn" style="grid-area:up"    data-dir="0,-1">▲</div>
        <div class="dpad-btn" style="grid-area:left"  data-dir="-1,0">◄</div>
        <div class="dpad-btn" style="grid-area:right" data-dir="1,0">►</div>
        <div class="dpad-btn" style="grid-area:down"  data-dir="0,1">▼</div>
      </div>
    `;

    const canvas = document.getElementById('snake-canvas');
    const ctx = canvas.getContext('2d');
    const COLS = Math.floor(W / CELL);
    const ROWS = Math.floor(H / CELL);

    let snake, dir, nextDir, food, score, best = 0, gameLoop, alive;

    function startGame() {
        snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
        dir = { x: 1, y: 0 };
        nextDir = { x: 1, y: 0 };
        score = 0;
        alive = true;
        placeFood();
        updateScore();
        if (gameLoop) clearInterval(gameLoop);
        gameLoop = setInterval(tick, 120);
    }

    function placeFood() {
        let pos;
        do {
            pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
        } while (snake.some(s => s.x === pos.x && s.y === pos.y));
        food = pos;
    }

    function tick() {
        if (!alive) return;
        dir = nextDir;
        const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

        // Wall collision
        if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
            return gameOver();
        }
        // Self collision
        if (snake.some(s => s.x === head.x && s.y === head.y)) {
            return gameOver();
        }

        snake.unshift(head);

        if (head.x === food.x && head.y === food.y) {
            score += 10;
            if (score > best) best = score;
            updateScore();
            placeFood();
        } else {
            snake.pop();
        }

        draw();
    }

    function gameOver() {
        alive = false;
        clearInterval(gameLoop);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#ff4444';
        ctx.font = 'bold 20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', W / 2, H / 2 - 10);
        ctx.fillStyle = '#aaa';
        ctx.font = '12px sans-serif';
        ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 15);
    }

    function updateScore() {
        document.getElementById('snake-score').textContent = score;
        document.getElementById('snake-best').textContent = best;
    }

    function draw() {
        // Background
        ctx.fillStyle = '#050510';
        ctx.fillRect(0, 0, W, H);

        // Grid dots
        ctx.fillStyle = 'rgba(0,212,255,0.05)';
        for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
            ctx.fillRect(x * CELL + 5, y * CELL + 5, 1, 1);
        }

        // Food
        const fx = food.x * CELL, fy = food.y * CELL;
        ctx.fillStyle = '#ff4444';
        ctx.shadowColor = '#ff4444';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(fx + CELL / 2, fy + CELL / 2, CELL / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Snake
        snake.forEach((seg, i) => {
            const t = 1 - i / snake.length;
            ctx.fillStyle = `rgba(${Math.round(t * 0)}, ${Math.round(t * 200 + 55)}, ${Math.round(t * 100 + 50)}, 1)`;
            ctx.shadowColor = i === 0 ? '#00ff88' : 'transparent';
            ctx.shadowBlur = i === 0 ? 8 : 0;
            const pad = i === 0 ? 0 : 1;
            ctx.beginPath();
            ctx.roundRect(seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, 3);
            ctx.fill();
        });
        ctx.shadowBlur = 0;
    }

    // D-pad controls
    container.querySelectorAll('.dpad-btn').forEach(btn => {
        const [dx, dy] = btn.dataset.dir.split(',').map(Number);
        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.classList.add('pressed');
            if (!(dx === -dir.x && dy === -dir.y)) nextDir = { x: dx, y: dy };
        });
        btn.addEventListener('pointerup', () => btn.classList.remove('pressed'));
    });

    // Keyboard
    const keyHandler = (e) => {
        const map = { ArrowUp: [0,-1], ArrowDown: [0,1], ArrowLeft: [-1,0], ArrowRight: [1,0],
                      w: [0,-1], s: [0,1], a: [-1,0], d: [1,0] };
        const d = map[e.key];
        if (d && !(d[0] === -dir.x && d[1] === -dir.y)) {
            nextDir = { x: d[0], y: d[1] };
        }
    };
    document.addEventListener('keydown', keyHandler);

    document.getElementById('snake-restart').addEventListener('click', startGame);

    startGame();
    draw();

    return () => {
        clearInterval(gameLoop);
        document.removeEventListener('keydown', keyHandler);
    };
}

// =====================================================
// GAME: 2048
// =====================================================

function init2048(container) {
    container.innerHTML = `
      <div class="game2048-container">
        <div class="game2048-scores">
          <div class="g2048-score">
            <div class="g2048-score-label">Score</div>
            <div class="g2048-score-val" id="g2048-score">0</div>
          </div>
          <div class="g2048-score">
            <div class="g2048-score-label">Best</div>
            <div class="g2048-score-val" id="g2048-best">0</div>
          </div>
          <button class="game2048-btn" id="g2048-new">New</button>
        </div>
        <div class="game2048-grid" id="g2048-grid"></div>
        <div class="game2048-message" id="g2048-msg">Swipe or use arrow keys</div>
      </div>
    `;

    let board, score, best = 0;

    function newGame() {
        board = Array.from({ length: 4 }, () => Array(4).fill(0));
        score = 0;
        addTile(); addTile();
        render();
    }

    function addTile() {
        const empty = [];
        board.forEach((row, y) => row.forEach((v, x) => { if (!v) empty.push({ x, y }); }));
        if (!empty.length) return;
        const { x, y } = empty[Math.floor(Math.random() * empty.length)];
        board[y][x] = Math.random() < 0.9 ? 2 : 4;
    }

    function render() {
        document.getElementById('g2048-score').textContent = score;
        document.getElementById('g2048-best').textContent = best;
        const grid = document.getElementById('g2048-grid');
        grid.innerHTML = '';
        board.forEach(row => row.forEach(val => {
            const tile = document.createElement('div');
            tile.className = `tile tile-${Math.min(val, 2048)}`;
            tile.textContent = val || '';
            grid.appendChild(tile);
        }));

        const msg = document.getElementById('g2048-msg');
        if (hasWon()) msg.textContent = '🎉 You reached 2048!';
        else if (!canMove()) msg.textContent = '💀 No moves left!';
        else msg.textContent = 'Swipe or use arrow keys';
    }

    function hasWon() { return board.some(row => row.some(v => v === 2048)); }

    function canMove() {
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            if (!board[y][x]) return true;
            if (x < 3 && board[y][x] === board[y][x + 1]) return true;
            if (y < 3 && board[y][x] === board[y + 1][x]) return true;
        }
        return false;
    }

    function slide(row) {
        let arr = row.filter(v => v);
        let gained = 0;
        for (let i = 0; i < arr.length - 1; i++) {
            if (arr[i] === arr[i + 1]) {
                arr[i] *= 2;
                gained += arr[i];
                arr[i + 1] = 0;
            }
        }
        arr = arr.filter(v => v);
        while (arr.length < 4) arr.push(0);
        return { row: arr, gained };
    }

    function move(dir) {
        let moved = false;
        let totalGained = 0;
        const b = board;

        if (dir === 'left') {
            for (let y = 0; y < 4; y++) {
                const { row, gained } = slide(b[y]);
                if (row.join() !== b[y].join()) moved = true;
                b[y] = row; totalGained += gained;
            }
        } else if (dir === 'right') {
            for (let y = 0; y < 4; y++) {
                const { row, gained } = slide([...b[y]].reverse());
                const newRow = row.reverse();
                if (newRow.join() !== b[y].join()) moved = true;
                b[y] = newRow; totalGained += gained;
            }
        } else if (dir === 'up') {
            for (let x = 0; x < 4; x++) {
                const col = b.map(r => r[x]);
                const { row, gained } = slide(col);
                if (row.join() !== col.join()) moved = true;
                row.forEach((v, y) => { b[y][x] = v; });
                totalGained += gained;
            }
        } else if (dir === 'down') {
            for (let x = 0; x < 4; x++) {
                const col = b.map(r => r[x]).reverse();
                const { row, gained } = slide(col);
                const newCol = row.reverse();
                if (newCol.join() !== b.map(r=>r[x]).join()) moved = true;
                newCol.forEach((v, y) => { b[y][x] = v; });
                totalGained += gained;
            }
        }

        if (moved) {
            score += totalGained;
            if (score > best) best = score;
            addTile();
            render();
        }
    }

    const keyHandler = (e) => {
        const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        if (map[e.key]) { e.preventDefault(); move(map[e.key]); }
    };
    document.addEventListener('keydown', keyHandler);

    // Touch support
    let touchStart = null;
    const grid = () => document.getElementById('g2048-grid');
    const onTouchStart = (e) => { touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
    const onTouchEnd = (e) => {
        if (!touchStart) return;
        const dx = e.changedTouches[0].clientX - touchStart.x;
        const dy = e.changedTouches[0].clientY - touchStart.y;
        if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? 'right' : 'left');
        else move(dy > 0 ? 'down' : 'up');
        touchStart = null;
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });

    document.getElementById('g2048-new').addEventListener('click', newGame);

    newGame();

    return () => {
        document.removeEventListener('keydown', keyHandler);
        container.removeEventListener('touchstart', onTouchStart);
        container.removeEventListener('touchend', onTouchEnd);
    };
}

// =====================================================
// GAME: FLAPPY BIRD
// =====================================================

function initFlappy(container) {
    const W = 240, H = 320;

    container.innerHTML = `
      <div class="flappy-ui">
        <div class="snake-score-block">
          <div class="snake-score-label">Score</div>
          <div class="snake-score-value" id="flappy-score">0</div>
        </div>
        <div class="snake-score-block">
          <div class="snake-score-label">Best</div>
          <div class="snake-score-value" id="flappy-best">0</div>
        </div>
        <button class="snake-btn" id="flappy-restart">New</button>
      </div>
      <canvas id="flappy-canvas" width="${W}" height="${H}"></canvas>
      <div style="text-align:center;color:rgba(255,255,255,0.4);font-size:11px;padding:6px">Tap / Space to flap</div>
    `;

    const canvas = document.getElementById('flappy-canvas');
    const ctx = canvas.getContext('2d');

    let bird, pipes, score, best = 0, alive, started, raf;

    function startGame() {
        bird = { x: 60, y: H / 2, vy: 0, r: 12 };
        pipes = [];
        score = 0;
        alive = true;
        started = false;
        updateScore();
        cancelAnimationFrame(raf);
        loop();
    }

    function flap() {
        if (!alive) { startGame(); return; }
        started = true;
        bird.vy = -6;
    }

    function updateScore() {
        document.getElementById('flappy-score').textContent = score;
        document.getElementById('flappy-best').textContent = best;
    }

    let frameCount = 0;
    function loop() {
        frameCount++;
        ctx.clearRect(0, 0, W, H);

        // Sky gradient
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#04061a');
        grad.addColorStop(1, '#0a1628');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Stars
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        for (let i = 0; i < 20; i++) {
            const sx = (i * 73) % W;
            const sy = (i * 47) % (H * 0.6);
            ctx.fillRect(sx, sy, 1, 1);
        }

        if (started && alive) {
            // Physics
            bird.vy += 0.35;
            bird.y += bird.vy;

            // Spawn pipes
            if (frameCount % 90 === 0) {
                const gap = 80;
                const topH = 50 + Math.random() * (H - gap - 100);
                pipes.push({ x: W, topH, gap });
            }

            // Update pipes
            pipes.forEach(p => { p.x -= 2.2; });
            pipes = pipes.filter(p => p.x > -60);

            // Score
            pipes.forEach(p => {
                if (!p.passed && p.x + 30 < bird.x) {
                    p.passed = true; score++;
                    if (score > best) best = score;
                    updateScore();
                }
            });

            // Collision: ground/ceiling
            if (bird.y - bird.r < 0 || bird.y + bird.r > H) {
                alive = false;
            }

            // Collision: pipes
            pipes.forEach(p => {
                const bx = bird.x, by = bird.y, br = bird.r;
                if (bx + br > p.x && bx - br < p.x + 40) {
                    if (by - br < p.topH || by + br > p.topH + p.gap) alive = false;
                }
            });
        }

        // Draw pipes
        pipes.forEach(p => {
            ctx.fillStyle = '#1a5e1a';
            ctx.strokeStyle = '#2a8e2a';
            ctx.lineWidth = 2;
            // Top pipe
            ctx.fillRect(p.x, 0, 40, p.topH);
            ctx.strokeRect(p.x, 0, 40, p.topH);
            ctx.fillRect(p.x - 3, p.topH - 20, 46, 20);
            // Bottom pipe
            const bY = p.topH + p.gap;
            ctx.fillRect(p.x, bY, 40, H - bY);
            ctx.strokeRect(p.x, bY, 40, H - bY);
            ctx.fillRect(p.x - 3, bY, 46, 20);
        });

        // Ground
        ctx.fillStyle = '#1a3300';
        ctx.fillRect(0, H - 20, W, 20);
        ctx.fillStyle = '#2a5500';
        ctx.fillRect(0, H - 20, W, 4);

        // Draw bird
        ctx.save();
        ctx.translate(bird.x, bird.y);
        ctx.rotate(Math.min(Math.max(bird.vy * 0.05, -0.4), 0.6));
        // Body
        ctx.fillStyle = '#ffd700';
        ctx.shadowColor = '#ffd700';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.ellipse(0, 0, bird.r, bird.r * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
        // Eye
        ctx.fillStyle = '#fff';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(6, -3, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(7, -3, 2, 0, Math.PI * 2);
        ctx.fill();
        // Beak
        ctx.fillStyle = '#ff8800';
        ctx.beginPath();
        ctx.moveTo(10, 1); ctx.lineTo(17, 0); ctx.lineTo(10, 4);
        ctx.fill();
        ctx.restore();
        ctx.shadowBlur = 0;

        // Start message
        if (!started) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(W/2 - 70, H/2 - 20, 140, 36);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Tap to start!', W / 2, H / 2 + 4);
        }

        // Game over
        if (!alive) {
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#ff4444';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('GAME OVER', W / 2, H / 2 - 20);
            ctx.fillStyle = '#aaa';
            ctx.font = '13px sans-serif';
            ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 10);
            ctx.fillStyle = '#00d4ff';
            ctx.fillText('Tap to retry', W / 2, H / 2 + 30);
        }

        raf = requestAnimationFrame(loop);
    }

    const onKey = (e) => { if (e.code === 'Space') { e.preventDefault(); flap(); } };
    document.addEventListener('keydown', onKey);
    canvas.addEventListener('click', flap);
    canvas.addEventListener('touchstart', (e) => { e.preventDefault(); flap(); }, { passive: false });

    document.getElementById('flappy-restart').addEventListener('click', () => startGame());

    startGame();

    return () => {
        cancelAnimationFrame(raf);
        document.removeEventListener('keydown', onKey);
    };
}

// =====================================================
// GAME: BREAKOUT
// =====================================================

function initBreakout(container) {
    const W = 240, H = 320;

    container.innerHTML = `
      <div class="flappy-ui">
        <div class="snake-score-block">
          <div class="snake-score-label">Score</div>
          <div class="snake-score-value" id="brk-score">0</div>
        </div>
        <div class="snake-score-block">
          <div class="snake-score-label">Lives</div>
          <div class="snake-score-value" id="brk-lives">3</div>
        </div>
        <button class="snake-btn" id="brk-restart">New</button>
      </div>
      <canvas id="brk-canvas" width="${W}" height="${H}" style="display:block;margin:0 auto;cursor:none;"></canvas>
      <div style="text-align:center;color:rgba(255,255,255,0.4);font-size:11px;padding:6px">Move mouse / drag to control paddle</div>
    `;

    const canvas = document.getElementById('brk-canvas');
    const ctx = canvas.getContext('2d');

    const ROWS = 5, COLS = 8;
    const BRICK_W = (W - 16) / COLS, BRICK_H = 14;

    let paddle, ball, bricks, score, lives, raf, alive, started;

    const COLORS = ['#ff4466', '#ff8800', '#ffd700', '#44ff88', '#00d4ff'];

    function startGame() {
        paddle = { x: W / 2 - 30, y: H - 30, w: 60, h: 8 };
        ball = { x: W / 2, y: H - 50, vx: 3, vy: -3, r: 6 };
        bricks = [];
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            bricks.push({ x: 8 + c * BRICK_W, y: 40 + r * (BRICK_H + 4), w: BRICK_W - 4, h: BRICK_H, alive: true, color: COLORS[r] });
        }
        score = 0; lives = 3; alive = true; started = false;
        update();
        cancelAnimationFrame(raf);
        loop();
    }

    function update() {
        document.getElementById('brk-score').textContent = score;
        document.getElementById('brk-lives').textContent = '❤️'.repeat(lives);
    }

    function loop() {
        ctx.clearRect(0, 0, W, H);

        // BG
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#0a0515');
        g.addColorStop(1, '#050010');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);

        if (started && alive) {
            // Move ball
            ball.x += ball.vx;
            ball.y += ball.vy;

            // Wall bounce
            if (ball.x - ball.r < 0) { ball.x = ball.r; ball.vx *= -1; }
            if (ball.x + ball.r > W) { ball.x = W - ball.r; ball.vx *= -1; }
            if (ball.y - ball.r < 0) { ball.y = ball.r; ball.vy *= -1; }

            // Ball lost
            if (ball.y > H + 20) {
                lives--;
                update();
                if (lives <= 0) { alive = false; }
                else { ball = { x: paddle.x + paddle.w / 2, y: H - 50, vx: 3 * (Math.random() > 0.5 ? 1 : -1), vy: -3, r: 6 }; started = false; }
            }

            // Paddle collision
            if (ball.y + ball.r > paddle.y && ball.y - ball.r < paddle.y + paddle.h &&
                ball.x > paddle.x && ball.x < paddle.x + paddle.w) {
                ball.vy = -Math.abs(ball.vy);
                const hit = (ball.x - paddle.x) / paddle.w;
                ball.vx = (hit - 0.5) * 8;
            }

            // Brick collision
            bricks.filter(b => b.alive).forEach(b => {
                if (ball.x + ball.r > b.x && ball.x - ball.r < b.x + b.w &&
                    ball.y + ball.r > b.y && ball.y - ball.r < b.y + b.h) {
                    b.alive = false;
                    ball.vy *= -1;
                    score += 10;
                    update();
                }
            });

            // Win check
            if (bricks.every(b => !b.alive)) {
                alive = false;
                score += 200;
                update();
            }
        }

        // Draw bricks
        bricks.filter(b => b.alive).forEach(b => {
            ctx.fillStyle = b.color;
            ctx.shadowColor = b.color;
            ctx.shadowBlur = 4;
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, 3);
            ctx.fill();
        });
        ctx.shadowBlur = 0;

        // Draw paddle
        const pg = ctx.createLinearGradient(paddle.x, 0, paddle.x + paddle.w, 0);
        pg.addColorStop(0, '#00d4ff');
        pg.addColorStop(1, '#0055ff');
        ctx.fillStyle = pg;
        ctx.shadowColor = '#00d4ff';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.roundRect(paddle.x, paddle.y, paddle.w, paddle.h, 4);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Draw ball
        ctx.fillStyle = '#fff';
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Start / game messages
        if (!started && alive) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(W/2 - 70, H/2 + 10, 140, 34);
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Click / drag to start', W / 2, H / 2 + 32);
            ball.x = paddle.x + paddle.w / 2;
            ball.y = H - 50;
        }

        if (!alive) {
            const won = bricks.every(b => !b.alive);
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = won ? '#ffd700' : '#ff4444';
            ctx.font = 'bold 22px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(won ? 'YOU WIN! 🎉' : 'GAME OVER', W / 2, H / 2 - 15);
            ctx.fillStyle = '#aaa';
            ctx.font = '13px sans-serif';
            ctx.fillText(`Score: ${score}`, W / 2, H / 2 + 12);
        }

        raf = requestAnimationFrame(loop);
    }

    // Mouse / touch paddle control
    const getRelX = (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = (e.clientX ?? e.touches?.[0]?.clientX) - rect.left;
        return cx * (W / rect.width);
    };

    const onMove = (e) => {
        const x = getRelX(e);
        paddle.x = Math.max(0, Math.min(W - paddle.w, x - paddle.w / 2));
        if (!started && alive) started = true;
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('touchmove', (e) => { e.preventDefault(); onMove(e); }, { passive: false });
    canvas.addEventListener('click', () => { if (!alive) startGame(); else started = true; });

    document.getElementById('brk-restart').addEventListener('click', startGame);

    startGame();

    return () => {
        cancelAnimationFrame(raf);
    };
}

// =====================================================
// INIT EXTENSION
// =====================================================

jQuery(async () => {
    loadSettings();

    // Inject HTML
    $('body').append(PHONE_HTML);

    // Toggle button
    $('#phone-widget-btn').on('click', () => {
        const overlay = document.getElementById('phone-overlay');
        if (overlay.classList.contains('visible')) closePhone();
        else openPhone();
    });

    // Home bar
    $('#phone-home-btn').on('click', goHome);

    // App icons
    $(document).on('click', '.phone-app-icon', function () {
        openApp($(this).data('app'));
    });

    // Settings panel for Extensions list
    const settingsHtml = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>📱 Phone Widget</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="flex-container alignitemscenter">
            <label class="checkbox_label" for="phone-widget-enabled">
              <input type="checkbox" id="phone-widget-enabled" ${extension_settings[EXT_NAME].enabled ? 'checked' : ''}>
              Enable Phone Widget
            </label>
          </div>
          <small style="color:var(--SmartThemeBodyColor);opacity:0.6;display:block;margin-top:6px">
            Shows a floating 📱 button on screen. Opens a phone with mini-games.
          </small>
        </div>
      </div>`;

    $('#extensions_settings').append(settingsHtml);

    $('#phone-widget-enabled').on('change', function () {
        const enabled = $(this).is(':checked');
        extension_settings[EXT_NAME].enabled = enabled;
        saveSettingsDebounced();

        if (enabled) {
            $('#phone-widget-btn').show();
        } else {
            $('#phone-widget-btn').hide();
            closePhone();
        }
    });

    // Apply initial state
    if (!extension_settings[EXT_NAME].enabled) {
        $('#phone-widget-btn').hide();
    }
});
