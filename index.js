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
    const message = args.map(a => {
        if (typeof a === 'object') {
            try {
                return JSON.stringify(a);
            } catch (e) {
                return String(a);
            }
        }
        return String(a);
    }).join(' ');
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
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    sendCharAvatar: false,
    sendUserAvatar: false,
    sendPreviousImage: false,
    userAvatarFile: '',
    userCharacterName: '',
    defaultStyle: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    npcReferences: [],
    styleReferenceImages: [],
    sendStyleReference: false,
    apiPresets: [],
});

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

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

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const models = data.data || [];
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
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

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

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

async function compressImageForReference(base64Data, maxSize = 1024, quality = 0.8) {
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

                console.log(`[IIG] Compressed image: ${img.width}x${img.height} -> ${width}x${height}, size: ${Math.round(compressedBase64.length / 1024)}KB`);
                resolve(compressedBase64);
            };
            img.onerror = () => reject(new Error('Failed to load image for compression'));
            img.src = `data:image/png;base64,${base64Data}`;
        } catch (error) {
            reject(error);
        }
    });
}

function saveCurrentAsPreset(presetName) {
    const settings = getSettings();

    if (!presetName || !presetName.trim()) {
        toastr.warning('Введите название пресета', 'Пресеты API');
        return false;
    }

    presetName = presetName.trim();

    if (!settings.apiPresets) {
        settings.apiPresets = [];
    }

    // Проверить дубликат
    const existingIndex = settings.apiPresets.findIndex(
        p => p.name.toLowerCase() === presetName.toLowerCase()
    );

    const preset = {
        name: presetName,
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        apiType: settings.apiType,
    };

    if (existingIndex !== -1) {
        settings.apiPresets[existingIndex] = preset;
        toastr.info(`Пресет "${presetName}" обновлён`, 'Пресеты API');
    } else {
        settings.apiPresets.push(preset);
        toastr.success(`Пресет "${presetName}" сохранён`, 'Пресеты API');
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

    // Обновить UI поля
    const endpointEl = document.getElementById('iig_endpoint');
    const apiKeyEl = document.getElementById('iig_api_key');
    const modelEl = document.getElementById('iig_model');
    const apiTypeEl = document.getElementById('iig_api_type');

    if (endpointEl) endpointEl.value = preset.endpoint;
    if (apiKeyEl) apiKeyEl.value = preset.apiKey;
    if (apiTypeEl) {
        apiTypeEl.value = preset.apiType;
        const geminiSection = document.getElementById('iig_gemini_section');
        if (geminiSection) {
            geminiSection.classList.toggle('hidden', preset.apiType !== 'gemini');
        }
    }
    if (modelEl) {
        // Если модели нет в списке — добавить как опцию
        let found = false;
        for (const opt of modelEl.options) {
            if (opt.value === preset.model) {
                found = true;
                break;
            }
        }
        if (!found && preset.model) {
            const option = document.createElement('option');
            option.value = preset.model;
            option.textContent = preset.model;
            modelEl.appendChild(option);
        }
        modelEl.value = preset.model;
    }

    toastr.success(`Пресет "${preset.name}" загружен`, 'Пресеты API');
    iigLog('INFO', `Loaded API preset: "${preset.name}" (${preset.apiType}, ${preset.endpoint})`);
}

function deletePreset(index) {
    const settings = getSettings();

    if (!settings.apiPresets || !settings.apiPresets[index]) return;

    const name = settings.apiPresets[index].name;
    settings.apiPresets.splice(index, 1);
    saveSettings();
    renderPresetList();
    toastr.info(`Пресет "${name}" удалён`, 'Пресеты API');
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
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.marginBottom = '6px';

        const nameSpan = document.createElement('span');
        nameSpan.style.flex = '1';
        nameSpan.style.color = '#e8e0e0';
        nameSpan.style.fontSize = '12px';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.whiteSpace = 'nowrap';

        const typeBadge = preset.apiType === 'gemini' ? '🍌' : '🤖';
        const maskedKey = preset.apiKey
            ? preset.apiKey.substring(0, 4) + '••••' + preset.apiKey.slice(-4)
            : 'нет ключа';
        nameSpan.textContent = `${typeBadge} ${preset.name}`;
        nameSpan.title = `${preset.endpoint}\nМодель: ${preset.model}\nКлюч: ${maskedKey}`;

        const loadBtn = document.createElement('div');
        loadBtn.className = 'menu_button';
        loadBtn.title = 'Загрузить пресет';
        loadBtn.innerHTML = '<i class="fa-solid fa-download"></i>';
        loadBtn.addEventListener('click', () => loadPreset(i));

        const updateBtn = document.createElement('div');
        updateBtn.className = 'menu_button';
        updateBtn.title = 'Перезаписать текущими настройками';
        updateBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
        updateBtn.addEventListener('click', () => {
            saveCurrentAsPreset(preset.name);
        });

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button';
        deleteBtn.title = 'Удалить пресет';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => deletePreset(i));

        row.appendChild(nameSpan);
        row.appendChild(loadBtn);
        row.appendChild(updateBtn);
        row.appendChild(deleteBtn);
        container.appendChild(row);
    }
}

