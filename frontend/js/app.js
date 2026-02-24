/**
 * Ryze — Arena AI Side-by-Side Dashboard
 */

// ============================================
// Configuration & State
// ============================================

const CONFIG = {
    apiEndpoint: '/api',
    temperature: parseFloat(localStorage.getItem('temperature')) || 0.7,
    maxTokens: parseInt(localStorage.getItem('maxTokens')) || 2048,
    streamMode: localStorage.getItem('streamMode') !== 'false', // default on
    biovlmModel: 'local/biolvlm-8b-grpo',
    gptModel: 'openai/gpt-5-mini',
    byokBaseUrl: localStorage.getItem('byokBaseUrl') || '',
    byokApiKey: localStorage.getItem('byokApiKey') || '',
    byokModelName: localStorage.getItem('byokModelName') || '',
    byokDisplayName: localStorage.getItem('byokDisplayName') || '',
};

const STATE = {
    sessions: [],        // Array of { id, title, messages, chatHtml }
    currentSessionId: null,
    currentImage: null,
    isLoading: false
};

let _sessionCounter = 0;

const STORAGE_KEY = 'biovlm_sessions';
const STORAGE_ACTIVE_KEY = 'biovlm_activeSession';

// Load saved sessions; if the last active session is non-empty, auto-create a fresh one
(function initSessions() {
    const loaded = loadFromStorage();
    if (loaded && loaded.length > 0) {
        STATE.sessions = loaded;
        _sessionCounter = loaded.reduce((max, s) => {
            const match = s.id.match(/_(\d+)$/);
            return match ? Math.max(max, parseInt(match[1])) : max;
        }, 0);
        const savedActiveId = localStorage.getItem(STORAGE_ACTIVE_KEY);
        const activeSession = loaded.find(s => s.id === savedActiveId) || loaded[loaded.length - 1];

        if (activeSession.messages && activeSession.messages.length > 0) {
            const fresh = createSession();
            STATE.sessions.push(fresh);
            STATE.currentSessionId = fresh.id;
            persistToStorage();
        } else {
            STATE.currentSessionId = activeSession.id;
        }
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

    // Chat area
    chatScroll: document.getElementById('chatScroll'),
    emptyState: document.getElementById('emptyState'),

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
    temperatureInput: document.getElementById('temperature'),
    tempValue: document.getElementById('tempValue'),
    maxTokensInput: document.getElementById('maxTokens'),
    streamModeInput: document.getElementById('streamMode'),

    // BYOK inputs
    byokBaseUrlInput: document.getElementById('byokBaseUrl'),
    byokApiKeyInput: document.getElementById('byokApiKey'),
    byokModelNameInput: document.getElementById('byokModelName'),
    byokDisplayNameInput: document.getElementById('byokDisplayName'),
};

// ============================================
// Initialization
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadSettings();
    updateBaselineLabel();
    renderSidebar();

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

    // Copy button delegation on chat scroll
    elements.chatScroll?.addEventListener('click', handleCopyClick);
}

function loadSettings() {
    elements.temperatureInput.value = CONFIG.temperature;
    elements.tempValue.textContent = CONFIG.temperature;
    elements.maxTokensInput.value = CONFIG.maxTokens;
    elements.streamModeInput.checked = CONFIG.streamMode;

    // BYOK
    elements.byokBaseUrlInput.value = CONFIG.byokBaseUrl;
    elements.byokApiKeyInput.value = CONFIG.byokApiKey;
    elements.byokModelNameInput.value = CONFIG.byokModelName;
    elements.byokDisplayNameInput.value = CONFIG.byokDisplayName;
}

// ============================================
// Unified API Request (OpenAI-compatible)
// ============================================

async function sendChatRequest(model, messages, stream = false, onToken = null) {
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
        return readOpenAIStream(response, onToken);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function readOpenAIStream(response, onToken = null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') return result;
            try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta != null && delta !== '') {
                    result += delta;
                    if (onToken) onToken(delta);
                }
            } catch {}
        }
    }
    return result;
}

