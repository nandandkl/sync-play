document.addEventListener('DOMContentLoaded', () => {
    const screens = {
        connect: document.getElementById('connect-screen'),
        dashboard: document.getElementById('dashboard-screen')
    };

    const elements = {
        usernameInput: document.getElementById('username'),
        roomInput: document.getElementById('room-code'),
        isHostCheckbox: document.getElementById('is-host'),
        connectBtn: document.getElementById('connect-btn'),
        disconnectBtn: document.getElementById('disconnect-btn'),
        roomDisplay: document.getElementById('room-display'),
        usernameDisplay: document.getElementById('username-display'),
        roleDisplay: document.getElementById('role-display'),
        connectionIndicator: document.getElementById('connection-indicator'),
        videoStatusText: document.getElementById('video-status-text'),
        timeDisplay: document.getElementById('time-display'),
        playStateIcon: document.getElementById('play-state-icon'),
        toast: document.getElementById('toast'),
        userList: document.getElementById('user-list')
    };

    let currentTabId = null;

    function showToast(message, type = 'error') {
        elements.toast.textContent = message;
        if (type === 'error') {
            elements.toast.style.backgroundColor = 'rgba(239, 68, 68, 0.9)';
            elements.toast.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        } else {
            elements.toast.style.backgroundColor = 'rgba(16, 185, 129, 0.9)';
            elements.toast.style.borderColor = 'rgba(16, 185, 129, 0.3)';
        }

        elements.toast.classList.remove('hidden');
        setTimeout(() => elements.toast.classList.add('hidden'), 3000);
    }

    function toggleScreen(screenName) {
        if (screenName === 'dashboard') {
            screens.connect.classList.add('hidden');
            screens.dashboard.classList.remove('hidden');
        } else {
            screens.dashboard.classList.add('hidden');
            screens.connect.classList.remove('hidden');
        }
    }

    function updateConnectionState(connected) {
        if (connected) {
            elements.connectionIndicator.classList.add('connected');
        } else {
            elements.connectionIndicator.classList.remove('connected');
        }
    }

    function formatTime(seconds) {
        if (!seconds) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function renderUserList(users) {
        elements.userList.innerHTML = '';
        const titleElement = document.querySelector('.users-section .section-title');

        if (!users || users.length === 0) {
            if (titleElement) titleElement.textContent = 'Connected Users (0)';
            return;
        }

        if (titleElement) {
            titleElement.textContent = `Connected Users (${users.length})`;
        }

        users.forEach(user => {
            const div = document.createElement('div');
            div.className = `user-item ${user.isHost ? 'is-host' : ''}`;
            div.innerHTML = `
                <span class="user-item-name">${escapeHtml(user.username || 'Anonymous')}</span>
                <span class="user-item-role">${user.isHost ? 'HOST' : 'VIEWER'}</span>
            `;
            elements.userList.appendChild(div);
        });
    }

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, function (m) { return map[m]; });
    }


    // Get Current Tab ID first
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) return;
        currentTabId = tabs[0].id;

        // Initial Status Check
        checkStatus();
    });

    function checkStatus() {
        if (!currentTabId) return;

        chrome.runtime.sendMessage({ action: 'get_status', tabId: currentTabId }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("Service worker likely sleeping.");
                return;
            }

            if (response && response.connected) {
                updateUI(true, response.room, response.username, response.isHost);
                if (response.users) {
                    renderUserList(response.users);
                }
                if (response.videoState) {
                    updateVideoStatus(response.videoState);
                } else {
                    // Cache cold? Ask content script directly
                    chrome.tabs.sendMessage(currentTabId, { action: 'get_video_status' }, (vidResponse) => {
                        if (!chrome.runtime.lastError && vidResponse) {
                            updateVideoStatus(vidResponse);
                        }
                    });
                }
            } else {
                // Load saved preferences
                chrome.storage.local.get(['room', 'username', 'isHost'], (result) => {
                    if (result.room) elements.roomInput.value = result.room;
                    if (result.username) elements.usernameInput.value = result.username;
                    if (result.isHost) elements.isHostCheckbox.checked = result.isHost;
                });
            }
        });
    }


    elements.connectBtn.addEventListener('click', () => {
        const room = elements.roomInput.value.trim();
        const username = elements.usernameInput.value.trim();
        const isHost = elements.isHostCheckbox.checked;

        if (!username) {
            showToast('Please enter your Name');
            elements.usernameInput.focus();
            return;
        }

        if (!room) {
            showToast('Please enter a Room Code');
            elements.roomInput.focus();
            return;
        }

        elements.connectBtn.innerHTML = '<span class="btn-text">Connecting...</span>';
        elements.connectBtn.disabled = true;

        // Save prefs
        chrome.storage.local.set({ room, username, isHost });

        chrome.runtime.sendMessage({
            action: 'connect',
            room: room,
            username: username,
            isHost: isHost,
            tabId: currentTabId
        }, (response) => {
            elements.connectBtn.innerHTML = '<span class="btn-text">Join Room</span>';
            elements.connectBtn.disabled = false;

            if (chrome.runtime.lastError) {
                showToast("Connection Error: Reload Extension");
                return;
            }

            if (response && response.status === 'connected') {
                updateUI(true, room, username, isHost);
                // User list will come via 'room_users_update' shortly
            } else {
                elements.connectBtn.innerHTML = '<span class="btn-text">Connect</span>';
                elements.connectBtn.disabled = false;
                showToast(response?.message || "Connection Failed");
            }
        });
    });

    elements.disconnectBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'disconnect', tabId: currentTabId }, () => {
            updateUI(false);
        });
    });

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === 'apply_state') {
            const data = request.data;
            // Check if this update belongs to our current room
            if (currentRoomName && data.room === currentRoomName) {
                updateVideoStatus(data);
            }
        }
        else if (request.action === 'socket_error') {
            showToast(request.message);
            if (request.message === 'Room does not exist' ||
                request.message === 'Invalid Room Name' ||
                request.message.includes('Room closed')) {
                chrome.runtime.sendMessage({ action: 'disconnect', tabId: currentTabId }, () => {
                    updateUI(false);
                });
            }
        }
        else if (request.action === 'room_users_update') {
            renderUserList(request.users);
        }
    });

    let currentRoomName = null;

    function updateVideoStatus(data) {
        if (data.type === 'seek') {
            elements.videoStatusText.textContent = 'Seek';
            elements.playStateIcon.textContent = '⌕';
        } else {
            elements.videoStatusText.textContent = data.type === 'play' ? 'Playing' : 'Paused';
            elements.playStateIcon.textContent = data.type === 'play' ? '⏸' : '▶';
        }
        elements.timeDisplay.textContent = formatTime(data.time);

        // Visual flair
        if (data.type === 'play') {
            elements.playStateIcon.style.textShadow = "0 0 10px rgba(16, 185, 129, 0.5)";
        } else if (data.type === 'seek') {
            elements.playStateIcon.style.textShadow = "0 0 10px rgba(99, 102, 241, 0.5)";
        } else {
            elements.playStateIcon.style.textShadow = "none";
        }
    }

    function updateUI(connected, room, username, isHost) {
        updateConnectionState(connected);

        if (connected) {
            currentRoomName = room;
            elements.roomDisplay.textContent = room;
            elements.usernameDisplay.textContent = username || 'Me';
            elements.roleDisplay.textContent = isHost ? 'HOST' : 'VIEWER';
            if (isHost) {
                elements.roleDisplay.style.background = 'rgba(16, 185, 129, 0.2)';
                elements.roleDisplay.style.color = '#34d399';
                elements.roleDisplay.style.borderColor = 'rgba(16, 185, 129, 0.3)';
            } else {
                elements.roleDisplay.style.background = 'rgba(99, 102, 241, 0.2)';
                elements.roleDisplay.style.color = '#818cf8';
                elements.roleDisplay.style.borderColor = 'rgba(99, 102, 241, 0.3)';
            }
            toggleScreen('dashboard');
        } else {
            toggleScreen('connect');
            elements.userList.innerHTML = '';
        }
    }
});
