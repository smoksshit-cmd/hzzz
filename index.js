/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Track messages that have already been fully processed to prevent re-entry after DOM changes
const processedMessages = new Set();

// Log buffer for debugging
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    
    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai', // 'openai' or 'gemini'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    // Reference images (works for both OpenAI and Gemini)
    sendCharAvatar: false,
    sendUserAvatar: false,
    sendPreviousImage: false,
    userAvatarFile: '',
    userCharacterName: '',
    // Style preset - added to every prompt
    defaultStyle: '',
    // Gemini/nano-banana specific
    aspectRatio: '1:1',
    imageSize: '1K',
    // NEW: NPC references
    npcReferences: [],
    // NEW: Style reference images
    styleReferenceImages: [],
    sendStyleReference: false,
    // NEW: API presets
    apiPresets: [],
});

// Image model detection keywords
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    return false;
}

function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Detect MIME type from base64 header
 */
function detectMimeType(base64Data) {
    if (!base64Data || base64Data.length < 4) return 'image/png';
    if (base64Data.startsWith('/9j/')) return 'image/jpeg';
    if (base64Data.startsWith('iVBOR')) return 'image/png';
    if (base64Data.startsWith('UklGR')) return 'image/webp';
    if (base64Data.startsWith('R0lGOD')) return 'image/gif';
    return 'image/png';
}

/**
 * Check if a character name appears in the prompt (fuzzy)
 */
function nameAppearsInPrompt(name, prompt) {
    if (!name || !prompt) return false;
    const nameLower = name.toLowerCase();
    const promptLower = prompt.toLowerCase();
    if (promptLower.includes(nameLower)) return true;
    if (nameLower.length > 3) {
        const nameBase1 = nameLower.slice(0, -1);
        const nameBase2 = nameLower.slice(0, -2);
        if (promptLower.includes(nameBase1) || promptLower.includes(nameBase2)) return true;
    }
    return false;
}

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return context.extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
}

// =============================================
// API Presets
// =============================================

function saveCurrentAsPreset(presetName) {
    const settings = getSettings();
    if (!presetName || !presetName.trim()) {
        toastr.warning('Введите название пресета', 'Пресеты API');
        return false;
    }
    presetName = presetName.trim();
    if (!settings.apiPresets) settings.apiPresets = [];

    const existingIndex = settings.apiPresets.findIndex(p => p.name.toLowerCase() === presetName.toLowerCase());
    const preset = {
        name: presetName,
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        apiType: settings.apiType,
    };

    if (existingIndex !== -1) {
        settings.apiPresets[existingIndex] = preset;
        toastr.info('Пресет "' + presetName + '" обновлён', 'Пресеты API');
    } else {
        settings.apiPresets.push(preset);
        toastr.success('Пресет "' + presetName + '" сохранён', 'Пресеты API');
    }
    saveSettings();
    renderPresetList();
    return true;
}

function loadPreset(index) {
    const settings = getSettings();
    if (!settings.apiPresets || !settings.apiPresets[index]) {
        toastr.error('Пресет не найден', 'Пресеты API');
        return;
    }
    const preset = settings.apiPresets[index];
    settings.endpoint = preset.endpoint;
    settings.apiKey = preset.apiKey;
    settings.model = preset.model;
    settings.apiType = preset.apiType;
    saveSettings();

    const endpointEl = document.getElementById('iig_endpoint');
    const apiKeyEl = document.getElementById('iig_api_key');
    const modelEl = document.getElementById('iig_model');
    const apiTypeEl = document.getElementById('iig_api_type');
    if (endpointEl) endpointEl.value = preset.endpoint;
    if (apiKeyEl) apiKeyEl.value = preset.apiKey;
    if (apiTypeEl) {
        apiTypeEl.value = preset.apiType;
        const gs = document.getElementById('iig_gemini_section');
        if (gs) gs.classList.toggle('hidden', preset.apiType !== 'gemini');
    }
    if (modelEl) {
        let found = false;
        for (const opt of modelEl.options) {
            if (opt.value === preset.model) { found = true; break; }
        }
        if (!found && preset.model) {
            const opt = document.createElement('option');
            opt.value = preset.model;
            opt.textContent = preset.model;
            modelEl.appendChild(opt);
        }
        modelEl.value = preset.model;
    }
    toastr.success('Пресет "' + preset.name + '" загружен', 'Пресеты API');
}

function deletePreset(index) {
    const settings = getSettings();
    if (!settings.apiPresets || !settings.apiPresets[index]) return;
    const name = settings.apiPresets[index].name;
    settings.apiPresets.splice(index, 1);
    saveSettings();
    renderPresetList();
    toastr.info('Пресет "' + name + '" удалён', 'Пресеты API');
}

function renderPresetList() {
    const settings = getSettings();
    const container = document.getElementById('iig_preset_list');
    if (!container) return;
    container.innerHTML = '';
    if (!settings.apiPresets || settings.apiPresets.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;">Нет сохранённых пресетов</p>';
        return;
    }
    for (let i = 0; i < settings.apiPresets.length; i++) {
        const preset = settings.apiPresets[i];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';

        const nameSpan = document.createElement('span');
        nameSpan.style.cssText = 'flex:1;color:#e8e0e0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        const typeBadge = preset.apiType === 'gemini' ? '🍌' : '🤖';
        nameSpan.textContent = typeBadge + ' ' + preset.name;
        nameSpan.title = preset.endpoint + '\nМодель: ' + preset.model;

        const loadBtn = document.createElement('div');
        loadBtn.className = 'menu_button';
        loadBtn.title = 'Загрузить';
        loadBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
        loadBtn.addEventListener('click', () => loadPreset(i));

        const updateBtn = document.createElement('div');
        updateBtn.className = 'menu_button';
        updateBtn.title = 'Перезаписать';
        updateBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
        updateBtn.addEventListener('click', () => saveCurrentAsPreset(preset.name));

        const delBtn = document.createElement('div');
        delBtn.className = 'menu_button';
        delBtn.title = 'Удалить';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.style.color = '#cc5555';
        delBtn.addEventListener('click', () => deletePreset(i));

        row.appendChild(nameSpan);
        row.appendChild(loadBtn);
        row.appendChild(updateBtn);
        row.appendChild(delBtn);
        container.appendChild(row);
    }
}

