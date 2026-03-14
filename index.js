/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 *
 * v2.0: NPC system, auto-detection of character names, avatar-based visual references
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

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
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    // Custom prompts
    positivePrompt: '',
    negativePrompt: '',
    // Fixed style
    fixedStyle: '',
    fixedStyleEnabled: false,
    // Appearance extraction
    extractAppearance: true,
    extractUserAppearance: true,
    // Clothing detection
    detectClothing: true,
    clothingSearchDepth: 5,
    // NEW: NPC system
    npcList: [], // Array of { id, name, aliases, avatarData, appearance }
    // NEW: Auto-detect names in prompt and attach avatars
    autoDetectNames: true,
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
    const settings = context.extensionSettings[MODULE_NAME];
    iigLog('INFO', `Settings saved.`);
}

// ============================================================
// MODEL & AVATAR FETCHING
// ============================================================

async function fetchModels() {
    const settings = getSettings();
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${settings.apiKey}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => isImageModel(m.id)).map(m => m.id);
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
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');
    const format = match[1];
    const base64Data = match[2];
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    const result = await response.json();
    return result.path;
}

// ============================================================
// AVATAR RETRIEVAL (Character, User, NPC)
// ============================================================

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
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            return await imageUrlToBase64(avatarUrl);
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
        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

/**
 * Get NPC avatar as base64 (already stored in settings)
 */
function getNpcAvatarBase64(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    return npc?.avatarData || null;
}

// ============================================================
// RESIZE IMAGE (for NPC avatar storage - keep settings small)
// ============================================================

/**
 * Resize an image to max dimension while keeping aspect ratio
 * @param {string} base64 - Pure base64 string (no data URL prefix)
 * @param {number} maxSize - Max width/height in pixels
 * @returns {Promise<string>} - Resized base64 string
 */
async function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) {
                resolve(base64);
                return;
            }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const resized = canvas.toDataURL('image/png').split(',')[1];
            resolve(resized);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

// ============================================================
// NAME DETECTION IN PROMPT
// ============================================================

/**
 * Detect which characters are mentioned in the prompt text
 * Returns an object with flags and matched NPC IDs
 * @param {string} prompt - The image generation prompt
 * @returns {{ charMentioned: boolean, userMentioned: boolean, npcIds: string[] }}
 */
function detectMentionedCharacters(prompt) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const lowerPrompt = prompt.toLowerCase();

    const result = {
        charMentioned: false,
        userMentioned: false,
        npcIds: []
    };

    // Check character name
    const charName = context.characters?.[context.characterId]?.name;
    if (charName && lowerPrompt.includes(charName.toLowerCase())) {
        result.charMentioned = true;
    }

    // Check user name
    const userName = context.name1;
    if (userName && lowerPrompt.includes(userName.toLowerCase())) {
        result.userMentioned = true;
    }

    // Check NPC names and aliases
    for (const npc of (settings.npcList || [])) {
        if (!npc.name) continue;

        const names = [npc.name, ...(npc.aliases || [])].filter(Boolean);
        for (const name of names) {
            if (lowerPrompt.includes(name.toLowerCase())) {
                result.npcIds.push(npc.id);
                break; // Don't add same NPC twice
            }
        }
    }

    iigLog('INFO', `Name detection: char=${result.charMentioned}, user=${result.userMentioned}, npcs=[${result.npcIds.join(',')}]`);
    return result;
}

/**
 * Collect reference images based on detected names and settings
 * Returns array of { base64, label } objects
 */
async function collectReferenceImages(prompt) {
    const settings = getSettings();
    const references = []; // { base64, label, name }

    // Detect mentions if auto-detect is enabled
    let mentions = { charMentioned: false, userMentioned: false, npcIds: [] };
    if (settings.autoDetectNames) {
        mentions = detectMentionedCharacters(prompt);
    }

    // Character avatar: send if globally enabled OR if name detected
    if (settings.sendCharAvatar || mentions.charMentioned) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const context = SillyTavern.getContext();
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            references.push({
                base64: charAvatar,
                label: `Reference image of ${charName}`,
                name: charName
            });
            iigLog('INFO', `Added character avatar reference for: ${charName}`);
        }
    }

    // User avatar: send if globally enabled OR if name detected
    if (settings.sendUserAvatar || mentions.userMentioned) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const context = SillyTavern.getContext();
            const userName = context.name1 || 'User';
            references.push({
                base64: userAvatar,
                label: `Reference image of ${userName}`,
                name: userName
            });
            iigLog('INFO', `Added user avatar reference for: ${userName}`);
        }
    }

    // NPC avatars: send if name detected in prompt
    for (const npcId of mentions.npcIds) {
        const npc = settings.npcList.find(n => n.id === npcId);
        if (!npc?.avatarData) continue;

        references.push({
            base64: npc.avatarData,
            label: `Reference image of ${npc.name}`,
            name: npc.name
        });
        iigLog('INFO', `Added NPC avatar reference for: ${npc.name}`);
    }

    iigLog('INFO', `Total reference images collected: ${references.length}`);
    return references;
}

