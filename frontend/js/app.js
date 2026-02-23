/**
 * BioVLM — Comparison Dashboard
 */

// ============================================
// Configuration & State
// ============================================

const CONFIG = {
    apiEndpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:8000',
    temperature: parseFloat(localStorage.getItem('temperature')) || 0.7,
    maxTokens: parseInt(localStorage.getItem('maxTokens')) || 2048,
    streamMode: localStorage.getItem('streamMode') === 'true',
    biovlmModel: 'local/biolvlm-8b-grpo',
    gptModel: 'openai/gpt-5-mini'
};

const STATE = {
    sessions: [],        // Array of { id, title, messages, baselineHtml, usHtml }
    currentSessionId: null,
    currentImage: null,
    isLoading: false
};

let _sessionCounter = 0;

const STORAGE_KEY = 'biovlm_sessions';
const STORAGE_ACTIVE_KEY = 'biovlm_activeSession';

// Load saved sessions or bootstrap with one empty session
(function initSessions() {
    const loaded = loadFromStorage();
    if (loaded && loaded.length > 0) {
        STATE.sessions = loaded;
        // Derive counter from existing IDs to avoid collisions
        _sessionCounter = loaded.reduce((max, s) => {
            const match = s.id.match(/_(\d+)$/);
            return match ? Math.max(max, parseInt(match[1])) : max;
        }, 0);
        // Restore last active session, or fallback to most recent
        const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_KEY);
        const activeSession = loaded.find(s => s.id === savedActiveId) || loaded[loaded.length - 1];
        STATE.currentSessionId = activeSession.id;
    } else {
        const session = createSession();
        STATE.sessions.push(session);
        STATE.currentSessionId = session.id;
        persistToStorage();
    }
})();

// ============================================
// DOM Elements
// ============================================

const elements = {
    // Sidebar
    sidebar: document.getElementById('sidebar'),
    newChatBtn: document.getElementById('newChatBtn'),
    chatHistory: document.getElementById('chatHistory'),

    // Panels
    comparisonArea: document.getElementById('comparisonArea'),
    panelBaseline: document.getElementById('panelBaseline'),
    panelUs: document.getElementById('panelUs'),
    baselineChat: document.getElementById('baselineChat'),
    usChat: document.getElementById('usChat'),

    // Input
    inputBar: document.getElementById('inputBar'),
    inputBarInner: document.getElementById('inputBarInner'),
    inputPreviewRow: document.getElementById('inputPreviewRow'),
    messageInput: document.getElementById('messageInput'),
    sendBtn: document.getElementById('sendBtn'),
    uploadBtn: document.getElementById('uploadBtn'),
    imageInput: document.getElementById('imageInput'),
    imagePreview: document.getElementById('imagePreview'),
    removeImageBtn: document.getElementById('removeImageBtn'),

    // Settings
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettings: document.getElementById('closeSettings'),
    saveSettings: document.getElementById('saveSettings'),

    // Toast
    toastContainer: document.getElementById('toastContainer'),

    // Settings inputs
    apiEndpointInput: document.getElementById('apiEndpoint'),
    temperatureInput: document.getElementById('temperature'),
    tempValue: document.getElementById('tempValue'),
    maxTokensInput: document.getElementById('maxTokens'),
    streamModeInput: document.getElementById('streamMode'),
};

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadSettings();
    updateBaselineLabel();
    renderSidebar();

    // Restore the active session's panel HTML
    const active = getCurrentSession();
    if (active) restoreSession(active);
});

function initEventListeners() {
    elements.newChatBtn?.addEventListener('click', newChat);
    elements.messageInput?.addEventListener('input', updateSendButton);
    elements.messageInput?.addEventListener('keydown', handleKeyDown);
    elements.sendBtn?.addEventListener('click', sendMessage);

    // Image upload button
    elements.uploadBtn?.addEventListener('click', () => elements.imageInput.click());
    elements.imageInput?.addEventListener('change', handleImageSelect);
    elements.removeImageBtn?.addEventListener('click', removeImage);

    // Drag & drop on entire input bar
    elements.inputBar?.addEventListener('dragenter', handleDragEnter);
    elements.inputBar?.addEventListener('dragover', handleDragOver);
    elements.inputBar?.addEventListener('dragleave', handleDragLeave);
    elements.inputBar?.addEventListener('drop', handleDrop);

    // Paste image support
    elements.messageInput?.addEventListener('paste', handlePaste);

    // Settings
    elements.settingsBtn?.addEventListener('click', openSettings);
    elements.closeSettings?.addEventListener('click', closeSettings);
    elements.saveSettings?.addEventListener('click', saveSettings);
    elements.temperatureInput?.addEventListener('input', updateTempDisplay);

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
}