// =============================================
// NPC reference list UI
// =============================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';
    if (!settings.npcReferences || settings.npcReferences.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;">Нет добавленных NPC</p>';
        return;
    }
    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];
        const row = document.createElement('div');
        row.className = 'flex-row';
        row.style.cssText = 'align-items:center;gap:8px;margin-bottom:6px;';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = npc.enabled !== false;
        cb.addEventListener('change', (e) => { settings.npcReferences[i].enabled = e.target.checked; saveSettings(); });

        const preview = document.createElement('div');
        preview.style.cssText = 'width:32px;height:32px;border-radius:6px;overflow:hidden;flex-shrink:0;';
        if (npc.imageData) {
            const img = document.createElement('img');
            img.src = 'data:image/jpeg;base64,' + npc.imageData;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            preview.appendChild(img);
        } else {
            preview.style.background = '#2a2a2a';
            preview.style.display = 'flex';
            preview.style.alignItems = 'center';
            preview.style.justifyContent = 'center';
            preview.innerHTML = '<i class="fa-solid fa-user" style="color:#5a5252;font-size:14px;"></i>';
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = npc.name;
        nameSpan.style.cssText = 'flex:1;color:#e8e0e0;font-size:12px;';

        const uploadBtn = document.createElement('div');
        uploadBtn.className = 'menu_button';
        uploadBtn.title = 'Загрузить картинку';
        uploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
        uploadBtn.addEventListener('click', () => {
            const fi = document.createElement('input');
            fi.type = 'file';
            fi.accept = 'image/*';
            fi.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    const rawBase64 = ev.target.result.split(',')[1];
                    try {
                        const compressed = await compressImageForReference(rawBase64, 768, 0.85);
                        settings.npcReferences[i].imageData = compressed;
                        saveSettings();
                        renderNpcList();
                        toastr.success('Картинка для ' + npc.name + ' загружена', 'NPC');
                    } catch (err) {
                        toastr.error('Ошибка сжатия картинки', 'NPC');
                    }
                };
                reader.readAsDataURL(file);
            });
            fi.click();
        });

        const delBtn = document.createElement('div');
        delBtn.className = 'menu_button';
        delBtn.title = 'Удалить NPC';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.style.color = '#cc5555';
        delBtn.addEventListener('click', () => {
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info('NPC "' + npc.name + '" удалён', 'NPC');
        });

        row.appendChild(cb);
        row.appendChild(preview);
        row.appendChild(nameSpan);
        row.appendChild(uploadBtn);
        row.appendChild(delBtn);
        container.appendChild(row);
    }
}

// =============================================
// Style reference list UI
// =============================================

function renderStyleRefList() {
    const settings = getSettings();
    const container = document.getElementById('iig_style_ref_list');
    if (!container) return;
    container.innerHTML = '';
    if (!settings.styleReferenceImages || settings.styleReferenceImages.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:11px;">Нет загруженных стилей</p>';
        return;
    }
    for (let i = 0; i < settings.styleReferenceImages.length; i++) {
        const sr = settings.styleReferenceImages[i];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';

        const preview = document.createElement('div');
        preview.style.cssText = 'width:48px;height:48px;border-radius:6px;overflow:hidden;flex-shrink:0;border:1px solid rgba(255,182,193,0.15);';
        if (sr.imageData) {
            const img = document.createElement('img');
            img.src = 'data:image/jpeg;base64,' + sr.imageData;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            preview.appendChild(img);
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = sr.name || ('Стиль ' + (i + 1));
        nameSpan.style.cssText = 'flex:1;color:#e8e0e0;font-size:11px;';

        const delBtn = document.createElement('div');
        delBtn.className = 'menu_button';
        delBtn.title = 'Удалить';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.style.color = '#cc5555';
        delBtn.addEventListener('click', () => {
            settings.styleReferenceImages.splice(i, 1);
            saveSettings();
            renderStyleRefList();
            toastr.info('Стилевой референс удалён', 'Генерация картинок');
        });

        row.appendChild(preview);
        row.appendChild(nameSpan);
        row.appendChild(delBtn);
        container.appendChild(row);
    }
}

// =============================================
// Avatar dropdown UI
// =============================================

function updateCharAvatarPreview() {
    const context = SillyTavern.getContext();
    const preview = document.getElementById('iig-char-avatar-preview');
    if (!preview) return;
    const character = context.characters?.[context.characterId];
    if (character?.avatar) {
        const img = preview.querySelector('img');
        if (img) img.src = '/characters/' + encodeURIComponent(character.avatar);
        preview.style.display = '';
    } else {
        preview.style.display = 'none';
    }
}

function renderAvatarDropdown(avatars) {
    const settings = getSettings();
    const list = document.getElementById('iig_avatar_dropdown_list');
    if (!list) return;
    list.innerHTML = '';

    const emptyItem = document.createElement('div');
    emptyItem.className = 'iig-avatar-dropdown-item iig-no-avatar' + (!settings.userAvatarFile ? ' selected' : '');
    emptyItem.dataset.value = '';
    emptyItem.innerHTML = '<div style="width:36px;height:36px;border-radius:5px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid fa-ban" style="color:#5a5252;font-size:12px;"></i></div><span class="iig-item-name">-- Не выбран --</span>';
    emptyItem.addEventListener('click', () => selectAvatar(''));
    list.appendChild(emptyItem);

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = 'iig-avatar-dropdown-item' + (settings.userAvatarFile === avatarFile ? ' selected' : '');
        item.dataset.value = avatarFile;
        const thumb = document.createElement('img');
        thumb.className = 'iig-item-thumb';
        thumb.src = '/User Avatars/' + encodeURIComponent(avatarFile);
        thumb.alt = avatarFile;
        thumb.loading = 'lazy';
        thumb.onerror = function () { this.style.display = 'none'; };
        const nameEl = document.createElement('span');
        nameEl.className = 'iig-item-name';
        nameEl.textContent = avatarFile;
        item.appendChild(thumb);
        item.appendChild(nameEl);
        item.addEventListener('click', () => selectAvatar(avatarFile));
        list.appendChild(item);
    }
}

