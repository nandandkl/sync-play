// Shim for Socket.IO in Service Worker
const window = self;
const document = {
    createElement: function () { return { style: {} }; },
    body: { appendChild: function () { }, removeChild: function () { } },
    getElementsByTagName: function () { return []; },
    head: { appendChild: function () { }, removeChild: function () { } }
};
const navigator = self.navigator;
const location = self.location;

try {
    importScripts('socket.io.min.js');
} catch (e) {
    console.error("Failed to import socket.io:", e);
}

let socket = null;


const roomStates = new Map();

const tabSessions = new Map();


function ensureSocket() {
    if (socket && socket.connected) return;

    socket = io('https://sync-play-connect-production.up.railway.app', {
        transports: ['websocket'],
        reconnectionAttempts: 5
    });

    socket.on('connect', () => {
        console.log('Background: Socket Connected');
        // Re-join rooms for all active sessions
        for (const [tabId, session] of tabSessions) {
            socket.emit('join', {
                room: session.room,
                username: session.username,
                isHost: session.isHost
            });
        }
    });

    socket.on('connect_error', (err) => {
        console.warn('Background: Socket Connection Error:', err.message);
    });

    socket.on('state_change', (data) => {
        console.log("Background: Received state_change:", data);

        // 1. Cache the state
        if (data.room) {
            roomStates.set(data.room, {
                type: data.type,
                time: data.time,
                updatedAt: Date.now()
            });
        }

        // 2. Send to Content Scripts
        sendMessageToRoom(data.room, 'apply_state', data);

        // 3. Send to Popup (Runtime broadcast)
        chrome.runtime.sendMessage({
            action: 'apply_state',
            data: data
        }).catch(() => {
            // Popup might be closed, harmless
        });
    });

    socket.on('error', (data) => {
        console.log("Background: Received error:", data);
        // Broadcast error to all connected tabs (Popup will catch it)
        for (const tabId of tabSessions.keys()) {
            chrome.tabs.sendMessage(tabId, {
                action: 'socket_error',
                message: data.message
            }).catch(() => { });
        }
    });

    socket.on('room_users', (users) => {
        console.log("Background: Received room_users:", users);

        for (const [tabId, session] of tabSessions) {

            session.users = users;

            chrome.tabs.sendMessage(tabId, {
                action: 'room_users_update',
                users: users
            }).catch(() => { });
        }

        // Broadcast to Popup (Runtime)
        chrome.runtime.sendMessage({
            action: 'room_users_update',
            users: users
        }).catch(() => { });
    });

    socket.on('sync_req', (data) => {

        for (const [tabId, session] of tabSessions) {
            if (session.isHost) {
                chrome.tabs.sendMessage(tabId, {
                    action: 'get_time_for_sync',
                    data: { from: data.from }
                }).catch(() => { });
            }
        }
    });

    socket.on('sync_res', (status) => {

        for (const tabId of tabSessions.keys()) {
            chrome.tabs.sendMessage(tabId, {
                action: 'apply_state',
                data: { type: status.state, time: status.time }
            }).catch(() => { });
        }
    });
}


function connectTab(tabId, room, username, isHost) {
    if (!socket || !socket.connected) {
        ensureSocket();
    }

    return new Promise((resolve, reject) => {
        // defined listener to clean up later
        const onJoin = (data) => {
            if (data.room === room) {
                cleanup();
                // 1. Store Session on success
                tabSessions.set(tabId, { room, username, isHost });
                console.log(`Background: Tab ${tabId} joined ${room}`);
                resolve({ status: 'connected' });
            }
        };

        const onError = (data) => {
            cleanup();
            resolve({ status: 'error', message: data.message });
        };

        const cleanup = () => {
            socket.off('joined', onJoin);
            socket.off('error', onError);
        };

        socket.on('joined', onJoin);
        socket.on('error', onError);

        // Emit fail-safe timeout
        setTimeout(() => {
            cleanup();
            resolve({ status: 'error', message: 'Connection timeout' });
        }, 60000);

        // 2. Emit Join
        socket.emit('join', { room, username, isHost });
    });
}

function disconnectTab(tabId) {
    if (tabSessions.has(tabId)) {
        const session = tabSessions.get(tabId);
        console.log(`Background: Tab ${tabId} left ${session.room}`);

        // Notify server to remove this socket from the room
        if (socket && socket.connected) {
            socket.emit('leave', { room: session.room });
        }

        tabSessions.delete(tabId);

    }
}

function sendMessageToRoom(room, action, data) {
    for (const [tabId, session] of tabSessions) {
        if (session.room === room) {
            chrome.tabs.sendMessage(tabId, { action, data }).catch(() => {
                // Tab closed or error
                tabSessions.delete(tabId);
            });
        }
    }
}

// Keep connection alive
setInterval(() => {
    if (tabSessions.size > 0 && (!socket || !socket.connected)) {
        console.log("Background: Heartbeat - Reconnecting...");
        ensureSocket();
    }
}, 5000);



chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'connect') {
        const targetTabId = request.tabId;
        if (!targetTabId) return;

        connectTab(targetTabId, request.room, request.username, request.isHost)
            .then(response => sendResponse(response));

        return true; // Keep channel open for async response

    } else if (request.action === 'disconnect') {
        const targetTabId = request.tabId;
        disconnectTab(targetTabId);
        sendResponse({ status: 'disconnected' });

    } else if (request.action === 'get_status') {
        // Popup asks for status of *its* current tab
        const targetTabId = request.tabId;
        const session = tabSessions.get(targetTabId);

        let videoState = null;
        if (session && session.room) {
            videoState = roomStates.get(session.room);
        }

        sendResponse({
            connected: !!(session && socket && socket.connected),
            room: session ? session.room : null,
            username: session ? session.username : null,
            isHost: session ? session.isHost : false,
            users: session ? session.users : [],
            videoState: videoState
        });

    } else if (request.action === 'video_event') {
        const tabId = sender.tab ? sender.tab.id : null;
        if (!tabId || !tabSessions.has(tabId)) {
            sendResponse({ status: 'error', message: 'Not connected' });
            return;
        }

        const session = tabSessions.get(tabId);

        if (socket && socket.connected) {
            socket.emit('state_change', {
                room: session.room,
                type: request.type,
                time: request.time,
                from: request.from
            });
        }
        sendResponse({ status: 'ok' });

    } else if (request.action === 'sync_response') {
        if (socket && socket.connected) {
            socket.emit('sync_res', request.data);
        }
        sendResponse({ status: 'ok' });
    }
});

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
    disconnectTab(tabId);
});