function detectMimeType(base64Data) {
    if (!base64Data || base64Data.length < 4) return 'image/png';
    if (base64Data.startsWith('/9j/')) return 'image/jpeg';
    if (base64Data.startsWith('iVBOR')) return 'image/png';
    if (base64Data.startsWith('UklGR')) return 'image/webp';
    if (base64Data.startsWith('R0lGOD')) return 'image/gif';
    return 'image/png';
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();

    console.log('[IIG] saveImageToFile input type:', dataUrl?.substring(0, 50));

    if (dataUrl && !dataUrl.startsWith('data:') && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        console.log('[IIG] Downloading image from URL...');
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();

            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    resolve(reader.result);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });

            dataUrl = base64;
            console.log('[IIG] Converted URL to data URL via FileReader');
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

    console.log(`[IIG] Saving image: format=${format}, base64 length=${base64Data.length}`);

    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;

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
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();

        console.log('[IIG] Getting character avatar, characterId:', context.characterId);

        if (context.characterId === undefined || context.characterId === null) {
            console.log('[IIG] No character selected');
            return null;
        }

        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            console.log('[IIG] getCharacterAvatar returned:', avatarUrl);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }

        const character = context.characters?.[context.characterId];
        console.log('[IIG] Character from array:', character?.name, 'avatar:', character?.avatar);
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            console.log('[IIG] Found character avatar:', avatarUrl);
            return await imageUrlToBase64(avatarUrl);
        }

        console.log('[IIG] Could not get character avatar');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();

        if (!settings.userAvatarFile) {
            console.log('[IIG] No user avatar selected in settings');
            return null;
        }

        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        console.log('[IIG] Using selected user avatar:', avatarUrl);
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

async function getLastGeneratedImageBase64(currentMessageId = null) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat || [];

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];

            if (currentMessageId !== null && i === currentMessageId) {
                continue;
            }

            const mes = message.mes || '';

            const imgMatch = mes.match(/src=["']?(\/user\/images\/[^"'\s>]+)/i);
            if (imgMatch) {
                const imagePath = imgMatch[1];
                console.log('[IIG] Found previous generated image:', imagePath);

                const rawBase64 = await imageUrlToBase64(imagePath);
                if (!rawBase64) return null;

                console.log(`[IIG] Original previous image size: ${Math.round(rawBase64.length / 1024)}KB, compressing...`);
                const compressed = await compressImageForReference(rawBase64, 1024, 0.8);
                return compressed;
            }
        }

        console.log('[IIG] No previous generated images found in chat');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting last generated image:', error);
        return null;
    }
}