async function loadAndRenderAvatars() {
    try {
        const avatars = await fetchUserAvatars();
        renderAvatarDropdown(avatars);
    } catch (error) {
        toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
    }
}

function selectAvatar(avatarFile) {
    const settings = getSettings();
    settings.userAvatarFile = avatarFile;
    saveSettings();

    const selected = document.getElementById('iig_avatar_dropdown_selected');
    if (selected) {
        if (avatarFile) {
            selected.innerHTML = '<img class="iig-dropdown-thumb" src="/User Avatars/' + encodeURIComponent(avatarFile) + '" alt="" onerror="this.style.display=\'none\'"><span class="iig-dropdown-text">' + avatarFile + '</span><span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>';
        } else {
            selected.innerHTML = '<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div><span class="iig-dropdown-text">-- Не выбран --</span><span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>';
        }
    }

    const list = document.getElementById('iig_avatar_dropdown_list');
    if (list) {
        list.querySelectorAll('.iig-avatar-dropdown-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === avatarFile);
        });
    }

    const dropdown = document.getElementById('iig_avatar_dropdown');
    if (dropdown) dropdown.classList.remove('open');
}

// =============================================
// Fetch helpers (from original)
// =============================================

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGemini = settings.apiType === 'gemini' || baseUrl.includes('googleapis.com');
    let url, fetchOptions;
    if (isGemini) {
        url = baseUrl + '/v1beta/models?key=' + settings.apiKey;
        fetchOptions = { method: 'GET' };
    } else {
        url = baseUrl + '/v1/models';
        fetchOptions = { method: 'GET', headers: { 'Authorization': 'Bearer ' + settings.apiKey } };
    }
    try {
        const response = await fetch(url, fetchOptions);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        let modelIds = [];
        if (isGemini) {
            const models = data.models || [];
            modelIds = models.map(m => (m.name || '').replace('models/', ''));
            modelIds = modelIds.filter(id => id.includes('image') || id.includes('flash') || id.includes('pro'));
        } else {
            const models = data.data || [];
            modelIds = models.filter(m => isImageModel(m.id)).map(m => m.id);
        }
        console.log('[IIG] Fetched ' + modelIds.length + ' models');
        return modelIds;
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error('Ошибка загрузки моделей: ' + error.message, 'Генерация картинок');
        return [];
    }
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

// =============================================
// Image helpers (from original)
// =============================================

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function compressImageForReference(base64Data, maxSize, quality) {
    maxSize = maxSize || 1024;
    quality = quality || 0.8;
    return new Promise((resolve, reject) => {
        try {
            const img = new Image();
            img.onload = () => {
                let width = img.width;
                let height = img.height;
                if (width > maxSize || height > maxSize) {
                    if (width > height) {
                        height = Math.round(height * maxSize / width);
                        width = maxSize;
                    } else {
                        width = Math.round(width * maxSize / height);
                        height = maxSize;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                const compressedBase64 = compressedDataUrl.replace('data:image/jpeg;base64,', '');
                console.log('[IIG] Compressed image: ' + img.width + 'x' + img.height + ' -> ' + width + 'x' + height + ', size: ' + Math.round(compressedBase64.length/1024) + 'KB');
                resolve(compressedBase64);
            };
            img.onerror = () => reject(new Error('Failed to load image for compression'));
            img.src = 'data:image/png;base64,' + base64Data;
        } catch (error) {
            reject(error);
        }
    });
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    console.log('[IIG] saveImageToFile input type:', dataUrl?.substring(0, 50));

    // If it's a direct URL, download and convert
    if (dataUrl && !dataUrl.startsWith('data:') && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        console.log('[IIG] Downloading image from URL...');
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            const mimeType = blob.type || 'image/png';
            dataUrl = 'data:' + mimeType + ';base64,' + base64;
            console.log('[IIG] Converted URL to data URL, size:', base64.length);
        } catch (err) {
            console.error('[IIG] Failed to download image:', err);
            throw new Error('Failed to download image from URL');
        }
    }

    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        console.error('[IIG] Invalid data URL, starts with:', dataUrl?.substring(0, 100));
        throw new Error('Invalid data URL format');
    }

    const format = match[1];
    const base64Data = match[2];
    console.log('[IIG] Saving image: format=' + format + ', base64 length=' + base64Data.length);

    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = 'iig_' + timestamp;

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || 'Upload failed: ' + response.status);
    }

    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) return await imageUrlToBase64(avatarUrl);
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return await imageUrlToBase64('/characters/' + encodeURIComponent(character.avatar));
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64('/User Avatars/' + encodeURIComponent(settings.userAvatarFile));
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

async function getLastGeneratedImageBase64(currentMessageId) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            if (currentMessageId !== null && currentMessageId !== undefined && i === currentMessageId) continue;
            const mes = (chat[i].mes || '');
            const imgMatch = mes.match(/src=["']?(\/user\/images\/[^"'\s>]+)/i);
            if (imgMatch) {
                const rawBase64 = await imageUrlToBase64(imgMatch[1]);
                if (!rawBase64) return null;
                return await compressImageForReference(rawBase64, 1024, 0.8);
            }
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting last generated image:', error);
        return null;
    }
}

// =============================================
// Image Generation APIs
// =============================================