// ============================================================
// APPEARANCE EXTRACTION
// ============================================================

function extractCharacterAppearance() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        const character = context.characters?.[context.characterId];
        if (!character?.description) return null;

        const description = character.description;
        const charName = character.name || 'Character';

        const appearancePatterns = [
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];

        const foundTraits = [];
        const seenTexts = new Set();

        for (const pattern of appearancePatterns) {
            for (const match of description.matchAll(pattern)) {
                const trait = (match[1] || match[0]).trim();
                if (trait.length > 2 && !seenTexts.has(trait.toLowerCase())) {
                    seenTexts.add(trait.toLowerCase());
                    foundTraits.push(trait);
                }
            }
        }

        const appearanceBlockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];

        for (const pattern of appearanceBlockPatterns) {
            for (const match of description.matchAll(pattern)) {
                const block = match[1].trim();
                if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                    seenTexts.add(block.toLowerCase());
                    foundTraits.push(block);
                }
            }
        }

        if (foundTraits.length === 0) return null;
        const text = `${charName}'s appearance: ${foundTraits.join(', ')}`;
        iigLog('INFO', `Extracted char appearance: ${text.substring(0, 200)}`);
        return text;
    } catch (error) {
        iigLog('ERROR', 'Error extracting character appearance:', error);
        return null;
    }
}

function extractUserAppearance() {
    try {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        let personaDescription = null;
        if (typeof window.power_user !== 'undefined' && window.power_user.persona_description) {
            personaDescription = window.power_user.persona_description;
        }
        if (!personaDescription) return null;

        const appearancePatterns = [
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];

        const foundTraits = [];
        const seenTexts = new Set();

        for (const pattern of appearancePatterns) {
            for (const match of personaDescription.matchAll(pattern)) {
                const trait = (match[1] || match[0]).trim();
                if (trait.length > 2 && !seenTexts.has(trait.toLowerCase())) {
                    seenTexts.add(trait.toLowerCase());
                    foundTraits.push(trait);
                }
            }
        }

        const appearanceBlockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];

        for (const pattern of appearanceBlockPatterns) {
            for (const match of personaDescription.matchAll(pattern)) {
                const block = match[1].trim();
                if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                    seenTexts.add(block.toLowerCase());
                    foundTraits.push(block);
                }
            }
        }

        if (foundTraits.length === 0) {
            if (personaDescription.length < 500) {
                return `${userName}'s appearance: ${personaDescription}`;
            }
            return null;
        }

        const text = `${userName}'s appearance: ${foundTraits.join(', ')}`;
        iigLog('INFO', `Extracted user appearance: ${text.substring(0, 200)}`);
        return text;
    } catch (error) {
        iigLog('ERROR', 'Error extracting user appearance:', error);
        return null;
    }
}

/**
 * Get NPC appearance text (stored in settings)
 */
function getNpcAppearance(npcId) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (!npc?.appearance) return null;
    return `${npc.name}'s appearance: ${npc.appearance}`;
}

// ============================================================
// CLOTHING DETECTION
// ============================================================