async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;

    const fullPrompt = style ? `[Style: ${style}] ${prompt}` : prompt;

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9' || options.aspectRatio === '3:2') size = '1536x1024';
        else if (options.aspectRatio === '9:16' || options.aspectRatio === '2:3') size = '1024x1536';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
        else size = 'auto';
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1
    };

    if (size && size !== 'auto') {
        body.size = size;
    }

    body.response_format = 'b64_json';

    if (referenceImages.length > 0) {
        iigLog('WARN', `${referenceImages.length} reference image(s) collected but NOT sent - /v1/images/generations is text-to-image only. Labels: [${referenceImages.map(r => r.label || 'unknown').join(', ')}]. Consider switching to Gemini/nano-banana API type for reference support.`);
    }

    console.log('[IIG] OpenAI Request:', {
        url: url,
        model: body.model,
        size: body.size || 'not set',
        quality: body.quality || 'not set',
        response_format: body.response_format || 'not set',
        promptLength: fullPrompt.length,
        bodyKeys: Object.keys(body)
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();

    console.log('[IIG] OpenAI API response structure:', Object.keys(result));

    const dataList = result.data || result.images || [];

    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.image) {
            if (result.image.startsWith('data:')) return result.image;
            return `data:image/png;base64,${result.image}`;
        }
        if (result.b64_json) {
            return `data:image/png;base64,${result.b64_json}`;
        }
        console.error('[IIG] Full response:', JSON.stringify(result).substring(0, 500));
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    console.log('[IIG] Image object keys:', Object.keys(imageObj));

    const b64Data = imageObj.b64_json || imageObj.b64 || imageObj.base64 || imageObj.image;
    const urlData = imageObj.url || imageObj.uri;

    if (b64Data) {
        if (b64Data.startsWith('data:')) {
            return b64Data;
        }
        let mimeType = 'image/png';
        if (b64Data.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (b64Data.startsWith('R0lGOD')) mimeType = 'image/gif';
        else if (b64Data.startsWith('UklGR')) mimeType = 'image/webp';

        console.log(`[IIG] Image mime type detected: ${mimeType}, data length: ${b64Data.length}`);
        return `data:${mimeType};base64,${b64Data}`;
    }

    if (urlData) {
        console.log('[IIG] Got URL instead of base64:', urlData.substring(0, 100));
        return urlData;
    }

    console.error('[IIG] Unexpected image object structure:', JSON.stringify(imageObj).substring(0, 300));
    throw new Error('Unexpected image response format');
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

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

async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const isGoogleApi = baseUrl.includes('googleapis.com');

    const url = isGoogleApi
        ? `${baseUrl}/v1beta/models/${model}:generateContent?key=${settings.apiKey}`
        : `${baseUrl}/v1beta/models/${model}:generateContent`;

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }

    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }

    iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);

    const characterRefs = referenceImages.filter(r => !r.label.startsWith('style:'));
    const styleRefs = referenceImages.filter(r => r.label.startsWith('style:'));

    const parts = [];

    if (characterRefs.length > 0 || styleRefs.length > 0) {
        let preInstruction = `[IMPORTANT: REFERENCE IMAGES FOLLOW]
You will receive reference images. Your task is to PRECISELY COPY the appearance of characters shown.

`;
        if (characterRefs.length > 0) {
            preInstruction += `CHARACTER REFERENCES (${characterRefs.length} images):
These images show EXACT appearances you MUST replicate. Do NOT improvise or "improve" their looks.
`;
            characterRefs.forEach((ref, i) => {
                preInstruction += `  - Reference Image ${i + 1}: "${ref.label}"\n`;
            });
            preInstruction += `\n`;
        }

        if (styleRefs.length > 0) {
            preInstruction += `STYLE REFERENCES (${styleRefs.length} images):
These define the art style to use. Copy the technique, NOT the content.
`;
        }

        parts.push({ text: preInstruction });
    }

    for (let idx = 0; idx < Math.min(characterRefs.length, 4); idx++) {
        const ref = characterRefs[idx];

        parts.push({
            inlineData: {
                mimeType: ref.mimeType,
                data: ref.data
            }
        });

        parts.push({
            text: `[REFERENCE IMAGE ${idx + 1}: "${ref.label}"]
^^^ THIS IS THE EXACT APPEARANCE OF "${ref.label}" ^^^
MANDATORY: When drawing "${ref.label}", you MUST use:
• THIS EXACT face shape, eye shape, eye color, nose, mouth, jawline
• THIS EXACT hair color, hair length, hair style, hair texture
• THIS EXACT skin tone and complexion
• THIS EXACT body type and proportions
DO NOT CHANGE ANYTHING. DO NOT "IMPROVE" OR "STYLIZE" THE FACE.
COPY THE FACE EXACTLY AS SHOWN IN THIS REFERENCE.
`
        });
    }

    for (const ref of styleRefs.slice(0, 2)) {
        parts.push({
            inlineData: {
                mimeType: ref.mimeType,
                data: ref.data
            }
        });

        const styleName = ref.label.replace('style:', '');
        parts.push({
            text: `[STYLE REFERENCE: "${styleName}"]
^^^ COPY THE ART STYLE FROM THIS IMAGE ^^^
Replicate: art technique, color palette, linework, shading, lighting approach.
The CONTENT of this image is irrelevant. Only copy HOW it is drawn.
`
        });
    }

    let fullPrompt = '';

    if (characterRefs.length > 0) {
        fullPrompt += `[CHARACTER APPEARANCE MAPPING]
When the following names appear in the scene description, draw them EXACTLY as shown in their reference images:
`;
        characterRefs.forEach((ref, i) => {
            fullPrompt += `• "${ref.label}" = Reference Image ${i + 1} (COPY EXACTLY)\n`;
        });
        fullPrompt += `
CRITICAL RULES:
1. Face features must be IDENTICAL to references (not "similar" - IDENTICAL)
2. Hair must match references exactly (color, length, style)
3. Skin tone must match references exactly
4. Do NOT add beauty filters or idealize features
5. If reference shows freckles, scars, or other features - INCLUDE THEM

[END CHARACTER MAPPING]

`;
    }

    if (styleRefs.length > 0) {
        fullPrompt += `[STYLE INSTRUCTION]
Apply the visual style from the style reference(s) to this scene.
[END STYLE INSTRUCTION]

`;
    }

    if (style) {
        fullPrompt += `[Requested Style: ${style}]\n\n`;
    }

    fullPrompt += `[SCENE TO GENERATE]
${prompt}
[END SCENE]`;

    if (characterRefs.length > 0) {
        fullPrompt += `

[FINAL REMINDER]
The characters in this scene MUST look EXACTLY like their reference images.
Check each character's face against their reference before finalizing.`;
    }

    parts.push({ text: fullPrompt });

    iigLog('INFO', `Gemini request: ${characterRefs.length} char ref(s), ${styleRefs.length} style ref(s), prompt ${fullPrompt.length} chars`);
    iigLog('INFO', `Parts breakdown: ${parts.map(p => p.text ? `text(${p.text.substring(0, 50)}...)` : `img(${p.inlineData?.mimeType})`).join(' | ')}`);

    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: imageSize
            }
        }
    };

    iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}, totalParts=${parts.length}`);

    const headers = { 'Content-Type': 'application/json' };
    if (!isGoogleApi) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();

    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }

    const responseParts = candidates[0].content?.parts || [];

    for (const part of responseParts) {
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }

    throw new Error('No image found in Gemini response');
}

function validateSettings() {
    const settings = getSettings();
    const errors = [];

    if (!settings.endpoint) {
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (!settings.model) {
        errors.push('Модель не выбрана');
    }

    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}

function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();

    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    const referenceImages = [];

    if (settings.sendCharAvatar) {
        iigLog('INFO', 'Fetching character avatar for reference...');
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const compressed = await compressImageForReference(charAvatar, 768, 0.85);
            const charName = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.name || 'Character';
            referenceImages.push({
                data: compressed,
                label: charName,
                mimeType: detectMimeType(compressed)
            });
            iigLog('INFO', `Character avatar added: "${charName}", ${Math.round(compressed.length / 1024)}KB`);
        }
    }

    if (settings.sendUserAvatar) {
        iigLog('INFO', 'Fetching user avatar for reference...');
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const compressed = await compressImageForReference(userAvatar, 768, 0.85);
            let userName = settings.userCharacterName?.trim();
            if (!userName) {
                userName = settings.userAvatarFile?.replace(/\.[^.]+$/, '') || 'User';
            }
            referenceImages.push({
                data: compressed,
                label: userName,
                mimeType: detectMimeType(compressed)
            });
            iigLog('INFO', `User avatar added: "${userName}", ${Math.round(compressed.length / 1024)}KB`);
        }
    }

    if (settings.sendPreviousImage) {
        iigLog('INFO', 'Fetching previous generated image for reference...');
        const prevImage = await getLastGeneratedImageBase64();
        if (prevImage) {
            referenceImages.push({
                data: prevImage,
                label: 'previous_scene',
                mimeType: detectMimeType(prevImage)
            });
            iigLog('INFO', `Previous image added, ${Math.round(prevImage.length / 1024)}KB`);
        }
    }

    if (settings.npcReferences && settings.npcReferences.length > 0) {
        for (const npc of settings.npcReferences) {
            if (!npc.enabled || !npc.imageData) continue;

            if (nameAppearsInPrompt(npc.name, prompt)) {
                referenceImages.push({
                    data: npc.imageData,
                    label: npc.name,
                    mimeType: detectMimeType(npc.imageData)
                });
                iigLog('INFO', `NPC "${npc.name}" found in prompt, adding reference (${Math.round(npc.imageData.length / 1024)}KB)`);
            }
        }
    }

    if (settings.sendStyleReference && settings.styleReferenceImages?.length > 0) {
        for (const styleRef of settings.styleReferenceImages) {
            if (styleRef.imageData) {
                referenceImages.push({
                    data: styleRef.imageData,
                    label: `style:${styleRef.name}`,
                    mimeType: detectMimeType(styleRef.imageData)
                });
                iigLog('INFO', `Style reference "${styleRef.name}" added`);
            }
        }
    }

    iigLog('INFO', `Total reference images: ${referenceImages.length}, labels: [${referenceImages.map(r => r.label).join(', ')}]`);

    let finalStyle = style || '';
    if (settings.defaultStyle) {
        finalStyle = settings.defaultStyle + (finalStyle ? ', ' + finalStyle : '');
        console.log(`[IIG] Using default style: ${settings.defaultStyle}`);
    }

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);

            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, finalStyle, referenceImages, options);
            } else {
                return await generateImageOpenAI(prompt, finalStyle, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);

            const isRetryable = error.message?.includes('429') ||
                error.message?.includes('503') ||
                error.message?.includes('502') ||
                error.message?.includes('504') ||
                error.message?.includes('timeout') ||
                error.message?.includes('network');

            if (!isRetryable || attempt === maxRetries) {
                break;
            }

            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    throw lastError;
}

async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // --- New format: <img data-iig-instruction='...' ...> ---
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;

    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;

        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }

        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }

        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }

        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);

        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (click to retry): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }

        if (forceAll) {
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }

        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }

        try {
            let normalizedJson = instructionJson
                .replace(/\u201c/g, '"')
                .replace(/\u2018/g, "'")
                .replace(/\u2019/g, "'")
                .replace(/\u201d/g, '"')
                .replace(/&amp;/g, '&');

            const data = JSON.parse(normalizedJson);

            tags.push({
                fullMatch: fullImgTag,
                index: imgStart,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null
            });

            iigLog('INFO', `Found NEW format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }

        searchPos = imgEnd;
    }

    // --- Legacy format: [IMG:GEN:{...}] ---
    const marker = '[IMG:GEN:';
    let searchStart = 0;

    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;

        const jsonStart = markerIndex + marker.length;

        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;

        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }

        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }

        const jsonStr = text.substring(jsonStart, jsonEnd);

        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }

        const tagOnly = text.substring(markerIndex, jsonEnd + 1);

        try {
            const normalizedJson = jsonStr.replace(/'/g, '"');
            const data = JSON.parse(normalizedJson);

            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });

            iigLog('INFO', `Found LEGACY format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }

        searchStart = jsonEnd + 1;
    }

    return tags;
}

function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Генерация картинки...</div>
    `;
    return placeholder;
}