async function generateImageOpenAI(prompt, style, referenceImages, options) {
    referenceImages = referenceImages || [];
    options = options || {};
    const settings = getSettings();
    const url = settings.endpoint.replace(/\/$/, '') + '/v1/images/generations';
    const fullPrompt = style ? ('[Style: ' + style + '] ' + prompt) : prompt;

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9' || options.aspectRatio === '3:2') size = '1536x1024';
        else if (options.aspectRatio === '9:16' || options.aspectRatio === '2:3') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
        else size = 'auto';
    }

    const body = { model: settings.model, prompt: fullPrompt, n: 1 };
    if (size && size !== 'auto') body.size = size;
    body.response_format = 'b64_json';

    if (referenceImages.length > 0) {
        console.log('[IIG] Reference images collected but NOT sent (/generations endpoint is text-to-image only)');
    }

    console.log('[IIG] OpenAI Request:', { url: url, model: body.model, size: body.size || 'not set', promptLength: fullPrompt.length });

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error('API Error (' + response.status + '): ' + text);
    }

    const result = await response.json();
    const dataList = result.data || result.images || [];

    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.image) {
            if (result.image.startsWith('data:')) return result.image;
            return 'data:image/png;base64,' + result.image;
        }
        if (result.b64_json) return 'data:image/png;base64,' + result.b64_json;
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    const b64Data = imageObj.b64_json || imageObj.b64 || imageObj.base64 || imageObj.image;
    const urlData = imageObj.url || imageObj.uri;

    if (b64Data) {
        if (b64Data.startsWith('data:')) return b64Data;
        let mimeType = 'image/png';
        if (b64Data.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (b64Data.startsWith('R0lGOD')) mimeType = 'image/gif';
        else if (b64Data.startsWith('UklGR')) mimeType = 'image/webp';
        return 'data:' + mimeType + ';base64,' + b64Data;
    }
    if (urlData) return urlData;
    throw new Error('Unexpected image response format');
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 * Enhanced: separates character refs from style refs
 */
async function generateImageGemini(prompt, style, referenceImages, options) {
    referenceImages = referenceImages || [];
    options = options || {};
    const settings = getSettings();
    const model = settings.model;
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGoogleApi = baseUrl.includes('googleapis.com');

    const url = isGoogleApi
        ? baseUrl + '/v1beta/models/' + model + ':generateContent?key=' + settings.apiKey
        : baseUrl + '/v1beta/models/' + model + ':generateContent';

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }

    iigLog('INFO', 'Using aspect ratio: ' + aspectRatio + ', image size: ' + imageSize);

    // Separate character refs from style refs
    // referenceImages can be plain base64 strings OR objects with {data, label, mimeType}
    const characterRefs = [];
    const styleRefs = [];
    const plainRefs = [];

    for (const ref of referenceImages) {
        if (typeof ref === 'string') {
            // Plain base64 string (legacy format)
            plainRefs.push(ref);
        } else if (ref && ref.data) {
            if (ref.label && ref.label.startsWith('style:')) {
                styleRefs.push(ref);
            } else {
                characterRefs.push(ref);
            }
        }
    }

    const parts = [];

    // If we have labeled refs, use enhanced prompting
    if (characterRefs.length > 0 || styleRefs.length > 0) {
        let preInstruction = '[IMPORTANT: REFERENCE IMAGES FOLLOW]\n';
        if (characterRefs.length > 0) {
            preInstruction += 'CHARACTER REFERENCES (' + characterRefs.length + ' images):\nThese images show EXACT appearances you MUST replicate.\n';
            characterRefs.forEach((ref, i) => {
                preInstruction += '  - Reference Image ' + (i + 1) + ': "' + ref.label + '"\n';
            });
            preInstruction += '\n';
        }
        if (styleRefs.length > 0) {
            preInstruction += 'STYLE REFERENCES (' + styleRefs.length + ' images):\nCopy the art style, NOT the content.\n';
        }
        parts.push({ text: preInstruction });

        // Add character ref images
        for (let idx = 0; idx < Math.min(characterRefs.length, 4); idx++) {
            const ref = characterRefs[idx];
            parts.push({ inlineData: { mimeType: ref.mimeType || 'image/png', data: ref.data } });
            parts.push({ text: '[REFERENCE IMAGE ' + (idx + 1) + ': "' + ref.label + '"]\nCOPY THIS EXACT APPEARANCE when drawing "' + ref.label + '". Match face, hair, skin tone, body type precisely.\n' });
        }

        // Add style ref images
        for (const ref of styleRefs.slice(0, 2)) {
            parts.push({ inlineData: { mimeType: ref.mimeType || 'image/png', data: ref.data } });
            const styleName = ref.label.replace('style:', '');
            parts.push({ text: '[STYLE REFERENCE: "' + styleName + '"]\nCopy the art technique, color palette, linework from this image.\n' });
        }
    }

    // Plain (unlabeled) refs - original behavior
    if (plainRefs.length > 0) {
        for (const imgB64 of plainRefs.slice(0, 4)) {
            parts.push({ inlineData: { mimeType: 'image/png', data: imgB64 } });
        }
    }

    // Build main prompt
    let fullPrompt = '';

    if (characterRefs.length > 0) {
        fullPrompt += '[CHARACTER APPEARANCE MAPPING]\n';
        characterRefs.forEach((ref, i) => {
            fullPrompt += '"' + ref.label + '" = Reference Image ' + (i + 1) + ' (COPY EXACTLY)\n';
        });
        fullPrompt += '\n';
    }

    if (styleRefs.length > 0) {
        fullPrompt += '[STYLE INSTRUCTION] Apply the visual style from the style reference(s).\n\n';
    }

    fullPrompt += style ? ('[Style: ' + style + '] ' + prompt) : prompt;

    // If we had plain refs with instruction
    if (plainRefs.length > 0 && characterRefs.length === 0) {
        const refInstruction = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features.]';
        fullPrompt = refInstruction + '\n\n' + fullPrompt;
    }

    parts.push({ text: fullPrompt });

    iigLog('INFO', 'Gemini request: ' + characterRefs.length + ' char ref(s), ' + styleRefs.length + ' style ref(s), ' + plainRefs.length + ' plain ref(s), prompt ' + fullPrompt.length + ' chars');

    const body = {
        contents: [{ role: 'user', parts: parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio: aspectRatio, imageSize: imageSize }
        }
    };

    const headers = { 'Content-Type': 'application/json' };
    if (!isGoogleApi) {
        headers['Authorization'] = 'Bearer ' + settings.apiKey;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error('API Error (' + response.status + '): ' + text);
    }

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return 'data:' + part.inlineData.mimeType + ';base64,' + part.inlineData.data;
        if (part.inline_data) return 'data:' + part.inline_data.mime_type + ';base64,' + part.inline_data.data;
    }
    throw new Error('No image found in Gemini response');
}

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error('Ошибка настроек: ' + errors.join(', '));
}

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generate image with retry logic
 * Enhanced: collects labeled refs, NPC refs, style refs
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options) {
    options = options || {};
    validateSettings();
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    // Collect reference images - can be plain base64 or labeled objects
    const referenceImages = [];

    if (settings.sendCharAvatar) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const compressed = await compressImageForReference(charAvatar, 768, 0.85);
            const charName = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name || 'Character';
            referenceImages.push({ data: compressed, label: charName, mimeType: detectMimeType(compressed) });
            iigLog('INFO', 'Character avatar added: "' + charName + '"');
        }
    }

    if (settings.sendUserAvatar) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const compressed = await compressImageForReference(userAvatar, 768, 0.85);
            let userName = (settings.userCharacterName || '').trim();
            if (!userName) userName = (settings.userAvatarFile || 'User').replace(/\.[^.]+$/, '');
            referenceImages.push({ data: compressed, label: userName, mimeType: detectMimeType(compressed) });
            iigLog('INFO', 'User avatar added: "' + userName + '"');
        }
    }

    if (settings.sendPreviousImage) {
        const prevImage = await getLastGeneratedImageBase64();
        if (prevImage) {
            referenceImages.push({ data: prevImage, label: 'previous_scene', mimeType: detectMimeType(prevImage) });
            iigLog('INFO', 'Previous image added');
        }
    }

    // NPC references - only if name appears in prompt
    if (settings.npcReferences && settings.npcReferences.length > 0) {
        for (const npc of settings.npcReferences) {
            if (!npc.enabled || !npc.imageData) continue;
            if (nameAppearsInPrompt(npc.name, prompt)) {
                referenceImages.push({ data: npc.imageData, label: npc.name, mimeType: detectMimeType(npc.imageData) });
                iigLog('INFO', 'NPC "' + npc.name + '" found in prompt, adding reference');
            }
        }
    }

    // Style reference images
    if (settings.sendStyleReference && settings.styleReferenceImages && settings.styleReferenceImages.length > 0) {
        for (const sr of settings.styleReferenceImages) {
            if (sr.imageData) {
                referenceImages.push({ data: sr.imageData, label: 'style:' + sr.name, mimeType: detectMimeType(sr.imageData) });
                iigLog('INFO', 'Style reference "' + sr.name + '" added');
            }
        }
    }

    iigLog('INFO', 'Total reference images: ' + referenceImages.length);

    let finalStyle = style || '';
    if (settings.defaultStyle) {
        finalStyle = settings.defaultStyle + (finalStyle ? ', ' + finalStyle : '');
    }

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (onStatusUpdate) onStatusUpdate('Генерация' + (attempt > 0 ? ' (повтор ' + attempt + '/' + maxRetries + ')' : '') + '...');
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, finalStyle, referenceImages, options);
            } else {
                return await generateImageOpenAI(prompt, finalStyle, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            console.error('[IIG] Generation attempt ' + (attempt + 1) + ' failed:', error);
            const isRetryable = error.message?.includes('429') || error.message?.includes('503') || error.message?.includes('502') || error.message?.includes('504') || error.message?.includes('timeout') || error.message?.includes('network');
            if (!isRetryable || attempt === maxRetries) break;
            const delay = baseDelay * Math.pow(2, attempt);
            if (onStatusUpdate) onStatusUpdate('Повтор через ' + (delay / 1000) + 'с...');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

// =============================================
// Tag parsing (from original, exact copy)
// =============================================

async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

async function parseImageTags(text, options) {
    options = options || {};
    const checkExistence = options.checkExistence || false;
    const forceAll = options.forceAll || false;
    const tags = [];

    // NEW FORMAT
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }

        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }

        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) { needsGeneration = true; }
        else if (hasMarker || !srcValue) { needsGeneration = true; }
        else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) { iigLog('WARN', 'File does not exist: ' + srcValue); needsGeneration = true; }
        } else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });
            iigLog('INFO', 'Found NEW format tag: ' + (data.prompt || '').substring(0, 50));
        } catch (e) {
            iigLog('WARN', 'Failed to parse instruction JSON: ' + instructionJson.substring(0, 100));
        }
        searchPos = imgEnd;
    }

    // LEGACY FORMAT
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart2 = markerIndex + marker.length;
        let braceCount = 0, jsonEnd2 = -1, inString = false, escapeNext = false;
        for (let i = jsonStart2; i < text.length; i++) {
            const char = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (char === '\\' && inString) { escapeNext = true; continue; }
            if (char === '"') { inString = !inString; continue; }
            if (!inString) {
                if (char === '{') braceCount++;
                else if (char === '}') { braceCount--; if (braceCount === 0) { jsonEnd2 = i + 1; break; } }
            }
        }
        if (jsonEnd2 === -1) { searchStart = jsonStart2; continue; }
        const jsonStr = text.substring(jsonStart2, jsonEnd2);
        if (!text.substring(jsonEnd2).startsWith(']')) { searchStart = jsonEnd2; continue; }
        const tagOnly = text.substring(markerIndex, jsonEnd2 + 1);
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null, isNewFormat: false
            });
            iigLog('INFO', 'Found LEGACY format tag: ' + (data.prompt || '').substring(0, 50));
        } catch (e) {
            iigLog('WARN', 'Failed to parse legacy tag JSON');
        }
        searchStart = jsonEnd2 + 1;
    }
    return tags;
}