function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        if (!chat || chat.length === 0) return null;

        const charName = context.characters?.[context.characterId]?.name || 'Character';
        const userName = context.name1 || 'User';

        const clothingPatterns = [
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:shirt|blouse|top|jacket|coat|sweater|hoodie|t-shirt|tank\s*top)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:pants|jeans|shorts|skirt|trousers|leggings)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:dress|gown|robe|uniform|suit|armor|armour)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:a|an|the|his|her|their|my)\s+([\w\s\-]+(?:dress|shirt|jacket|coat|pants|jeans|skirt|blouse|sweater|hoodie|uniform|suit|armor|robe|gown|outfit|costume|clothes))/gi,
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:рубашк|блузк|куртк|пальто|свитер|худи|футболк|майк)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:брюк|джинс|шорт|юбк|штан|леггинс)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:платье|халат|мантия|униформа|доспех)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
        ];

        const foundClothing = [];
        const seenTexts = new Set();
        const startIndex = Math.max(0, chat.length - depth);

        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            const text = message.mes;
            const speaker = message.is_user ? userName : charName;

            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0;
                for (const match of text.matchAll(pattern)) {
                    const clothing = (match[1] || match[0]).trim();
                    if (clothing.length > 3 && !seenTexts.has(clothing.toLowerCase())) {
                        seenTexts.add(clothing.toLowerCase());
                        foundClothing.push({ text: clothing, speaker });
                    }
                }
            }
        }

        if (foundClothing.length === 0) return null;

        const charClothing = foundClothing.filter(c => c.speaker === charName).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName).map(c => c.text);

        let clothingText = '';
        if (charClothing.length > 0) clothingText += `${charName} is wearing: ${charClothing.slice(0, 3).join(', ')}. `;
        if (userClothing.length > 0) clothingText += `${userName} is wearing: ${userClothing.slice(0, 3).join(', ')}.`;

        iigLog('INFO', `Detected clothing: ${clothingText.substring(0, 200)}`);
        return clothingText.trim();
    } catch (error) {
        iigLog('ERROR', 'Error detecting clothing:', error);
        return null;
    }
}

// ============================================================
// ENHANCED PROMPT BUILDER
// ============================================================

/**
 * Build enhanced prompt with all context.
 * Now also includes NPC appearance descriptions for mentioned NPCs.
 */
function buildEnhancedPrompt(basePrompt, style, options = {}) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME] || {};

    const promptParts = [];

    // 1. Fixed style
    if (settings.fixedStyleEnabled === true && settings.fixedStyle && settings.fixedStyle.trim() !== '') {
        promptParts.push(`[STYLE: ${settings.fixedStyle.trim()}]`);
    }

    // 2. Positive prompt
    if (settings.positivePrompt && settings.positivePrompt.trim() !== '') {
        promptParts.push(settings.positivePrompt.trim());
    }

    // 3. Style from tag (if not using fixed style)
    if (style && !(settings.fixedStyleEnabled === true && settings.fixedStyle && settings.fixedStyle.trim() !== '')) {
        promptParts.push(`[Style: ${style}]`);
    }

    // 4. Character appearance (from card description)
    if (settings.extractAppearance === true) {
        const charAppearance = extractCharacterAppearance();
        if (charAppearance) promptParts.push(`[Character Reference: ${charAppearance}]`);
    }

    // 5. User appearance (from persona)
    if (settings.extractUserAppearance !== false) {
        const userAppearance = extractUserAppearance();
        if (userAppearance) promptParts.push(`[User Reference: ${userAppearance}]`);
    }

    // 6. NPC appearances (for mentioned NPCs)
    if (settings.autoDetectNames && settings.npcList?.length > 0) {
        const mentions = detectMentionedCharacters(basePrompt);
        for (const npcId of mentions.npcIds) {
            const npcAppearance = getNpcAppearance(npcId);
            if (npcAppearance) {
                promptParts.push(`[NPC Reference: ${npcAppearance}]`);
            }
        }
    }

    // 7. Detected clothing
    if (settings.detectClothing === true) {
        const clothing = detectClothingFromChat(settings.clothingSearchDepth || 5);
        if (clothing) promptParts.push(`[Current Clothing: ${clothing}]`);
    }

    // 8. Reference image labels (inform the model which images correspond to whom)
    if (options._referenceLabels && options._referenceLabels.length > 0) {
        const labelsText = options._referenceLabels.map((ref, i) =>
            `Reference image ${i + 1}: ${ref.label} (${ref.name})`
        ).join('; ');
        promptParts.push(`[CRITICAL: The reference images provided above show EXACT appearances. ${labelsText}. You MUST precisely copy their face structure, eye color, hair color and style, skin tone, body type, and all distinctive features from these references.]`);
    }

    // 9. Main prompt
    promptParts.push(basePrompt);

    // 10. Negative prompt
    if (settings.negativePrompt && settings.negativePrompt.trim() !== '') {
        promptParts.push(`[AVOID: ${settings.negativePrompt.trim()}]`);
    }

    const fullPrompt = promptParts.join('\n\n');
    iigLog('INFO', `Built enhanced prompt (${fullPrompt.length} chars, ${promptParts.length} parts)`);
    return fullPrompt;
}

