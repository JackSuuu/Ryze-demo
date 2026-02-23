/**
 * BioVLM Chatbot - Main Application
 */

// ============================================
// Configuration & State
// ============================================

const CONFIG = {
    apiEndpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:3001',
    temperature: parseFloat(localStorage.getItem('temperature')) || 0.7,
    maxTokens: parseInt(localStorage.getItem('maxTokens')) || 2048,
    streamMode: localStorage.getItem('streamMode') === 'true',
    openaiApiKey: localStorage.getItem('openaiApiKey') || '',
    gptModel: localStorage.getItem('gptModel') || 'gpt-4o-mini'
};

const STATE = {
    messages: [],
    currentImage: null,
    isLoading: false,
    isDarkTheme: false
};

// ============================================
// DOM Elements
// ============================================

const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    sidebarToggle: document.getElementById('sidebarToggle'),
    mobileMenuBtn: document.getElementById('mobileMenuBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    chatHistory: document.getElementById('chatHistory'),

    // Chat
    chatMessages: document.getElementById('chatMessages'),
    welcomeScreen: document.getElementById('welcomeScreen'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    charCounter: document.getElementById('charCounter'),

    // Image
    imageInput: document.getElementById('imageInput'),
    uploadBtn: document.getElementById('uploadBtn'),
    imagePreviewContainer: document.getElementById('imagePreviewContainer'),
    imagePreview: document.getElementById('imagePreview'),
    removeImageBtn: document.getElementById('removeImageBtn'),

    // Settings
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettings: document.getElementById('closeSettings'),
    saveSettings: document.getElementById('saveSettings'),
    themeBtn: document.getElementById('themeBtn'),

    // Toast
    toastContainer: document.getElementById('toastContainer'),

    // Settings inputs
    apiEndpointInput: document.getElementById('apiEndpoint'),
    temperatureInput: document.getElementById('temperature'),
    tempValue: document.getElementById('tempValue'),
    maxTokensInput: document.getElementById('maxTokens'),
    streamModeInput: document.getElementById('streamMode'),
    openaiApiKeyInput: document.getElementById('openaiApiKey'),
    gptModelInput: document.getElementById('gptModel')
};

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadSettings();
    autoResizeTextarea();
});

function initEventListeners() {
    // Sidebar
    elements.sidebarToggle?.addEventListener('click', toggleSidebar);
    elements.mobileMenuBtn?.addEventListener('click', toggleMobileSidebar);
    elements.newChatBtn?.addEventListener('click', newChat);

    // Input
    elements.messageInput?.addEventListener('input', handleInputChange);
    elements.messageInput?.addEventListener('keydown', handleKeyDown);
    elements.sendBtn?.addEventListener('click', sendMessage);

    // Image
    elements.uploadBtn?.addEventListener('click', () => elements.imageInput.click());
    elements.imageInput?.addEventListener('change', handleImageSelect);
    elements.removeImageBtn?.addEventListener('click', removeImage);

    // Drag & Drop
    elements.messageInput?.addEventListener('dragover', handleDragOver);
    elements.messageInput?.addEventListener('drop', handleDrop);

    // Settings
    elements.settingsBtn?.addEventListener('click', openSettings);
    elements.closeSettings?.addEventListener('click', closeSettings);
    elements.saveSettings?.addEventListener('click', saveSettings);
    elements.temperatureInput?.addEventListener('input', updateTempDisplay);

    // Theme
    elements.themeBtn?.addEventListener('click', toggleTheme);

    // Close modal on outside click
    elements.settingsModal?.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) closeSettings();
    });
}

function loadSettings() {
    elements.apiEndpointInput.value = CONFIG.apiEndpoint;
    elements.temperatureInput.value = CONFIG.temperature;
    elements.tempValue.textContent = CONFIG.temperature;
    elements.maxTokensInput.value = CONFIG.maxTokens;
    elements.streamModeInput.checked = CONFIG.streamMode;
    elements.openaiApiKeyInput.value = CONFIG.openaiApiKey;
    elements.gptModelInput.value = CONFIG.gptModel;
}

// ============================================
// Sidebar Functions
// ============================================

function toggleSidebar() {
    elements.sidebar.classList.toggle('collapsed');
}

function toggleMobileSidebar() {
    elements.sidebar.classList.toggle('active');
}

function newChat() {
    STATE.messages = [];
    STATE.currentImage = null;

    elements.chatMessages.innerHTML = '';
    elements.chatMessages.appendChild(elements.welcomeScreen.cloneNode(true));
    elements.welcomeScreen.style.display = 'flex';

    removeImage();
    elements.messageInput.value = '';
    updateSendButton();

    showToast('New chat created', 'success');
}

// ============================================
// Message Functions
// ============================================

function handleInputChange() {
    autoResizeTextarea();
    updateCharCounter();
    updateSendButton();
}