const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;

    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }

    return img;
}

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.enabled) return;

    // FIX: Check both active processing AND already completed processing
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }

    if (processedMessages.has(messageId)) {
        iigLog('INFO', `Message ${messageId} was already processed, skipping`);
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        // FIX: Mark as processed even if no tags found, to prevent re-entry
        // after DOM changes triggered by other code
        processedMessages.add(messageId);
        return;
    }

    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
        processingMessages.delete(messageId);
        return;
    }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;

        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);

        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            iigLog('INFO', `Searching for img element. Found ${allImgs.length} img[data-iig-instruction] elements in DOM`);

            const searchPrompt = tag.prompt.substring(0, 30);
            iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);

            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);

                if (instruction) {
                    const decodedInstruction = instruction
                        .replace(/\u201c/g, '"')
                        .replace(/\u2018/g, "'")
                        .replace(/\u2019/g, "'")
                        .replace(/\u201d/g, '"')
                        .replace(/&amp;/g, '&');

                    const normalizedSearchPrompt = searchPrompt
                        .replace(/\u201c/g, '"')
                        .replace(/\u2018/g, "'")
                        .replace(/\u2019/g, "'")
                        .replace(/\u201d/g, '"')
                        .replace(/&amp;/g, '&');

                    if (decodedInstruction.includes(normalizedSearchPrompt)) {
                        iigLog('INFO', `Found img element via decoded instruction match`);
                        targetElement = img;
                        break;
                    }

                    try {
                        const normalizedJson = decodedInstruction.replace(/'/g, '"');
                        const instructionData = JSON.parse(normalizedJson);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // JSON parse failed, try next method
                    }

                    if (instruction.includes(searchPrompt)) {
                        iigLog('INFO', `Found img element via raw instruction match`);
                        targetElement = img;
                        break;
                    }
                }
            }

            if (!targetElement) {
                iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                        targetElement = img;
                        break;
                    }
                }
            }

            if (!targetElement) {
                iigLog('INFO', `Trying broader img search...`);
                const allImgsInMes = mesTextEl.querySelectorAll('img');
                for (const img of allImgsInMes) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
        } else {
            const tagEscaped = tag.fullMatch
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\u201c/g, '(?:\u201c|")');
            const tagRegex = new RegExp(tagEscaped, 'g');

            const beforeReplace = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                tagRegex,
                `<span data-iig-placeholder="${tagId}"></span>`
            );

            if (beforeReplace !== mesTextEl.innerHTML) {
                targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
                iigLog('INFO', `Legacy tag replaced with placeholder span`);
            }

            if (!targetElement) {
                const allImgs = mesTextEl.querySelectorAll('img');
                for (const img of allImgs) {
                    if (img.src && img.src.includes('[IMG:GEN:')) {
                        targetElement = img;
                        iigLog('INFO', `Found img with legacy tag in src`);
                        break;
                    }
                }
            }
        }

        if (targetElement) {
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
            iigLog('INFO', `Loading placeholder shown (replaced target element)`);
        } else {
            iigLog('WARN', `Could not find target element, appending placeholder as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }

        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
            );

            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);

            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;

            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) {
                    img.setAttribute('data-iig-instruction', instructionMatch[2]);
                }
            }

            loadingPlaceholder.replaceWith(img);

            if (tag.isNewFormat) {
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                const completionMarker = `[IMG:\u2713:${imagePath}]`;
                message.mes = message.mes.replace(tag.fullMatch, completionMarker);
            }

            iigLog('INFO', `Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);

            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);

            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };

    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } catch (err) {
        iigLog('ERROR', `Unexpected error processing tags for message ${messageId}:`, err.message);
    }

    // FIX: Mark as processed BEFORE saveChat to prevent re-entry from any
    // DOM events triggered by saving
    processedMessages.add(messageId);

    // FIX: Only delete from processingMessages AFTER all side-effects are done
    await context.saveChat();
    processingMessages.delete(messageId);

    // FIX: REMOVED the call to context.messageFormatting() + mesTextEl.innerHTML assignment.
    // That was the ROOT CAUSE of the infinite recursion:
    // messageFormatting -> innerHTML change -> CHARACTER_MESSAGE_RENDERED event
    // -> onMessageReceived -> processMessageTags -> messageFormatting -> ...
    // The DOM is already correctly updated by replaceWith() calls above.

    iigLog('INFO', `Finished processing message ${messageId}`);
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    if (!message) {
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }

    const tags = await parseImageTags(message.mes, { forceAll: true });

    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }

    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');

    // FIX: Remove from processedMessages so it can be marked again after regen
    processedMessages.delete(messageId);
    processingMessages.add(messageId);

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;

        try {
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');

                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);

                const statusEl = loadingPlaceholder.querySelector('.iig-status');

                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );

                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);

                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                loadingPlaceholder.replaceWith(img);

                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);

                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }

    processedMessages.add(messageId);
    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;

    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });

    extraMesButtons.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;

    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;

    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;

        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];

        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }

    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);

    const settings = getSettings();
    if (!settings.enabled) {
        iigLog('INFO', 'Extension disabled, skipping');
        return;
    }

    const context = SillyTavern.getContext();
    const message = context.chat[messageId];

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;

    addRegenerateButton(messageElement, messageId);

    await processMessageTags(messageId);
}

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
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.marginBottom = '6px';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = npc.enabled !== false;
        checkbox.addEventListener('change', (e) => {
            settings.npcReferences[i].enabled = e.target.checked;
            saveSettings();
        });

        const nameSpan = document.createElement('span');
        nameSpan.textContent = npc.name;
        nameSpan.style.flex = '1';
        nameSpan.style.color = '#e8e0e0';
        nameSpan.style.fontSize = '12px';

        const preview = document.createElement('div');
        preview.style.width = '32px';
        preview.style.height = '32px';
        preview.style.borderRadius = '6px';
        preview.style.overflow = 'hidden';
        preview.style.flexShrink = '0';
        if (npc.imageData) {
            const img = document.createElement('img');
            img.src = `data:image/jpeg;base64,${npc.imageData}`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            preview.appendChild(img);
        } else {
            preview.style.background = '#2a2a2a';
            preview.style.display = 'flex';
            preview.style.alignItems = 'center';
            preview.style.justifyContent = 'center';
            preview.innerHTML = '<i class="fa-solid fa-user" style="color:#5a5252;font-size:14px;"></i>';
        }

        const uploadBtn = document.createElement('div');
        uploadBtn.className = 'menu_button';
        uploadBtn.title = 'Загрузить картинку';
        uploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i>';
        uploadBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = async (ev) => {
                    const base64Full = ev.target.result;
                    const rawBase64 = base64Full.split(',')[1];
                    try {
                        const compressed = await compressImageForReference(rawBase64, 768, 0.85);
                        settings.npcReferences[i].imageData = compressed;
                        saveSettings();
                        renderNpcList();
                        toastr.success(`Картинка для ${npc.name} загружена`, 'NPC');
                    } catch (err) {
                        toastr.error('Ошибка сжатия картинки', 'NPC');
                    }
                };
                reader.readAsDataURL(file);
            });
            fileInput.click();
        });

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button';
        deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info(`NPC "${npc.name}" удалён`, 'NPC');
        });

        row.appendChild(checkbox);
        row.appendChild(preview);
        row.appendChild(nameSpan);
        row.appendChild(uploadBtn);
        row.appendChild(deleteBtn);
        container.appendChild(row);
    }
}

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
        const styleRef = settings.styleReferenceImages[i];
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.marginBottom = '6px';

        const preview = document.createElement('div');
        preview.style.width = '48px';
        preview.style.height = '48px';
        preview.style.borderRadius = '6px';
        preview.style.overflow = 'hidden';
        preview.style.flexShrink = '0';
        preview.style.border = '1px solid rgba(255,182,193,0.15)';
        if (styleRef.imageData) {
            const img = document.createElement('img');
            img.src = `data:image/jpeg;base64,${styleRef.imageData}`;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            preview.appendChild(img);
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = styleRef.name || `Стиль ${i + 1}`;
        nameSpan.style.flex = '1';
        nameSpan.style.color = '#e8e0e0';
        nameSpan.style.fontSize = '11px';

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button';
        deleteBtn.title = 'Удалить стилевой референс';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            settings.styleReferenceImages.splice(i, 1);
            saveSettings();
            renderStyleRefList();
            toastr.info('Стилевой референс удалён', 'Генерация картинок');
        });

        row.appendChild(preview);
        row.appendChild(nameSpan);
        row.appendChild(deleteBtn);
        container.appendChild(row);
    }
}