// ============================================================
// IMAGE GENERATION APIs
// ============================================================

async function generateImageOpenAI(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;

    const fullPrompt = buildEnhancedPrompt(prompt, style, options);

    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };

    // OpenAI supports single reference image
    if (references.length > 0) {
        body.image = `data:image/png;base64,${references[0].base64}`;
    }

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
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    if (imageObj.b64_json) return `data:image/png;base64,${imageObj.b64_json}`;
    return imageObj.url;
}

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, references = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';

    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    // Build parts: reference images first, then prompt
    const parts = [];

    // Add labeled reference images (up to 4)
    for (const ref of references.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: ref.base64
            }
        });
        // Add text label right after each image so model knows who it is
        parts.push({
            text: `[Above image: ${ref.label}]`
        });
    }

    // Build full prompt with reference labels passed through
    const fullPrompt = buildEnhancedPrompt(prompt, style, {
        ...options,
        _referenceLabels: references
    });

    parts.push({ text: fullPrompt });

    iigLog('INFO', `Gemini request: ${references.length} reference(s) + prompt (${fullPrompt.length} chars)`);

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
    };

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
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }

    throw new Error('No image found in Gemini response');
}

// ============================================================
// GENERATION WITH RETRY
// ============================================================

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!settings.apiKey) errors.push('API ключ не настроен');
    if (!settings.model) errors.push('Модель не выбрана');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;

    // Collect reference images based on prompt content and settings
    onStatusUpdate?.('Сбор референсов...');
    const references = await collectReferenceImages(prompt);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);

            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, references, options);
            } else {
                return await generateImageOpenAI(prompt, style, references, options);
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

            if (!isRetryable || attempt === maxRetries) break;

            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================

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

    // === NEW FORMAT ===
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

        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) {
            const exists = await checkFileExists(srcValue);
            if (!exists) needsGeneration = true;
        } else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
            const data = JSON.parse(normalizedJson);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true, existingSrc: hasPath ? srcValue : null
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        searchPos = imgEnd;
    }

    // === LEGACY FORMAT ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;

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
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }

        const jsonStr = text.substring(jsonStart, jsonEnd);
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }

        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        try {
            const data = JSON.parse(jsonStr.replace(/'/g, '"'));
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: data.style || '', prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag: ${jsonStr.substring(0, 100)}`, e.message);
        }
        searchStart = jsonEnd + 1;
    }

    return tags;
}

// ============================================================
// DOM HELPERS
// ============================================================

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
        if (instructionMatch) img.setAttribute('data-iig-instruction', instructionMatch[2]);
    }
    return img;
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;

    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }

    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);

            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                if (instruction) {
                    const decoded = instruction.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&');
                    if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                    try {
                        const d = JSON.parse(decoded.replace(/'/g, '"'));
                        if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                    } catch (e) {}
                    if (instruction.includes(searchPrompt)) { targetElement = img; break; }
                }
            }

            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        targetElement = img; break;
                    }
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
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(new RegExp(tagEscaped, 'g'), `<span data-iig-placeholder="${tagId}"></span>`);
            if (before !== mesTextEl.innerHTML) targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    if (img.src?.includes('[IMG:GEN:')) { targetElement = img; break; }
                }
            }
        }

        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);

        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        try {
            const dataUrl = await generateImageWithRetry(tag.prompt, tag.style,
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
                const m = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (m) img.setAttribute('data-iig-instruction', m[2]);
            }
            loadingPlaceholder.replaceWith(img);

            if (tag.isNewFormat) {
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:✓:${imagePath}]`);
            }
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            if (tag.isNewFormat) {
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                message.mes = message.mes.replace(tag.fullMatch, `[IMG:ERROR:${error.message.substring(0, 50)}]`);
            }
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };

    try {
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        processingMessages.delete(messageId);
    }

    await context.saveChat();

    if (typeof context.messageFormatting === 'function') {
        mesTextEl.innerHTML = context.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
    }
}

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено', 'Генерация картинок'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации', 'Генерация картинок'); return; }

    processingMessages.add(messageId);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        try {
            const existingImg = mesTextEl.querySelector('img[data-iig-instruction]');
            if (existingImg) {
                const instruction = existingImg.getAttribute('data-iig-instruction');
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                const statusEl = loadingPlaceholder.querySelector('.iig-status');

                const dataUrl = await generateImageWithRetry(tag.prompt, tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);

                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                if (instruction) img.setAttribute('data-iig-instruction', instruction);
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
    let addedCount = 0;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        if (message && !message.is_user) { addRegenerateButton(el, messageId); addedCount++; }
    }
    iigLog('INFO', `Added regenerate buttons to ${addedCount} messages`);
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const context = SillyTavern.getContext();
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    addRegenerateButton(messageElement, messageId);
    await processMessageTags(messageId);
}