function autoResizeTextarea() {
    const textarea = elements.messageInput;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
}

function updateCharCounter() {
    const count = elements.messageInput.value.length;
    elements.charCounter.textContent = `${count} / 10000`;
}

function updateSendButton() {
    const hasContent = elements.messageInput.value.trim().length > 0 || STATE.currentImage;
    elements.sendBtn.disabled = !hasContent || STATE.isLoading;
}

function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if ((!content && !STATE.currentImage) || STATE.isLoading) return;

    // Hide welcome screen
    const welcomeScreen = document.querySelector('.welcome-screen');
    if (welcomeScreen) {
        welcomeScreen.style.display = 'none';
    }

    // Add user message
    const userMessage = {
        role: 'user',
        content: content,
        image: STATE.currentImage
    };
    STATE.messages.push(userMessage);
    renderUserMessage(userMessage);

    // Clear input
    elements.messageInput.value = '';
    STATE.currentImage = null;
    removeImage();
    autoResizeTextarea();
    updateCharCounter();
    updateSendButton();

    STATE.isLoading = true;
    updateSendButton();

    // Create split response container with loading indicators
    const responseContainer = createResponseContainer();
    elements.chatMessages.appendChild(responseContainer);
    scrollToBottom();

    const biolvlmContent = responseContainer.querySelector('.biolvlm-content');
    const gptContent = responseContainer.querySelector('.gpt-content');

    // Fire both requests in parallel
    const messagesToSend = [...STATE.messages];
    const [biolvlmResult, gptResult] = await Promise.allSettled([
        sendBioVLMRequest(messagesToSend),
        sendGPTRequest(messagesToSend)
    ]);

    // Handle BioVLM result
    if (biolvlmResult.status === 'fulfilled') {
        const response = biolvlmResult.value;
        biolvlmContent.innerHTML = formatMessageContent(response);
        STATE.messages.push({ role: 'assistant', content: response });
    } else {
        biolvlmContent.innerHTML = `<p class="error-text">⚠️ ${biolvlmResult.reason.message}</p>`;
    }

    // Handle GPT result
    if (gptResult.status === 'fulfilled') {
        gptContent.innerHTML = formatMessageContent(gptResult.value.response);
    } else {
        const err = gptResult.reason;
        if (err.type === 'rate_limit') {
            showRateLimitCountdown(gptContent, err.secondsRemaining);
        } else {
            gptContent.innerHTML = `<p class="error-text">⚠️ ${err.message}</p>`;
        }
    }

    STATE.isLoading = false;
    updateSendButton();
    scrollToBottom();
}

// ============================================
// BioVLM API Request
// ============================================

async function sendBioVLMRequest(messages) {
    const endpoint = CONFIG.streamMode
        ? `${CONFIG.apiEndpoint}/chat/stream`
        : `${CONFIG.apiEndpoint}/chat`;

    const body = {
        messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            image: m.image || null
        })),
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        stream: CONFIG.streamMode
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`BioVLM HTTP ${response.status}: ${response.statusText}`);
    }

    if (CONFIG.streamMode) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let result = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') break;
                    result += data;
                }
            }
        }

        return result;
    } else {
        const data = await response.json();
        return data.response;
    }
}

// ============================================
// GPT API Request
// ============================================

async function sendGPTRequest(messages) {
    const response = await fetch(`${CONFIG.apiEndpoint}/chat/gpt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
                image: m.image || null
            })),
            max_tokens: CONFIG.maxTokens,
            temperature: CONFIG.temperature
        })
    });

    if (response.status === 429) {
        const data = await response.json();
        const detail = data.detail || {};
        const err = new Error(detail.message || 'Rate limited');
        err.type = 'rate_limit';
        err.secondsRemaining = detail.seconds_remaining || 60;
        throw err;
    }

    if (response.status === 503) {
        const data = await response.json();
        throw new Error(data.detail || 'GPT service unavailable');
    }

    if (!response.ok) {
        throw new Error(`GPT HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
}

// ============================================
// Response Container (Split View)
// ============================================

function createResponseContainer() {
    const container = document.createElement('div');
    container.className = 'response-pair';

    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const gptLabel = CONFIG.gptModel || 'GPT';

    container.innerHTML = `
        <div class="response-panel panel-biolvlm">
            <div class="panel-label">
                <div class="panel-avatar biolvlm-avatar"><i class="fas fa-dna"></i></div>
                <span class="panel-name">BioVLM</span>
                <span class="panel-time">${time}</span>
            </div>
            <div class="biolvlm-content panel-content">
                <div class="typing-indicator">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>
        </div>
        <div class="response-panel panel-gpt">
            <div class="panel-label">
                <div class="panel-avatar gpt-avatar"><i class="fas fa-robot"></i></div>
                <span class="panel-name">GPT</span>
                <span class="panel-model">${gptLabel}</span>
                <span class="panel-time">${time}</span>
            </div>
            <div class="gpt-content panel-content">
                <div class="typing-indicator">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                </div>
            </div>
        </div>
    `;

    return container;
}

function showRateLimitCountdown(panelContent, secondsRemaining) {
    let remaining = secondsRemaining;

    panelContent.innerHTML = `
        <div class="rate-limit-notice">
            <i class="fas fa-clock"></i>
            <span>Rate limited &mdash; next call in <span class="countdown">${remaining}s</span></span>
        </div>
    `;

    const countdownEl = panelContent.querySelector('.countdown');

    const interval = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(interval);
            panelContent.innerHTML = `
                <div class="rate-limit-ready">
                    <i class="fas fa-check-circle"></i>
                    <span>Ready &mdash; send a new message to use GPT</span>
                </div>
            `;
        } else if (countdownEl) {
            countdownEl.textContent = `${remaining}s`;
        }
    }, 1000);
}