function updateCharAvatarPreview() {
    const context = SillyTavern.getContext();
    const preview = document.getElementById('iig-char-avatar-preview');
    if (!preview) return;
    const character = context.characters?.[context.characterId];
    if (character?.avatar) {
        const img = preview.querySelector('img');
        if (img) {
            img.src = `/characters/${encodeURIComponent(character.avatar)}`;
        }
        preview.style.display = '';
    } else {
        preview.style.display = 'none';
    }
}

function renderAvatarDropdown(avatars = []) {
    const settings = getSettings();
    const list = document.getElementById('iig_avatar_dropdown_list');
    if (!list) return;

    list.innerHTML = '';

    const emptyItem = document.createElement('div');
    emptyItem.className = `iig-avatar-dropdown-item iig-no-avatar ${!settings.userAvatarFile ? 'selected' : ''}`;
    emptyItem.dataset.value = '';
    emptyItem.innerHTML = `
        <div style="width:36px;height:36px;border-radius:5px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="fa-solid fa-ban" style="color:#5a5252;font-size:12px;"></i>
        </div>
        <span class="iig-item-name">-- Не выбран --</span>
    `;
    emptyItem.addEventListener('click', () => selectAvatar('', null));
    list.appendChild(emptyItem);

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = `iig-avatar-dropdown-item ${settings.userAvatarFile === avatarFile ? 'selected' : ''}`;
        item.dataset.value = avatarFile;

        const thumb = document.createElement('img');
        thumb.className = 'iig-item-thumb';
        thumb.src = `/User Avatars/${encodeURIComponent(avatarFile)}`;
        thumb.alt = avatarFile;
        thumb.loading = 'lazy';
        thumb.onerror = function () {
            this.style.display = 'none';
        };

        const name = document.createElement('span');
        name.className = 'iig-item-name';
        name.textContent = avatarFile;

        item.appendChild(thumb);
        item.appendChild(name);

        item.addEventListener('click', () => selectAvatar(avatarFile, thumb.src));
        list.appendChild(item);
    }
}