// ============================================
// Unified API Request (OpenAI-compatible)
// ============================================

async function sendChatRequest(model, messages, stream = false) {
    const openaiMessages = messages.map(m => {
        if (m.image) {
            return {
                role: m.role,
                content: [
                    { type: "text", text: m.content || "" },
                    { type: "image_url", image_url: { url: m.image } }
                ]
            };
        }
        return { role: m.role, content: m.content };
    });

    const body = {
        model: model,
        messages: openaiMessages,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        stream: stream
    };

    const response = await fetch(`${CONFIG.apiEndpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.detail || `HTTP ${response.status}`);
    }

    if (stream) {
        return readOpenAIStream(response);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function readOpenAIStream(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') return result;
            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) result += delta;
            } catch {}
        }
    }
    return result;
}

// ============================================
// Send Message (Panel-based)
// ============================================

function updateSendButton() {
    const hasContent = elements.messageInput.value.trim().length > 0 || STATE.currentImage;
    elements.sendBtn.disabled = !hasContent || STATE.isLoading;
}

function handleKeyDown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
}

async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if ((!content && !STATE.currentImage) || STATE.isLoading) return;

    const session = getCurrentSession();
    if (!session) return;

    const userMessage = {
        role: 'user',
        content: content,
        image: STATE.currentImage
    };
    session.messages.push(userMessage);

    // Update session title from first user message
    if (session.messages.filter(m => m.role === 'user').length === 1) {
        const title = (content || 'Image query').slice(0, 30) + ((content || '').length > 30 ? '...' : '');
        session.title = title;
        updateSidebarTitle(session.id, title);
    }

    // Clear empty placeholders on first message
    clearEmptyPlaceholders();

    // Add user bubble to both panels (with image if present)
    appendUserBubble(elements.baselineChat, content, STATE.currentImage);
    appendUserBubble(elements.usChat, content, STATE.currentImage);

    // Add typing indicator bubbles
    const baselineLoading = appendLoadingBubble(elements.baselineChat);
    const usLoading = appendLoadingBubble(elements.usChat);

    // Clear input
    elements.messageInput.value = '';
    STATE.currentImage = null;
    removeImage();
    updateSendButton();

    STATE.isLoading = true;
    updateSendButton();

    // Fire both requests in parallel
    const messagesToSend = [...session.messages];
    const [biolvlmResult, gptResult] = await Promise.allSettled([
        sendChatRequest(CONFIG.biovlmModel, messagesToSend, CONFIG.streamMode),
        sendChatRequest(CONFIG.gptModel, messagesToSend, false)
    ]);

    // Replace loading bubble with response — Baseline (GPT/OpenAI, left panel)
    baselineLoading.remove();
    if (gptResult.status === 'fulfilled') {
        appendAssistantBubble(elements.baselineChat, gptResult.value);
    } else {
        appendAssistantBubble(elements.baselineChat, null, gptResult.reason.message);
    }

    // Replace loading bubble with response — BioVLM (right panel)
    usLoading.remove();
    if (biolvlmResult.status === 'fulfilled') {
        const response = biolvlmResult.value;
        appendAssistantBubble(elements.usChat, response);
        session.messages.push({ role: 'assistant', content: response });
    } else {
        appendAssistantBubble(elements.usChat, null, biolvlmResult.reason.message);
    }

    // Save panel state
    saveCurrentSession();

    STATE.isLoading = false;
    updateSendButton();
}

// ============================================
// Bubble Helpers
// ============================================

function clearEmptyPlaceholders() {
    elements.baselineChat.querySelector('.panel-empty')?.remove();
    elements.usChat.querySelector('.panel-empty')?.remove();
}

function appendUserBubble(chatEl, text, imageSrc) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-user';

    let html = '';
    if (imageSrc) {
        html += `<img class="bubble-image" src="${imageSrc}" alt="Uploaded image">`;
    }
    if (text) {
        html += `<p>${escapeHtml(text)}</p>`;
    }
    bubble.innerHTML = html;
    chatEl.appendChild(bubble);
    chatEl.scrollTop = chatEl.scrollHeight;
}

function appendAssistantBubble(chatEl, content, errorMsg) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-assistant';

    if (errorMsg) {
        bubble.innerHTML = `<p class="error-text">${escapeHtml(errorMsg)}</p>`;
    } else {
        bubble.innerHTML = formatMessageContent(content);
    }

    chatEl.appendChild(bubble);
    chatEl.scrollTop = chatEl.scrollHeight;
    return bubble;
}

function appendLoadingBubble(chatEl) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble-assistant';
    bubble.innerHTML = `
        <div class="typing-indicator">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </div>
    `;
    chatEl.appendChild(bubble);
    chatEl.scrollTop = chatEl.scrollHeight;
    return bubble;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function resetPanels() {
    elements.baselineChat.innerHTML = '<div class="panel-empty"><i class="fas fa-robot"></i><span>OpenAI responses appear here</span></div>';
    elements.usChat.innerHTML = '<div class="panel-empty"><i class="fas fa-dna"></i><span>BioVLM responses appear here</span></div>';
}

// ============================================
// Session Helpers
// ============================================

function createSession() {
    _sessionCounter++;
    return {
        id: 'sess_' + Date.now() + '_' + _sessionCounter,
        title: 'New Chat',
        messages: [],
        baselineHtml: null,   // saved innerHTML of baselineChat
        usHtml: null           // saved innerHTML of usChat
    };
}

function getCurrentSession() {
    return STATE.sessions.find(s => s.id === STATE.currentSessionId);
}

function saveCurrentSession() {
    const session = getCurrentSession();
    if (!session) return;
    session.baselineHtml = elements.baselineChat.innerHTML;
    session.usHtml = elements.usChat.innerHTML;
    persistToStorage();
}

// ============================================
// LocalStorage Persistence
// ============================================

function persistToStorage() {
    const data = JSON.stringify(STATE.sessions);
    let retries = 3;
    while (retries > 0) {
        try {
            localStorage.setItem(STORAGE_KEY, data);
            localStorage.setItem(STORAGE_ACTIVE_KEY, STATE.currentSessionId);
            return;
        } catch (e) {
            if (e.name === 'QuotaExceededError' && STATE.sessions.length > 1) {
                // Drop the oldest session and retry
                const dropped = STATE.sessions.shift();
                showToast(`Dropped oldest session "${dropped.title}" to free space`, 'warning');
                retries--;
            } else {
                console.warn('Failed to persist sessions:', e);
                return;
            }
        }
    }
}

function loadFromStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
        console.warn('Failed to load sessions from storage:', e);
    }
    return null;
}

function restoreSession(session) {
    STATE.currentSessionId = session.id;

    if (session.baselineHtml) {
        elements.baselineChat.innerHTML = session.baselineHtml;
    } else {
        resetPanels();
    }
    if (session.usHtml) {
        elements.usChat.innerHTML = session.usHtml;
    }

    highlightSidebarItem(session.id);
}

// ============================================
// New Chat
// ============================================

function newChat() {
    // Save current session before switching
    saveCurrentSession();

    const session = createSession();
    STATE.sessions.push(session);
    STATE.currentSessionId = session.id;
    STATE.currentImage = null;

    removeImage();
    elements.messageInput.value = '';
    updateSendButton();
    resetPanels();

    // Add to sidebar and highlight
    addSidebarItem(session);
    highlightSidebarItem(session.id);

    persistToStorage();
}

// ============================================
// Sidebar / History Management
// ============================================

function renderSidebar() {
    elements.chatHistory.innerHTML = '';

    // Add "Today" section label
    const label = document.createElement('div');
    label.className = 'history-section-label';
    label.textContent = 'Today';
    elements.chatHistory.appendChild(label);

    // Render newest first
    for (let i = STATE.sessions.length - 1; i >= 0; i--) {
        appendSidebarItem(STATE.sessions[i]);
    }
    highlightSidebarItem(STATE.currentSessionId);
}

function addSidebarItem(session) {
    // Insert after the section label, before other items
    const label = elements.chatHistory.querySelector('.history-section-label');
    const item = createSidebarItem(session);
    if (label && label.nextSibling) {
        elements.chatHistory.insertBefore(item, label.nextSibling);
    } else {
        elements.chatHistory.appendChild(item);
    }
}

function appendSidebarItem(session) {
    elements.chatHistory.appendChild(createSidebarItem(session));
}

function createSidebarItem(session) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.sessionId = session.id;

    const titleSpan = document.createElement('span');
    titleSpan.textContent = session.title;
    item.appendChild(titleSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-delete';
    deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(session.id);
    });
    item.appendChild(deleteBtn);

    item.addEventListener('click', () => switchToSession(session.id));
    return item;
}

function updateSidebarTitle(sessionId, title) {
    const item = elements.chatHistory.querySelector(`[data-session-id="${sessionId}"]`);
    if (item) {
        const span = item.querySelector('span');
        if (span) span.textContent = title;
    }
}

function switchToSession(sessionId) {
    if (sessionId === STATE.currentSessionId) return;
    if (STATE.isLoading) return;

    saveCurrentSession();
    const session = STATE.sessions.find(s => s.id === sessionId);
    if (session) {
        restoreSession(session);
        persistToStorage();
    }
}

function deleteSession(sessionId) {
    // Don't delete the last session
    if (STATE.sessions.length <= 1) return;

    const idx = STATE.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return;

    STATE.sessions.splice(idx, 1);

    // If we deleted the active session, switch to the most recent one
    if (sessionId === STATE.currentSessionId) {
        const target = STATE.sessions[STATE.sessions.length - 1];
        STATE.currentSessionId = target.id;
        restoreSession(target);
    }

    // Remove from DOM
    const item = elements.chatHistory.querySelector(`[data-session-id="${sessionId}"]`);
    if (item) item.remove();

    highlightSidebarItem(STATE.currentSessionId);
    persistToStorage();
}

function highlightSidebarItem(sessionId) {
    elements.chatHistory.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
    const item = elements.chatHistory.querySelector(`[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('active');
}

// ============================================
// Format Message Content
// ============================================

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

// ============================================
// Image Functions
// ============================================

function handleImageSelect(e) {
    const file = e.target.files[0];
    if (file) processImageFile(file);
}

function handleDragEnter(e) {
    e.preventDefault();
    elements.inputBar.classList.add('drag-over');
}

function handleDragOver(e) {
    e.preventDefault();
}

function handleDragLeave(e) {
    // Only remove if we actually left the input bar
    if (!elements.inputBar.contains(e.relatedTarget)) {
        elements.inputBar.classList.remove('drag-over');
    }
}

function handleDrop(e) {
    e.preventDefault();
    elements.inputBar.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
        processImageFile(file);
    }
}

function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) processImageFile(file);
            break;
        }
    }
}

function processImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        STATE.currentImage = e.target.result;
        elements.imagePreview.src = e.target.result;
        elements.inputPreviewRow.style.display = 'block';
        updateSendButton();
        showToast('Image added', 'success');
    };
    reader.readAsDataURL(file);
}

function removeImage() {
    STATE.currentImage = null;
    if (elements.inputPreviewRow) elements.inputPreviewRow.style.display = 'none';
    if (elements.imagePreview) elements.imagePreview.src = '';
    if (elements.imageInput) elements.imageInput.value = '';
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
    localStorage.setItem('apiEndpoint', CONFIG.apiEndpoint);
    localStorage.setItem('temperature', CONFIG.temperature);
    localStorage.setItem('maxTokens', CONFIG.maxTokens);
    localStorage.setItem('streamMode', CONFIG.streamMode);

    updateBaselineLabel();
    closeSettings();
    showToast('Settings saved', 'success');
}

function updateTempDisplay() {
    elements.tempValue.textContent = elements.temperatureInput.value;
}

function updateBaselineLabel() {
    const label = document.getElementById('baselineLabel');
    if (label) label.textContent = 'GPT 5 Mini';
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
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