// ============================================
// BYOK: Direct OpenAI Call
// ============================================

function isByokEnabled() {
    return !!CONFIG.byokApiKey;
}

async function sendDirectOpenAIRequest(messages, stream = false, onToken = null) {
    const baseUrl = (CONFIG.byokBaseUrl || 'https://api.openai.com').replace(/\/+$/, '').replace(/\/v1$/, '');
    const model = CONFIG.byokModelName || 'gpt-5-mini';

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

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CONFIG.byokApiKey}`
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error?.message || errData.detail || `HTTP ${response.status}`);
    }

    if (stream) {
        return readOpenAIStream(response, onToken);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

// ============================================
// Send Message (Arena-style)
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

    // Hide empty state
    hideEmptyState();

    // Build message group
    const group = document.createElement('div');
    group.className = 'message-group';

    // User bubble (once, right-aligned)
    const userDiv = document.createElement('div');
    userDiv.className = 'user-message';
    const bubble = document.createElement('div');
    bubble.className = 'user-bubble';
    let html = '';
    if (STATE.currentImage) {
        html += `<img class="bubble-image" src="${STATE.currentImage}" alt="Uploaded image">`;
    }
    if (content) {
        html += `<p>${escapeHtml(content)}</p>`;
    }
    bubble.innerHTML = html;
    userDiv.appendChild(bubble);
    group.appendChild(userDiv);

    // Response pair (two cards side by side)
    const pair = document.createElement('div');
    pair.className = 'response-pair';

    const gptCard = createResponseCard('fa-robot', CONFIG.byokDisplayName || 'GPT 5 Mini');
    const bioCard = createResponseCard('fa-dna', 'BioVLM');

    pair.appendChild(gptCard.card);
    pair.appendChild(bioCard.card);
    group.appendChild(pair);

    elements.chatScroll.appendChild(group);
    scrollToBottom();

    // Clear input
    elements.messageInput.value = '';
    STATE.currentImage = null;
    removeImage();
    updateSendButton();

    STATE.isLoading = true;
    updateSendButton();

    // Fire both requests in parallel
    const messagesToSend = [...session.messages];

    if (CONFIG.streamMode) {
        // Streaming path
        const gptStream = createStreamingContent(gptCard.contentEl);
        const bioStream = createStreamingContent(bioCard.contentEl);

        const gptStreamCall = isByokEnabled()
            ? sendDirectOpenAIRequest(messagesToSend, true, d => { gptStream.update(d); scrollToBottom(); })
            : sendChatRequest(CONFIG.gptModel, messagesToSend, true, d => { gptStream.update(d); scrollToBottom(); });

        const [biolvlmResult, gptResult] = await Promise.allSettled([
            sendChatRequest(CONFIG.biovlmModel, messagesToSend, true, d => { bioStream.update(d); scrollToBottom(); }),
            gptStreamCall
        ]);

        if (biolvlmResult.status === 'fulfilled') {
            bioStream.finalize(biolvlmResult.value);
            session.messages.push({ role: 'assistant', content: biolvlmResult.value });
        } else {
            bioStream.error(biolvlmResult.reason ? biolvlmResult.reason.message : 'Error');
        }

        if (gptResult.status === 'fulfilled') {
            gptStream.finalize(gptResult.value);
        } else {
            gptStream.error(gptResult.reason ? gptResult.reason.message : 'Error');
        }

    } else {
        // Non-streaming path: show typing indicators then replace
        gptCard.contentEl.innerHTML = typingIndicatorHTML();
        bioCard.contentEl.innerHTML = typingIndicatorHTML();

        const gptNonStreamCall = isByokEnabled()
            ? sendDirectOpenAIRequest(messagesToSend, false)
            : sendChatRequest(CONFIG.gptModel, messagesToSend, false);

        const [biolvlmResult, gptResult] = await Promise.allSettled([
            sendChatRequest(CONFIG.biovlmModel, messagesToSend, false),
            gptNonStreamCall
        ]);

        if (gptResult.status === 'fulfilled') {
            gptCard.contentEl.innerHTML = formatMessageContent(gptResult.value);
        } else {
            gptCard.contentEl.innerHTML = `<p class="error-text">${escapeHtml(gptResult.reason?.message || 'Error')}</p>`;
        }

        if (biolvlmResult.status === 'fulfilled') {
            bioCard.contentEl.innerHTML = formatMessageContent(biolvlmResult.value);
            session.messages.push({ role: 'assistant', content: biolvlmResult.value });
        } else {
            bioCard.contentEl.innerHTML = `<p class="error-text">${escapeHtml(biolvlmResult.reason?.message || 'Error')}</p>`;
        }
    }

    scrollToBottom();
    saveCurrentSession();

    STATE.isLoading = false;
    updateSendButton();
}

// ============================================
// Response Card & Streaming Helpers
// ============================================

function createResponseCard(icon, name) {
    const card = document.createElement('div');
    card.className = 'response-card';

    const header = document.createElement('div');
    header.className = 'response-card-header';

    const model = document.createElement('div');
    model.className = 'response-card-model';
    model.innerHTML = `<i class="fas ${icon}"></i><span>${escapeHtml(name)}</span>`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = 'Copy';
    copyBtn.innerHTML = '<i class="fas fa-copy"></i>';

    header.appendChild(model);
    header.appendChild(copyBtn);

    const contentEl = document.createElement('div');
    contentEl.className = 'response-card-content';
    contentEl.innerHTML = typingIndicatorHTML();

    card.appendChild(header);
    card.appendChild(contentEl);

    return { card, contentEl };
}

function createStreamingContent(contentEl) {
    let started = false;
    let textEl = null;

    return {
        update(delta) {
            if (!started) {
                started = true;
                contentEl.innerHTML =
                    '<span class="stream-text"></span><span class="stream-cursor"></span>';
                textEl = contentEl.querySelector('.stream-text');
            }
            if (textEl && delta) {
                textEl.textContent += delta;
            }
        },
        finalize(fullText) {
            contentEl.innerHTML = fullText
                ? formatMessageContent(fullText)
                : '<p></p>';
        },
        error(msg) {
            contentEl.innerHTML = '<p class="error-text">' + escapeHtml(msg) + '</p>';
        }
    };
}

function typingIndicatorHTML() {
    return '<div class="typing-indicator">' +
        '<span class="typing-dot"></span>' +
        '<span class="typing-dot"></span>' +
        '<span class="typing-dot"></span></div>';
}

function hideEmptyState() {
    if (elements.emptyState) {
        elements.emptyState.style.display = 'none';
    }
}

function showEmptyState() {
    if (elements.emptyState) {
        elements.emptyState.style.display = '';
    }
}

function scrollToBottom() {
    if (elements.chatScroll) {
        elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
    }
}

// Copy button delegation
function handleCopyClick(e) {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const card = btn.closest('.response-card');
    if (!card) return;
    const contentEl = card.querySelector('.response-card-content');
    if (!contentEl) return;

    const text = contentEl.innerText || contentEl.textContent;
    navigator.clipboard.writeText(text).then(() => {
        btn.innerHTML = '<i class="fas fa-check"></i>';
        setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i>'; }, 1500);
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function resetChat() {
    elements.chatScroll.innerHTML = '';
    // Re-create the empty state
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'empty-state';
    emptyDiv.id = 'emptyState';
    emptyDiv.innerHTML = '<h1>What would you like to compare?</h1>' +
        '<p>Send a message to see GPT and BioVLM respond side by side.</p>';
    elements.chatScroll.appendChild(emptyDiv);
    // Update reference
    elements.emptyState = emptyDiv;
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
        chatHtml: null
    };
}

function getCurrentSession() {
    return STATE.sessions.find(s => s.id === STATE.currentSessionId);
}

function saveCurrentSession() {
    const session = getCurrentSession();
    if (!session) return;
    session.chatHtml = elements.chatScroll.innerHTML;
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

    if (session.chatHtml) {
        elements.chatScroll.innerHTML = session.chatHtml;
        // Update emptyState ref (it may or may not exist in restored HTML)
        elements.emptyState = elements.chatScroll.querySelector('.empty-state');
    } else if (session.baselineHtml || session.usHtml) {
        // Backward compat: old format sessions show empty state
        resetChat();
    } else {
        resetChat();
    }

    highlightSidebarItem(session.id);
}

// ============================================
// New Chat
// ============================================

function newChat() {
    saveCurrentSession();

    const session = createSession();
    STATE.sessions.push(session);
    STATE.currentSessionId = session.id;
    STATE.currentImage = null;

    removeImage();
    elements.messageInput.value = '';
    updateSendButton();
    resetChat();

    addSidebarItem(session);
    highlightSidebarItem(session.id);

    persistToStorage();
}

// ============================================
// Sidebar / History Management
// ============================================

function renderSidebar() {
    elements.chatHistory.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'history-section-label';
    label.textContent = 'Today';
    elements.chatHistory.appendChild(label);

    for (let i = STATE.sessions.length - 1; i >= 0; i--) {
        appendSidebarItem(STATE.sessions[i]);
    }
    highlightSidebarItem(STATE.currentSessionId);
}

function addSidebarItem(session) {
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
    if (STATE.sessions.length <= 1) return;

    const idx = STATE.sessions.findIndex(s => s.id === sessionId);
    if (idx === -1) return;

    STATE.sessions.splice(idx, 1);

    if (sessionId === STATE.currentSessionId) {
        const target = STATE.sessions[STATE.sessions.length - 1];
        STATE.currentSessionId = target.id;
        restoreSession(target);
    }

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
    elements.inputBar.classList.add('drag-over', 'drag-expand');
}

function handleDragOver(e) {
    e.preventDefault();
}

function handleDragLeave(e) {
    if (!elements.inputBar.contains(e.relatedTarget)) {
        elements.inputBar.classList.remove('drag-over', 'drag-expand');
    }
}

function handleDrop(e) {
    e.preventDefault();
    elements.inputBar.classList.remove('drag-over', 'drag-expand');
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
        elements.inputPreviewRow.classList.add('visible');
        updateSendButton();
        showToast('Image added', 'success');
    };
    reader.readAsDataURL(file);
}

function removeImage() {
    STATE.currentImage = null;
    if (elements.inputPreviewRow) elements.inputPreviewRow.classList.remove('visible');
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
    CONFIG.temperature = parseFloat(elements.temperatureInput.value);
    CONFIG.maxTokens = parseInt(elements.maxTokensInput.value);
    CONFIG.streamMode = elements.streamModeInput.checked;
    localStorage.setItem('temperature', CONFIG.temperature);
    localStorage.setItem('maxTokens', CONFIG.maxTokens);
    localStorage.setItem('streamMode', CONFIG.streamMode);

    // BYOK
    CONFIG.byokBaseUrl = elements.byokBaseUrlInput.value.trim();
    CONFIG.byokApiKey = elements.byokApiKeyInput.value.trim();
    CONFIG.byokModelName = elements.byokModelNameInput.value.trim();
    CONFIG.byokDisplayName = elements.byokDisplayNameInput.value.trim();
    localStorage.setItem('byokBaseUrl', CONFIG.byokBaseUrl);
    localStorage.setItem('byokApiKey', CONFIG.byokApiKey);
    localStorage.setItem('byokModelName', CONFIG.byokModelName);
    localStorage.setItem('byokDisplayName', CONFIG.byokDisplayName);

    updateBaselineLabel();
    closeSettings();
    showToast('Settings saved', 'success');
}

function updateTempDisplay() {
    elements.tempValue.textContent = elements.temperatureInput.value;
}

function updateBaselineLabel() {
    const label = document.getElementById('baselineLabel');
    if (label) label.textContent = CONFIG.byokDisplayName || 'GPT 5 Mini';
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