// ============================================================
// NPC MANAGEMENT
// ============================================================

function generateNpcId() {
    return 'npc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function addNpc() {
    const settings = getSettings();
    const newNpc = {
        id: generateNpcId(),
        name: '',
        aliases: [],
        avatarData: null, // base64, resized
        appearance: ''
    };
    settings.npcList.push(newNpc);
    saveSettings();
    return newNpc;
}

function removeNpc(npcId) {
    const settings = getSettings();
    settings.npcList = settings.npcList.filter(n => n.id !== npcId);
    saveSettings();
}

function updateNpc(npcId, updates) {
    const settings = getSettings();
    const npc = settings.npcList.find(n => n.id === npcId);
    if (!npc) return;
    Object.assign(npc, updates);
    saveSettings();
}

// ============================================================
// SETTINGS UI
// ============================================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;

    container.innerHTML = '';

    for (const npc of settings.npcList) {
        const npcEl = document.createElement('div');
        npcEl.className = 'iig-npc-item';
        npcEl.dataset.npcId = npc.id;

        const avatarPreview = npc.avatarData
            ? `<img src="data:image/png;base64,${npc.avatarData}" class="iig-npc-avatar-preview" alt="NPC avatar">`
            : `<div class="iig-npc-avatar-preview iig-npc-no-avatar"><i class="fa-solid fa-user-plus"></i></div>`;

        npcEl.innerHTML = `
            <div class="iig-npc-header">
                <div class="iig-npc-avatar-container">
                    ${avatarPreview}
                    <input type="file" class="iig-npc-avatar-input" accept="image/*" style="display:none;">
                    <div class="iig-npc-avatar-upload-btn menu_button" title="Загрузить аватар">
                        <i class="fa-solid fa-upload"></i>
                    </div>
                </div>
                <div class="iig-npc-fields">
                    <input type="text" class="text_pole iig-npc-name" placeholder="Имя NPC" value="${npc.name || ''}">
                    <input type="text" class="text_pole iig-npc-aliases" placeholder="Алиасы (через запятую)" value="${(npc.aliases || []).join(', ')}">
                </div>
                <div class="iig-npc-remove menu_button" title="Удалить NPC">
                    <i class="fa-solid fa-trash"></i>
                </div>
            </div>
            <textarea class="text_pole iig-npc-appearance" rows="2" placeholder="Описание внешности (опционально)">${npc.appearance || ''}</textarea>
        `;

        // Name change
        npcEl.querySelector('.iig-npc-name').addEventListener('input', (e) => {
            updateNpc(npc.id, { name: e.target.value });
        });

        // Aliases change
        npcEl.querySelector('.iig-npc-aliases').addEventListener('input', (e) => {
            const aliases = e.target.value.split(',').map(a => a.trim()).filter(Boolean);
            updateNpc(npc.id, { aliases });
        });

        // Appearance change
        npcEl.querySelector('.iig-npc-appearance').addEventListener('input', (e) => {
            updateNpc(npc.id, { appearance: e.target.value });
        });

        // Avatar upload
        const uploadBtn = npcEl.querySelector('.iig-npc-avatar-upload-btn');
        const fileInput = npcEl.querySelector('.iig-npc-avatar-input');

        uploadBtn.addEventListener('click', () => fileInput.click());

        // Also click on avatar preview to upload
        npcEl.querySelector('.iig-npc-avatar-container').addEventListener('click', (e) => {
            if (e.target.closest('.iig-npc-avatar-upload-btn')) return; // Already handled
            fileInput.click();
        });

        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64 = reader.result.split(',')[1];
                    const resized = await resizeImageBase64(base64, 512);
                    updateNpc(npc.id, { avatarData: resized });
                    renderNpcList(); // Re-render to show new avatar
                    toastr.success(`Аватар загружен для ${npc.name || 'NPC'}`, 'Генерация картинок');
                };
                reader.readAsDataURL(file);
            } catch (err) {
                toastr.error('Ошибка загрузки аватара', 'Генерация картинок');
            }
        });

        // Remove NPC
        npcEl.querySelector('.iig-npc-remove').addEventListener('click', () => {
            removeNpc(npc.id);
            renderNpcList();
            toastr.info('NPC удалён', 'Генерация картинок');
        });

        container.appendChild(npcEl);
    }
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <hr>
                    <h4>Настройки API</h4>

                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                        </select>
                    </div>

                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint}" placeholder="https://api.example.com">
                    </div>

                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>

                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>

                    <hr>
                    <h4>Параметры генерации</h4>

                    <div class="flex-row">
                        <label for="iig_size">Размер (OpenAI)</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512</option>
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

                    <!-- Nano-Banana Section -->
                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>

                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                ${VALID_ASPECT_RATIOS.map(r => `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
                            </select>
                        </div>

                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                ${VALID_IMAGE_SIZES.map(s => `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`).join('')}
                            </select>
                        </div>

                        <hr>
                        <h5>🖼️ Референсы аватарок</h5>
                        <p class="hint">Аватарки отправляются как визуальные референсы. Модель будет копировать внешность с них.</p>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames ? 'checked' : ''}>
                            <span>🔍 Автоопределение имён в промпте (автоподтягивание аватарок)</span>
                        </label>
                        <p class="hint">Если имя персонажа/юзера/NPC упомянуто в промпте генерации — его аватарка автоматически добавится как референс.</p>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Всегда отправлять аватар персонажа</span>
                        </label>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                            <span>Всегда отправлять аватар юзера</span>
                        </label>

                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px;">
                            <label for="iig_user_avatar_file">Аватар юзера</label>
                            <select id="iig_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>

                        <hr>
                        <h5>🎭 NPC / Дополнительные персонажи</h5>
                        <p class="hint">Добавьте NPC с аватарками. При упоминании имени NPC в промпте генерации его аватарка будет автоматически использована как референс.</p>

                        <div id="iig_npc_list"></div>

                        <div id="iig_add_npc" class="menu_button" style="width: 100%; margin-top: 8px;">
                            <i class="fa-solid fa-plus"></i> Добавить NPC
                        </div>

                        <hr>
                        <h5>🎨 Пользовательские промпты</h5>
                        <p class="hint">Positive добавляется в начало, Negative — как инструкция избегания.</p>

                        <div class="flex-col" style="margin-bottom: 8px;">
                            <label for="iig_positive_prompt">Positive промпт</label>
                            <textarea id="iig_positive_prompt" class="text_pole" rows="2" placeholder="masterpiece, best quality...">${settings.positivePrompt || ''}</textarea>
                        </div>

                        <div class="flex-col" style="margin-bottom: 8px;">
                            <label for="iig_negative_prompt">Negative промпт</label>
                            <textarea id="iig_negative_prompt" class="text_pole" rows="2" placeholder="low quality, blurry...">${settings.negativePrompt || ''}</textarea>
                        </div>

                        <hr>
                        <h5>🖼️ Фиксированный стиль</h5>
                        <p class="hint">Применяется ко ВСЕМ генерациям, не меняется.</p>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
                            <span>Включить фиксированный стиль</span>
                        </label>

                        <div class="flex-col" style="margin-top: 5px;">
                            <label for="iig_fixed_style">Стиль</label>
                            <input type="text" id="iig_fixed_style" class="text_pole" value="${settings.fixedStyle || ''}" placeholder="Anime semi-realistic style...">
                        </div>

                        <hr>
                        <h5>👤 Извлечение внешности</h5>
                        <p class="hint">Автоматически извлекать текстовое описание внешности из карточек.</p>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_extract_appearance" ${settings.extractAppearance ? 'checked' : ''}>
                            <span>Из карточки персонажа</span>
                        </label>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_extract_user_appearance" ${settings.extractUserAppearance !== false ? 'checked' : ''}>
                            <span>Из персоны юзера</span>
                        </label>

                        <hr>
                        <h5>👕 Определение одежды</h5>

                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
                            <span>Определять одежду из чата</span>
                        </label>

                        <div class="flex-row" style="margin-top: 5px;">
                            <label for="iig_clothing_depth">Глубина поиска (сообщений)</label>
                            <input type="number" id="iig_clothing_depth" class="text_pole flex1" value="${settings.clothingSearchDepth || 5}" min="1" max="20">
                        </div>
                    </div>

                    <hr>
                    <h4>Обработка ошибок</h4>

                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" value="${settings.maxRetries}" min="0" max="5">
                    </div>

                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>

                    <hr>
                    <h4>Отладка</h4>

                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);
    bindSettingsEvents();
    renderNpcList();
}

function bindSettingsEvents() {
    const settings = getSettings();

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value; saveSettings();
        document.getElementById('iig_avatar_section')?.classList.toggle('hidden', e.target.value !== 'gemini');
    });

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
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_avatar_section')?.classList.remove('hidden');
        }
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const current = settings.model;
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (e) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });

    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => { settings.autoDetectNames = e.target.checked; saveSettings(); });
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();
        document.getElementById('iig_user_avatar_row')?.classList.toggle('hidden', !e.target.checked);
    });

    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => { settings.userAvatarFile = e.target.value; saveSettings(); });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            const current = settings.userAvatarFile;
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            for (const a of avatars) {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; opt.selected = a === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch (e) { toastr.error('Ошибка загрузки аватаров'); }
        finally { btn.classList.remove('loading'); }
    });

    // NPC Add button
    document.getElementById('iig_add_npc')?.addEventListener('click', () => {
        addNpc();
        renderNpcList();
        toastr.info('NPC добавлен', 'Генерация картинок');
    });

    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    document.getElementById('iig_positive_prompt')?.addEventListener('input', (e) => { settings.positivePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_negative_prompt')?.addEventListener('input', (e) => { settings.negativePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_fixed_style_enabled')?.addEventListener('change', (e) => { settings.fixedStyleEnabled = e.target.checked; saveSettings(); });
    document.getElementById('iig_fixed_style')?.addEventListener('input', (e) => { settings.fixedStyle = e.target.value; saveSettings(); });
    document.getElementById('iig_extract_appearance')?.addEventListener('change', (e) => { settings.extractAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_extract_user_appearance')?.addEventListener('change', (e) => { settings.extractUserAppearance = e.target.checked; saveSettings(); });
    document.getElementById('iig_detect_clothing')?.addEventListener('change', (e) => { settings.detectClothing = e.target.checked; saveSettings(); });
    document.getElementById('iig_clothing_depth')?.addEventListener('input', (e) => { settings.clothingSearchDepth = parseInt(e.target.value) || 5; saveSettings(); });
}

// ============================================================
// INIT
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation v2.0 loaded (with NPC support)');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => addButtonsToExistingMessages(), 100);
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        await onMessageReceived(messageId);
    });

    console.log('[IIG] Inline Image Generation v2.0 initialized');
})();
```

---

И не забудь добавить стили для NPC секции в `style.css` ₍ᐢ.ˬ.⑅ᐢ₎ Вот что нужно дописать:

```css
/* NPC Section */
.iig-npc-item {
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
    background: var(--SmartThemeBlurTintColor);
}

.iig-npc-header {
    display: flex;
    gap: 10px;
    align-items: flex-start;
}

.iig-npc-avatar-container {
    position: relative;
    flex-shrink: 0;
    cursor: pointer;
}

.iig-npc-avatar-preview {
    width: 64px;
    height: 64px;
    border-radius: 8px;
    object-fit: cover;
    border: 2px solid var(--SmartThemeBorderColor);
}

.iig-npc-no-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--SmartThemeBlurTintColor);
    color: var(--SmartThemeBodyColor);
    opacity: 0.5;
    font-size: 1.5em;
}

.iig-npc-avatar-upload-btn {
    position: absolute;
    bottom: -4px;
    right: -4px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7em;
    padding: 0;
}

.iig-npc-fields {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.iig-npc-fields .text_pole {
    margin: 0;
}

.iig-npc-remove {
    flex-shrink: 0;
    color: var(--SmartThemeQuoteColor);
}

.iig-npc-remove:hover {
    color: #ff4444;
}

.iig-npc-appearance {
    margin-top: 6px;
    width: 100%;
}