async function loadAndRenderAvatars() {
    try {
        const avatars = await fetchUserAvatars();
        renderAvatarDropdown(avatars);
        iigLog('INFO', `Loaded ${avatars.length} user avatars for dropdown`);
    } catch (error) {
        iigLog('ERROR', 'Failed to load avatars for dropdown:', error.message);
        toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
    }
}

function selectAvatar(avatarFile, thumbSrc) {
    const settings = getSettings();
    settings.userAvatarFile = avatarFile;
    saveSettings();

    const selected = document.getElementById('iig_avatar_dropdown_selected');
    if (selected) {
        if (avatarFile) {
            selected.innerHTML = `
                <img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="" onerror="this.style.display='none'">
                <span class="iig-dropdown-text">${avatarFile}</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        } else {
            selected.innerHTML = `
                <div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                <span class="iig-dropdown-text">-- Не выбран --</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
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

    iigLog('INFO', `User avatar selected: "${avatarFile}"`);
}

function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();

    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <hr>

                    <h4>Пресеты API</h4>
                    <p class="hint">Сохраняйте комбинации эндпоинт + ключ + модель для быстрого переключения между прокси.</p>

                    <div id="iig_preset_list"></div>

                    <div class="flex-row" style="margin-top: 8px;">
                        <input type="text" id="iig_preset_new_name" class="text_pole flex1" placeholder="Название пресета (напр. OpenRouter, Gemini...)">
                        <div id="iig_preset_save" class="menu_button" title="Сохранить текущие настройки как пресет">
                            <i class="fa-solid fa-floppy-disk"></i> Сохранить
                        </div>
                    </div>

                    <hr>

                    <h4>Настройки API</h4>

                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                        </select>
                    </div>

                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1"
                               value="${settings.endpoint}"
                               placeholder="https://api.example.com">
                    </div>

                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1"
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>

                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>

                    <hr>

                    <h4>Параметры генерации</h4>

                    <div class="flex-row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>

                    <div class="flex-row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>

                    <hr>

                    <h4>Стиль и референсы</h4>

                    <div class="flex-row">
                        <label for="iig_default_style">Стиль по умолчанию</label>
                        <textarea id="iig_default_style" class="text_pole flex1" rows="2"
                                  placeholder="semi_realistic, manhwa style, soft lighting, detailed...">${settings.defaultStyle || ''}</textarea>
                    </div>
                    <p class="hint">Добавляется к каждому промпту. Сохраняет одежду, локацию, арт-стиль.</p>

                    <h5>Референсы аватаров</h5>
                    <p class="hint">Отправлять аватарки для консистентности персонажей.</p>

                    <div class="flex-row" style="align-items:center; gap:8px;">
                        <label class="checkbox_label" style="flex:1; margin:0;">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар персонажа</span>
                        </label>
                        <div id="iig-char-avatar-preview" class="iig-avatar-preview" style="display:none;">
                            <img src="" alt="char" />
                        </div>
                    </div>

                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                        <span>Отправлять аватар юзера</span>
                    </label>

                    <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px; align-items: center;">
    <label>Файл аватара</label>
    <div id="iig_avatar_dropdown" class="iig-avatar-dropdown">
        <div id="iig_avatar_dropdown_selected" class="iig-avatar-dropdown-selected">
            ${settings.userAvatarFile
            ? `<img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(settings.userAvatarFile)}" alt="" onerror="this.style.display='none'">`
            : '<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>'}
            <span class="iig-dropdown-text">${settings.userAvatarFile || '-- Не выбран --'}</span>
            <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
        </div>
        <div id="iig_avatar_dropdown_list" class="iig-avatar-dropdown-list"></div>
    </div>
    <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить список">
        <i class="fa-solid fa-sync"></i>
    </div>
</div>

                    <div id="iig_user_name_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px;">
                        <label for="iig_user_char_name">Имя в промптах</label>
                        <input type="text" id="iig_user_char_name" class="text_pole flex1"
                               value="${settings.userCharacterName || ''}"
                               placeholder="Юзер, MC, User...">
                    </div>
                    <p id="iig_user_name_hint" class="hint ${!settings.sendUserAvatar ? 'hidden' : ''}">Имя вашего персонажа как оно появляется в промптах генерации (для правильного сопоставления референса).</p>

                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_previous_image" ${settings.sendPreviousImage ? 'checked' : ''}>
                        <span>Отправлять предыдущую картинку</span>
                    </label>
                    <p class="hint">Последняя сгенерированная картинка из чата для сохранения одежды, локации и т.д.</p>

                    <hr>

                    <h5>NPC-референсы</h5>
                    <p class="hint">Добавьте NPC с именами и картинками. Референс отправляется автоматически, если имя NPC встречается в промпте генерации.</p>

                    <div id="iig_npc_list"></div>

                    <div class="flex-row" style="margin-top: 8px;">
                        <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC (напр. Luca)">
                        <div id="iig_npc_add" class="menu_button" title="Добавить NPC">
                            <i class="fa-solid fa-plus"></i> Добавить
                        </div>
                    </div>

                    <hr>

                    <h5>Референс стиля</h5>
                    <p class="hint">Загрузите картинку-пример стиля. Нанобанана будет копировать визуальный стиль с неё.</p>

                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_send_style_ref" ${settings.sendStyleReference ? 'checked' : ''}>
                        <span>Отправлять стилевой референс</span>
                    </label>

                    <div id="iig_style_ref_container" class="${!settings.sendStyleReference ? 'hidden' : ''}">
                        <div id="iig_style_ref_list"></div>
                        <div id="iig_style_ref_upload" class="menu_button" style="width:100%;margin-top:5px;">
                            <i class="fa-solid fa-palette"></i> Загрузить картинку стиля
                        </div>
                    </div>

                    <hr>

                    <div id="iig_gemini_section" class="iig-gemini-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>

                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                            </select>
                        </div>

                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>

                        <hr>
                    </div>

                    <h4>Обработка ошибок</h4>

                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1"
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>

                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1"
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>

                    <hr>

                    <h4>Отладка</h4>

                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                    <p class="hint">Экспортировать логи расширения для отладки проблем.</p>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    bindSettingsEvents();
    updateCharAvatarPreview();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();

        const geminiSection = document.getElementById('iig_gemini_section');
        if (geminiSection) {
            geminiSection.classList.toggle('hidden', e.target.value !== 'gemini');
        }
    });

    document.getElementById('iig_default_style')?.addEventListener('input', (e) => {
        settings.defaultStyle = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();

        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_gemini_section')?.classList.remove('hidden');
        }
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');

        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');

            const currentModel = settings.model;

            select.innerHTML = '<option value="">-- Выберите модель --</option>';

            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }

            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();

        const avatarRow = document.getElementById('iig_user_avatar_row');
        const nameRow = document.getElementById('iig_user_name_row');
        const nameHint = document.getElementById('iig_user_name_hint');
        if (avatarRow) {
            avatarRow.classList.toggle('hidden', !e.target.checked);
        }
        if (nameRow) {
            nameRow.classList.toggle('hidden', !e.target.checked);
        }
        if (nameHint) {
            nameHint.classList.toggle('hidden', !e.target.checked);
        }
    });

    document.getElementById('iig_user_char_name')?.addEventListener('input', (e) => {
        settings.userCharacterName = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_send_previous_image')?.addEventListener('change', (e) => {
        settings.sendPreviousImage = e.target.checked;
        saveSettings();
    });

    document.getElementById('iig_avatar_dropdown_selected')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) {
            const wasOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open');

            const list = document.getElementById('iig_avatar_dropdown_list');
            if (!wasOpen && list && list.children.length === 0) {
                loadAndRenderAvatars();
            }
        }
    });

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown && !dropdown.contains(e.target)) {
            dropdown.classList.remove('open');
        }
    });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.classList.add('loading');
        await loadAndRenderAvatars();
        btn.classList.remove('loading');
        toastr.success('Аватары обновлены', 'Генерация картинок');

        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) dropdown.classList.add('open');
    });

    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();

        if (!name) {
                        toastr.warning('Введите имя NPC', 'NPC');
            return;
        }

        const settings = getSettings();
        if (!settings.npcReferences) {
            settings.npcReferences = [];
        }

        if (settings.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`NPC "${name}" уже существует`, 'NPC');
            return;
        }

        settings.npcReferences.push({
            name: name,
            imageData: null,
            enabled: true
        });

        saveSettings();
        nameInput.value = '';
        renderNpcList();
        toastr.success(`NPC "${name}" добавлен. Загрузите картинку!`, 'NPC');
    });

    document.getElementById('iig_send_style_ref')?.addEventListener('change', (e) => {
        settings.sendStyleReference = e.target.checked;
        saveSettings();

        const styleContainer = document.getElementById('iig_style_ref_container');
        if (styleContainer) {
            styleContainer.classList.toggle('hidden', !e.target.checked);
        }
    });

    document.getElementById('iig_style_ref_upload')?.addEventListener('click', () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (ev) => {
                const base64Full = ev.target.result;
                const rawBase64 = base64Full.split(',')[1];
                try {
                    const compressed = await compressImageForReference(rawBase64, 768, 0.75);

                    if (!settings.styleReferenceImages) {
                        settings.styleReferenceImages = [];
                    }

                    const styleName = file.name.replace(/\.[^.]+$/, '') || `style_${Date.now()}`;

                    settings.styleReferenceImages.push({
                        name: styleName,
                        imageData: compressed
                    });

                    saveSettings();
                    renderStyleRefList();
                    toastr.success(`Стиль "${styleName}" загружен`, 'Генерация картинок');
                } catch (err) {
                    console.error('[IIG] Style ref compression error:', err);
                    toastr.error('Ошибка сжатия картинки', 'Генерация картинок');
                }
            };
            reader.readAsDataURL(file);
        });
        fileInput.click();
    });

    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 0;
        saveSettings();
    });

    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });

    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });
    document.getElementById('iig_preset_save')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_preset_new_name');
        const name = nameInput?.value?.trim();

        if (saveCurrentAsPreset(name)) {
            nameInput.value = '';
        }
    });

    // Enter по полю ввода тоже сохраняет
    document.getElementById('iig_preset_new_name')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('iig_preset_save')?.click();
        }
    });

    renderPresetList();
    renderNpcList();
    renderStyleRefList();
}

(function init() {
    const context = SillyTavern.getContext();

    console.log('[IIG] Available event_types:', context.event_types);
    console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', context.event_types.CHARACTER_MESSAGE_RENDERED);
    console.log('[IIG] MESSAGE_SWIPED:', context.event_types.MESSAGE_SWIPED);

    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event - clearing processed cache and adding buttons');
        // FIX: Clear processedMessages when chat changes so images in new chat can be processed
        processedMessages.clear();
        processingMessages.clear();
        setTimeout(() => {
            addButtonsToExistingMessages();
        }, 100);
        setTimeout(updateCharAvatarPreview, 200);
    });

    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);

    console.log('[IIG] Inline Image Generation extension initialized');
})();