// =============================================
// DOM helpers (from original)
// =============================================

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = '<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>';
    return placeholder;
}

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = 'Ошибка: ' + errorMessage;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) img.setAttribute('data-iig-instruction', instructionMatch[2]);
    }
    return img;
}

// =============================================
// Message processing (from original + processedMessages guard)
// =============================================

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;

    if (processingMessages.has(messageId)) {
        iigLog('WARN', 'Message ' + messageId + ' is already being processed, skipping');
        return;
    }
    if (processedMessages.has(messageId)) {
        iigLog('INFO', 'Message ' + messageId + ' was already processed, skipping');
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', 'parseImageTags returned: ' + tags.length + ' tags');
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        processedMessages.add(messageId);
        return;
    }

    processingMessages.add(messageId);
    iigLog('INFO', 'Found ' + tags.length + ' image tag(s) in message ' + messageId);
    toastr.info('Найдено тегов: ' + tags.length + '. Генерация...', 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector('#chat .mes[mesid="' + messageId + '"]');
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }

    const processTag = async (tag, index) => {
        const tagId = 'iig-' + messageId + '-' + index;
        iigLog('INFO', 'Processing tag ' + index);
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);

            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                if (instruction) {
                    const decoded = instruction.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
                    if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                    try {
                        const d = JSON.parse(decoded.replace(/'/g, '"'));
                        if (d.prompt && d.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                    } catch (e) {}
                    if (instruction.includes(searchPrompt)) { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') { targetElement = img; break; }
                }
            }
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) { targetElement = img; break; }
                }
            }
        } else {
            const tagEscaped = tag.fullMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|&quot;)');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped, 'g'), '<span data-iig-placeholder="' + tagId + '"></span>');
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector('[data-iig-placeholder="' + tagId + '"]');
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    if (img.src && img.src.includes('[IMG:GEN:')) { targetElement = img; break; }
                }
            }
        }

        if (targetElement) {
            targetElement.replaceWith(loadingPlaceholder);
        } else {
            mesTextEl.appendChild(loadingPlaceholder);
        }

        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        try {
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { statusEl.textContent = s; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality });
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = 'Style: ' + tag.style + '\nPrompt: ' + tag.prompt;
            if (tag.isNewFormat) {
                const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (m) img.setAttribute('data-iig-instruction', m[2]);
            }
            loadingPlaceholder.replaceWith(img);
            if (tag.isNewFormat) {
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, 'src="' + imagePath + '"'));
            } else {
                message.mes = message.mes.replace(tag.fullMatch, '[IMG:\u2713:' + imagePath + ']');
            }
            iigLog('INFO', 'Successfully generated image for tag ' + index);
            toastr.success('Картинка ' + (index + 1) + '/' + tags.length + ' готова', 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', 'Failed to generate image for tag ' + index + ':', error.message);
            const ep = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(ep);
            if (tag.isNewFormat) {
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, 'src="' + ERROR_IMAGE_PATH + '"'));
            } else {
                message.mes = message.mes.replace(tag.fullMatch, '[IMG:ERROR:' + error.message.substring(0, 50) + ']');
            }
            toastr.error('Ошибка генерации: ' + error.message, 'Генерация картинок');
        }
    };

    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        processedMessages.add(messageId);
        processingMessages.delete(messageId);
    }
    await context.saveChat();
    iigLog('INFO', 'Finished processing message ' + messageId);
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }
    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }

    iigLog('INFO', 'Regenerating ' + tags.length + ' images in message ' + messageId);
    toastr.info('Перегенерация ' + tags.length + ' картинок...', 'Генерация картинок');

    processedMessages.delete(messageId);
    processingMessages.add(messageId);

    const messageElement = document.querySelector('#chat .mes[mesid="' + messageId + '"]');
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = 'iig-regen-' + messageId + '-' + index;
        try {
            const existingImg = mesTextEl.querySelector('img[data-iig-instruction]');
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const lp = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(lp);
                const statusEl = lp.querySelector('.iig-status');
                const dataUrl = await generateImageWithRetry(tag.prompt, tag.style, (s) => { statusEl.textContent = s; }, { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality });
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
                lp.replaceWith(img);
                message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, 'src="' + imagePath + '"'));
                toastr.success('Картинка ' + (index + 1) + '/' + tags.length + ' готова', 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', 'Regeneration failed for tag ' + index + ':', error.message);
            toastr.error('Ошибка: ' + error.message, 'Генерация картинок');
        }
    }

    processedMessages.add(messageId);
    processingMessages.delete(messageId);
    await context.saveChat();
}

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extraMesButtons.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    const messageElements = document.querySelectorAll('#chat .mes');
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (message && !message.is_user) addRegenerateButton(messageElement, messageId);
    }
}

