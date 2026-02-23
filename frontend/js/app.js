/**
 * Ryze AI Chatbot - Main Application
 */

// ============================================
// Configuration & State
// ============================================

const CONFIG = {
    apiEndpoint: localStorage.getItem('apiEndpoint') || 'http://localhost:3001',
    temperature: parseFloat(localStorage.getItem('temperature')) || 0.7,
    maxTokens: parseInt(localStorage.getItem('maxTokens')) || 2048,
    streamMode: localStorage.getItem('streamMode') === 'true'  // Default to non-streaming
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
    
    // Background
    particles: document.getElementById('particles')
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
    renderMessage(userMessage);
    
    // Clear input
    elements.messageInput.value = '';
    STATE.currentImage = null;
    removeImage();
    autoResizeTextarea();
    updateCharCounter();
    updateSendButton();
    
    // Show typing indicator
    STATE.isLoading = true;
    updateSendButton();
    const typingEl = showTypingIndicator();
    
    try {
        // Send request to API
        const response = await sendChatRequest(STATE.messages);
        
        // Remove typing indicator
        typingEl.remove();
        
        // Add assistant message
        const assistantMessage = {
            role: 'assistant',
            content: response
        };
        STATE.messages.push(assistantMessage);
        renderMessage(assistantMessage);
        
    } catch (error) {
        typingEl.remove();
        showToast(`Failed to send: ${error.message}`, 'error');
        
        // Add error message
        renderMessage({
            role: 'assistant',
            content: `⚠️ Sorry, an error occurred: ${error.message}\n\nPlease check if the backend service is running.`
        });
    } finally {
        STATE.isLoading = false;
        updateSendButton();
    }
}

async function sendChatRequest(messages) {
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
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    if (CONFIG.streamMode) {
        // Handle streaming response
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

function renderMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${message.role}`;
    
    const avatar = message.role === 'user' 
        ? '<i class="fas fa-user"></i>'
        : '<i class="fas fa-robot"></i>';
    
    const name = message.role === 'user' ? 'You' : 'Ryze AI';
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    
    let imageHtml = '';
    if (message.image) {
        imageHtml = `<img src="${message.image}" class="message-image" alt="Uploaded image">`;
    }
    
    messageEl.innerHTML = `
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">
            <div class="message-header">
                <span class="message-name">${name}</span>
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
    // Basic formatting
    let formatted = content
        .replace(/\n/g, '<br>')
        .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    return `<p>${formatted}</p>`;
}

function showTypingIndicator() {
    const typingEl = document.createElement('div');
    typingEl.className = 'message assistant';
    typingEl.innerHTML = `
        <div class="message-avatar"><i class="fas fa-robot"></i></div>
        <div class="message-content">
            <div class="typing-indicator">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        </div>
    `;
    elements.chatMessages.appendChild(typingEl);
    scrollToBottom();
    return typingEl;
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
    
    // Save to localStorage
    localStorage.setItem('apiEndpoint', CONFIG.apiEndpoint);
    localStorage.setItem('temperature', CONFIG.temperature);
    localStorage.setItem('maxTokens', CONFIG.maxTokens);
    localStorage.setItem('streamMode', CONFIG.streamMode);
    
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
            <i class="fas ${icons[type]}"></i>
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