// ============================================
// Render User Message
// ============================================

function renderUserMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message user';

    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    let imageHtml = '';
    if (message.image) {
        imageHtml = `<img src="${message.image}" class="message-image" alt="Uploaded image">`;
    }

    messageEl.innerHTML = `
        <div class="message-avatar"><i class="fas fa-user"></i></div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-name">You</span>
                <span class="message-time">${time}</span>
            </div>
            <div class="message-text">
                ${formatMessageContent(message.content)}
                ${imageHtml}
            </div>
        </div>
    `;

    elements.chatMessages.appendChild(messageEl);
    scrollToBottom();
}

function formatMessageContent(content) {
    if (!content) return '<p></p>';
    let formatted = content
        .replace(/\n/g, '<br>')
        .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    return `<p>${formatted}</p>`;
}

function scrollToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

// ============================================
// Image Functions
// ============================================

function handleImageSelect(e) {
    const file = e.target.files[0];
    if (file) {
        processImageFile(file);
    }
}

function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.style.borderColor = 'var(--accent-primary)';
}

function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.style.borderColor = '';

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        processImageFile(file);
    }
}

function processImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        STATE.currentImage = e.target.result;
        elements.imagePreview.src = e.target.result;
        elements.imagePreviewContainer.style.display = 'block';
        updateSendButton();
        showToast('Image added', 'success');
    };
    reader.readAsDataURL(file);
}

function removeImage() {
    STATE.currentImage = null;
    elements.imagePreviewContainer.style.display = 'none';
    elements.imagePreview.src = '';
    elements.imageInput.value = '';
    updateSendButton();
}

// ============================================
// Settings Functions
// ============================================

function openSettings() {
    elements.settingsModal.classList.add('active');
}

function closeSettings() {
    elements.settingsModal.classList.remove('active');
}

function saveSettings() {
    CONFIG.apiEndpoint = elements.apiEndpointInput.value;
    CONFIG.temperature = parseFloat(elements.temperatureInput.value);
    CONFIG.maxTokens = parseInt(elements.maxTokensInput.value);
    CONFIG.streamMode = elements.streamModeInput.checked;
    CONFIG.openaiApiKey = elements.openaiApiKeyInput.value;
    CONFIG.gptModel = elements.gptModelInput.value || 'gpt-4o-mini';

    localStorage.setItem('apiEndpoint', CONFIG.apiEndpoint);
    localStorage.setItem('temperature', CONFIG.temperature);
    localStorage.setItem('maxTokens', CONFIG.maxTokens);
    localStorage.setItem('streamMode', CONFIG.streamMode);
    localStorage.setItem('openaiApiKey', CONFIG.openaiApiKey);
    localStorage.setItem('gptModel', CONFIG.gptModel);

    closeSettings();
    showToast('Settings saved', 'success');
}

function updateTempDisplay() {
    elements.tempValue.textContent = elements.temperatureInput.value;
}

// ============================================
// Theme Functions
// ============================================

function toggleTheme() {
    STATE.isDarkTheme = !STATE.isDarkTheme;
    document.body.setAttribute('data-theme', STATE.isDarkTheme ? 'dark' : 'light');

    const icon = elements.themeBtn.querySelector('i');
    icon.className = STATE.isDarkTheme ? 'fas fa-sun' : 'fas fa-moon';
}

// ============================================
// Toast Notifications
// ============================================

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-check',
        error: 'fa-times',
        warning: 'fa-exclamation'
    };

    toast.innerHTML = `
        <div class="toast-icon">
            <i class="fas ${icons[type] || 'fa-info'}"></i>
        </div>
        <span class="toast-message">${message}</span>
    `;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============================================
// Suggestion Functions
// ============================================

window.useSuggestion = function(text) {
    elements.messageInput.value = text;
    elements.messageInput.focus();
    handleInputChange();
};
