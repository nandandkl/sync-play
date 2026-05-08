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
const tabFrames = new Map(); // tabId -> Set of frameIds


function ensureSocket() {
    const SERVER_URL = 'https://sync-play-connect.onrender.com';

    // If socket already exists, just ensure it's connecting/connected
    if (socket) {
        if (!socket.connected) {
            console.log('Background: Socket exists but not connected, ensuring connection...');
            socket.connect();
        }
        return;
    }

    console.log('Background: Initializing socket connection...');

    // Wake up the server (Render cold start)
    console.log('Background: Waking up server at', SERVER_URL);
    fetch(SERVER_URL).then(r => r.text()).then(text => {
        console.log('Background: Server wake-up response received');
    }).catch(err => {
        console.warn('Background: Server wake-up fetch failed (expected if sleeping):', err.message);
    });

    socket = io(SERVER_URL, {
        reconnectionAttempts: 10,
        reconnectionDelay: 2000,
        timeout: 20000, // 20s timeout for cold starts
        transports: ['websocket', 'polling']
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
            // After re-joining, viewers should request current state
            if (!session.isHost) {
                socket.emit('sync_req', session.room);
            }
        }
    });

    socket.on('connect_error', (err) => {
        console.warn('Background: Socket Connection Error:', err.message);
        console.error('Full Error Object:', err);
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
        console.log('Background: Received sync_req from server:', data);
        const room = data.room;
        let hostTabFound = false;
        for (const [tabId, session] of tabSessions) {
            if (session.isHost && session.room === room) {
                hostTabFound = true;
                console.log(`Background: Sending get_time_for_sync to host tab ${tabId}`);
                chrome.tabs.sendMessage(tabId, {
                    action: 'get_time_for_sync',
                    data: { from: data.from, room: room }
                }).catch((err) => {
                    console.error(`Background: Failed to send get_time_for_sync to tab ${tabId}:`, err.message);
                });
            }
        }
        if (!hostTabFound) {
            console.warn(`Background: Received sync_req for room ${room} but no host tab found here.`);
        }
    });

    socket.on('sync_res', (data) => {
        console.log('Background: Received sync_res from server:', data);
        const room = data.room;
        const status = data.status;

        sendMessageToRoom(room, 'apply_state', {
            type: status.state,
            time: status.time,
            room: room,
            from: 'sync_system'
        });
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
                console.log(`Background: Tab ${tabId} joined ${room} (isHost: ${isHost})`);

                // If we are a viewer joining, request initial state
                if (!isHost) {
                    console.log(`Background: Emitting sync_req for room: ${room}`);
                    socket.emit('sync_req', room);
                }

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
            const frames = tabFrames.get(tabId);
            if (frames) {
                for (const frameId of frames) {
                    chrome.tabs.sendMessage(tabId, { action, data }, { frameId: frameId }).catch(() => {
                        // Frame might be gone
                        frames.delete(frameId);
                    });
                }
            } else {
                // Fallback to top frame if no frames registered yet
                chrome.tabs.sendMessage(tabId, { action, data }).catch(() => { });
            }
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
        console.log(`Background: Forwarding video_event ${request.type} to server for room ${session.room}`);

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
            socket.emit('sync_res', {
                to: request.data.to,
                room: request.data.room,
                status: request.data.status
            });
        }
        sendResponse({ status: 'ok' });
    } else if (request.action === 'register_frame') {
        const tabId = sender.tab ? sender.tab.id : null;
        if (tabId) {
            if (!tabFrames.has(tabId)) tabFrames.set(tabId, new Set());
            tabFrames.get(tabId).add(sender.frameId);
            console.log(`Background: Registered frame ${sender.frameId} for tab ${tabId}`);
        }
        sendResponse({ status: 'ok' });
    }
});

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
    disconnectTab(tabId);
});