async function onMessageReceived(messageId) {
    iigLog('INFO', 'onMessageReceived: ' + messageId);
    const settings = getSettings();
    if (!settings.enabled) return;

    const messageElement = document.querySelector('#chat .mes[mesid="' + messageId + '"]');
    if (!messageElement) return;
    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

// =============================================
// Settings UI
// =============================================

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) { console.error('[IIG] Settings container not found'); return; }

    // Build HTML using DOM to avoid template literal issues
    const wrapper = document.createElement('div');
    wrapper.className = 'inline-drawer';
    wrapper.innerHTML = '<div class="inline-drawer-toggle inline-drawer-header"><b>Генерация картинок</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>';

    const content = document.createElement('div');
    content.className = 'inline-drawer-content';

    const s = document.createElement('div');
    s.className = 'iig-settings';

    s.innerHTML = [
        // Enable
        '<label class="checkbox_label"><input type="checkbox" id="iig_enabled"' + (settings.enabled ? ' checked' : '') + '><span>Включить генерацию картинок</span></label>',
        '<hr>',
        // Presets
        '<h4>Пресеты API</h4>',
        '<p class="hint">Сохраняйте комбинации эндпоинт + ключ + модель для быстрого переключения.</p>',
        '<div id="iig_preset_list"></div>',
        '<div class="flex-row" style="margin-top:8px;"><input type="text" id="iig_preset_new_name" class="text_pole flex1" placeholder="Название пресета"><div id="iig_preset_save" class="menu_button" title="Сохранить"><i class="fa-solid fa-floppy-disk"></i> Сохранить</div></div>',
        '<hr>',
        // API settings
        '<h4>Настройки API</h4>',
        '<div class="flex-row"><label for="iig_api_type">Тип API</label><select id="iig_api_type" class="flex1"><option value="openai"' + (settings.apiType === 'openai' ? ' selected' : '') + '>OpenAI-совместимый</option><option value="gemini"' + (settings.apiType === 'gemini' ? ' selected' : '') + '>Gemini (nano-banana)</option></select></div>',
        '<div class="flex-row"><label for="iig_endpoint">URL эндпоинта</label><input type="text" id="iig_endpoint" class="text_pole flex1" value="' + (settings.endpoint || '') + '" placeholder="https://api.example.com"></div>',
        '<div class="flex-row"><label for="iig_api_key">API ключ</label><input type="password" id="iig_api_key" class="text_pole flex1" value="' + (settings.apiKey || '') + '"><div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть"><i class="fa-solid fa-eye"></i></div></div>',
        '<div class="flex-row"><label for="iig_model">Модель</label><select id="iig_model" class="flex1">' + (settings.model ? '<option value="' + settings.model + '" selected>' + settings.model + '</option>' : '<option value="">-- Выберите модель --</option>') + '</select><div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div></div>',
        '<hr>',
        // Generation params
        '<h4>Параметры генерации</h4>',
        '<div class="flex-row"><label for="iig_size">Размер</label><select id="iig_size" class="flex1"><option value="1024x1024"' + (settings.size === '1024x1024' ? ' selected' : '') + '>1024x1024</option><option value="1792x1024"' + (settings.size === '1792x1024' ? ' selected' : '') + '>1792x1024</option><option value="1024x1792"' + (settings.size === '1024x1792' ? ' selected' : '') + '>1024x1792</option><option value="512x512"' + (settings.size === '512x512' ? ' selected' : '') + '>512x512</option></select></div>',
        '<div class="flex-row"><label for="iig_quality">Качество</label><select id="iig_quality" class="flex1"><option value="standard"' + (settings.quality === 'standard' ? ' selected' : '') + '>Стандартное</option><option value="hd"' + (settings.quality === 'hd' ? ' selected' : '') + '>HD</option></select></div>',
        '<hr>',
        // Style & References
        '<h4>Стиль и референсы</h4>',
        '<div class="flex-row"><label for="iig_default_style">Стиль по умолчанию</label><textarea id="iig_default_style" class="text_pole flex1" rows="2" placeholder="semi_realistic, manhwa style...">' + (settings.defaultStyle || '') + '</textarea></div>',
        '<p class="hint">Добавляется к каждому промпту.</p>',
        // Char avatar
        '<h5>Референсы аватаров</h5>',
        '<div class="flex-row" style="align-items:center;gap:8px;"><label class="checkbox_label" style="flex:1;margin:0;"><input type="checkbox" id="iig_send_char_avatar"' + (settings.sendCharAvatar ? ' checked' : '') + '><span>Отправлять аватар персонажа</span></label><div id="iig-char-avatar-preview" class="iig-avatar-preview" style="display:none;"><img src="" alt="char" /></div></div>',
        // User avatar
        '<label class="checkbox_label"><input type="checkbox" id="iig_send_user_avatar"' + (settings.sendUserAvatar ? ' checked' : '') + '><span>Отправлять аватар юзера</span></label>',
        // User avatar dropdown
        '<div id="iig_user_avatar_row" class="flex-row' + (!settings.sendUserAvatar ? ' hidden' : '') + '" style="margin-top:5px;align-items:center;"><label>Файл аватара</label><div id="iig_avatar_dropdown" class="iig-avatar-dropdown"><div id="iig_avatar_dropdown_selected" class="iig-avatar-dropdown-selected">' + (settings.userAvatarFile ? '<img class="iig-dropdown-thumb" src="/User Avatars/' + encodeURIComponent(settings.userAvatarFile) + '" alt="" onerror="this.style.display=\'none\'"><span class="iig-dropdown-text">' + settings.userAvatarFile + '</span>' : '<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div><span class="iig-dropdown-text">-- Не выбран --</span>') + '<span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span></div><div id="iig_avatar_dropdown_list" class="iig-avatar-dropdown-list"></div></div><div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div></div>',
        // User char name
        '<div id="iig_user_name_row" class="flex-row' + (!settings.sendUserAvatar ? ' hidden' : '') + '" style="margin-top:5px;"><label for="iig_user_char_name">Имя в промптах</label><input type="text" id="iig_user_char_name" class="text_pole flex1" value="' + (settings.userCharacterName || '') + '" placeholder="User, MC..."></div>',
        '<p id="iig_user_name_hint" class="hint' + (!settings.sendUserAvatar ? ' hidden' : '') + '">Имя персонажа как оно появляется в промптах генерации.</p>',
        // Previous image
        '<label class="checkbox_label"><input type="checkbox" id="iig_send_previous_image"' + (settings.sendPreviousImage ? ' checked' : '') + '><span>Отправлять предыдущую картинку</span></label>',
        '<p class="hint">Последняя картинка из чата для сохранения одежды, локации.</p>',
        '<hr>',
        // NPC References
        '<h5>NPC-референсы</h5>',
        '<p class="hint">Референс отправляется если имя NPC встречается в промпте.</p>',
        '<div id="iig_npc_list"></div>',
        '<div class="flex-row" style="margin-top:8px;"><input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC (напр. Luca)"><div id="iig_npc_add" class="menu_button"><i class="fa-solid fa-plus"></i> Добавить</div></div>',
        '<hr>',
        // Style Reference
        '<h5>Референс стиля</h5>',
        '<p class="hint">Нанобанана будет копировать визуальный стиль.</p>',
        '<label class="checkbox_label"><input type="checkbox" id="iig_send_style_ref"' + (settings.sendStyleReference ? ' checked' : '') + '><span>Отправлять стилевой референс</span></label>',
        '<div id="iig_style_ref_container" class="' + (!settings.sendStyleReference ? 'hidden' : '') + '"><div id="iig_style_ref_list"></div><div id="iig_style_ref_upload" class="menu_button" style="width:100%;margin-top:5px;"><i class="fa-solid fa-palette"></i> Загрузить картинку стиля</div></div>',
        '<hr>',
        // Gemini section
        '<div id="iig_gemini_section" class="' + (settings.apiType !== 'gemini' ? 'hidden' : '') + '"><h4>Настройки Nano-Banana</h4><div class="flex-row"><label for="iig_aspect_ratio">Соотношение сторон</label><select id="iig_aspect_ratio" class="flex1"><option value="1:1"' + (settings.aspectRatio === '1:1' ? ' selected' : '') + '>1:1</option><option value="2:3"' + (settings.aspectRatio === '2:3' ? ' selected' : '') + '>2:3</option><option value="3:2"' + (settings.aspectRatio === '3:2' ? ' selected' : '') + '>3:2</option><option value="3:4"' + (settings.aspectRatio === '3:4' ? ' selected' : '') + '>3:4</option><option value="4:3"' + (settings.aspectRatio === '4:3' ? ' selected' : '') + '>4:3</option><option value="4:5"' + (settings.aspectRatio === '4:5' ? ' selected' : '') + '>4:5</option><option value="5:4"' + (settings.aspectRatio === '5:4' ? ' selected' : '') + '>5:4</option><option value="9:16"' + (settings.aspectRatio === '9:16' ? ' selected' : '') + '>9:16</option><option value="16:9"' + (settings.aspectRatio === '16:9' ? ' selected' : '') + '>16:9</option><option value="21:9"' + (settings.aspectRatio === '21:9' ? ' selected' : '') + '>21:9</option></select></div><div class="flex-row"><label for="iig_image_size">Разрешение</label><select id="iig_image_size" class="flex1"><option value="1K"' + (settings.imageSize === '1K' ? ' selected' : '') + '>1K</option><option value="2K"' + (settings.imageSize === '2K' ? ' selected' : '') + '>2K</option><option value="4K"' + (settings.imageSize === '4K' ? ' selected' : '') + '>4K</option></select></div><hr></div>',
        // Error handling
        '<h4>Обработка ошибок</h4>',
        '<div class="flex-row"><label for="iig_max_retries">Макс. повторов</label><input type="number" id="iig_max_retries" class="text_pole flex1" value="' + settings.maxRetries + '" min="0" max="5"></div>',
        '<div class="flex-row"><label for="iig_retry_delay">Задержка (мс)</label><input type="number" id="iig_retry_delay" class="text_pole flex1" value="' + settings.retryDelay + '" min="500" max="10000" step="500"></div>',
        '<hr>',
        // Debug
        '<h4>Отладка</h4>',
        '<div class="flex-row"><div id="iig_export_logs" class="menu_button" style="width:100%;"><i class="fa-solid fa-download"></i> Экспорт логов</div></div>'
    ].join('');

    content.appendChild(s);
    wrapper.appendChild(content);
    container.appendChild(wrapper);

    bindSettingsEvents();
    updateCharAvatarPreview();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value; saveSettings();
        document.getElementById('iig_gemini_section')?.classList.toggle('hidden', e.target.value !== 'gemini');
    });
    document.getElementById('iig_default_style')?.addEventListener('input', (e) => { settings.defaultStyle = e.target.value; saveSettings(); });
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value; saveSettings();
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini'; settings.apiType = 'gemini';
            document.getElementById('iig_gemini_section')?.classList.remove('hidden');
        }
    });
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const cur = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) { const o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = (m === cur); select.appendChild(o); }
            toastr.success('Найдено моделей: ' + models.length, 'Генерация картинок');
        } catch (err) { toastr.error('Ошибка загрузки моделей', 'Генерация картинок'); }
        finally { btn.classList.remove('loading'); }
    });
    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
        document.getElementById('iig_user_name_row')?.classList.toggle('hidden', !e.target.checked);
        document.getElementById('iig_user_name_hint')?.classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('iig_user_char_name')?.addEventListener('input', (e) => { settings.userCharacterName = e.target.value; saveSettings(); });
    document.getElementById('iig_send_previous_image')?.addEventListener('change', (e) => { settings.sendPreviousImage = e.target.checked; saveSettings(); });

    // Avatar dropdown
    document.getElementById('iig_avatar_dropdown_selected')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = document.getElementById('iig_avatar_dropdown');
        if (dd) {
            const wasOpen = dd.classList.contains('open');
            dd.classList.toggle('open');
            if (!wasOpen) { const list = document.getElementById('iig_avatar_dropdown_list'); if (list && list.children.length === 0) loadAndRenderAvatars(); }
        }
    });
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('iig_avatar_dropdown');
        if (dd && !dd.contains(e.target)) dd.classList.remove('open');
    });
    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        e.stopPropagation(); const btn = e.currentTarget; btn.classList.add('loading');
        await loadAndRenderAvatars(); btn.classList.remove('loading');
        document.getElementById('iig_avatar_dropdown')?.classList.add('open');
    });

    // NPC
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const ni = document.getElementById('iig_npc_new_name');
        const name = ni?.value?.trim();
        if (!name) { toastr.warning('Введите имя NPC', 'NPC'); return; }
        if (!settings.npcReferences) settings.npcReferences = [];
        if (settings.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) { toastr.warning('NPC "' + name + '" уже существует', 'NPC'); return; }
        settings.npcReferences.push({ name: name, imageData: null, enabled: true });
        saveSettings(); ni.value = ''; renderNpcList();
        toastr.success('NPC "' + name + '" добавлен. Загрузите картинку!', 'NPC');
    });

    // Style ref
    document.getElementById('iig_send_style_ref')?.addEventListener('change', (e) => {
        settings.sendStyleReference = e.target.checked; saveSettings();
        document.getElementById('iig_style_ref_container')?.classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('iig_style_ref_upload')?.addEventListener('click', () => {
        const fi = document.createElement('input'); fi.type = 'file'; fi.accept = 'image/*';
        fi.addEventListener('change', async (e) => {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                const rawBase64 = ev.target.result.split(',')[1];
                try {
                    const compressed = await compressImageForReference(rawBase64, 768, 0.75);
                    if (!settings.styleReferenceImages) settings.styleReferenceImages = [];
                    const styleName = file.name.replace(/\.[^.]+$/, '') || ('style_' + Date.now());
                    settings.styleReferenceImages.push({ name: styleName, imageData: compressed });
                    saveSettings(); renderStyleRefList();
                    toastr.success('Стиль "' + styleName + '" загружен', 'Генерация картинок');
                } catch (err) { toastr.error('Ошибка сжатия картинки', 'Генерация картинок'); }
            };
            reader.readAsDataURL(file);
        });
        fi.click();
    });

    // Error handling
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    // Presets
    document.getElementById('iig_preset_save')?.addEventListener('click', () => {
        const ni = document.getElementById('iig_preset_new_name');
        if (saveCurrentAsPreset(ni?.value)) ni.value = '';
    });
    document.getElementById('iig_preset_new_name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('iig_preset_save')?.click(); }
    });

    renderPresetList();
    renderNpcList();
    renderStyleRefList();
}

// =============================================
// Init (from original)
// =============================================

(function init() {
    const context = SillyTavern.getContext();
    console.log('[IIG] Available event_types:', context.event_types);
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event');
        processedMessages.clear();
        processingMessages.clear();
        setTimeout(() => { addButtonsToExistingMessages(); }, 100);
        setTimeout(updateCharAvatarPreview, 200);
    });

    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    console.log('[IIG] Inline Image Generation extension initialized');
})();
