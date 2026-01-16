
let videoElement = null;
let ignoreRemote = false;

console.log('SyncPlay Content Script Loaded (Enhanced)');



function findVideoRecursive(root) {
    if (!root) return null;

    // 1. Check current root
    let v = root.querySelector('video');
    if (v) return v;

    // 2. Check Shadow roots

    const all = root.querySelectorAll('*');
    for (let el of all) {
        if (el.shadowRoot) {
            v = findVideoRecursive(el.shadowRoot);
            if (v) return v;
        }
    }
    return null;
}

function findVideo() {
    return findVideoRecursive(document);
}

function checkVideoLikeness() {
    // If we have a video, checks if it's still good
    if (videoElement && !videoElement.isConnected) {
        console.log('SyncPlay: Video element disconnected');
        videoElement = null; // Detach
    }

    if (!videoElement) {
        const v = findVideo();
        if (v) {
            attachVideoListeners(v);
        }
    }
}

// 1. Mutation Observer for DOM changes
const observer = new MutationObserver((mutations) => {
    checkVideoLikeness();
});
observer.observe(document.body, { childList: true, subtree: true });

// 2. Polling interval (Backup for tricky SPAs or deep shadow DOM updates not triggering observer)
setInterval(checkVideoLikeness, 2000);

function attachVideoListeners(video) {
    if (videoElement === video) return;

    videoElement = video;
    console.log('SyncPlay: Attached to video', video);

    video.addEventListener('play', () => sendVideoEvent('play'));
    video.addEventListener('pause', () => sendVideoEvent('pause'));
    video.addEventListener('seeked', () => sendVideoEvent('seek'));
}

// Initial check
checkVideoLikeness();


const localId = Math.random().toString(36).substring(7); // Unique ID for this tab session

function sendVideoEvent(type) {
    if (ignoreRemote) {
        console.log(`SyncPlay: Ignoring local ${type} due to remote update`);
        return;
    }

    console.log(`SyncPlay: Local ${type} detected. Sending to background...`);

    if (videoElement) {
        if (!chrome.runtime?.id) {
            console.warn("SyncPlay: Extension context invalidated (Reload detected). stopping event.");
            return;
        }
        // Use callback to catch "Receiving end does not exist" or other async errors
        chrome.runtime.sendMessage({
            action: 'video_event',
            type: type,
            time: videoElement.currentTime,
            from: localId
        }, (response) => {
            if (chrome.runtime.lastError) {
                const msg = chrome.runtime.lastError.message;
                if (msg.includes("Extension context invalidated")) {
                    console.warn("SyncPlay: Extension reloaded. Refresh page to reconnect.");
                } else {
                    console.warn("SyncPlay: Message failed (Background sleeping?):", msg);
                }
            }
        });
    }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'apply_state') {
        const data = request.data;
        if (data && data.from === localId) {
            console.log("SyncPlay: Ignoring own state reflection (ID matched)");
            return;
        }

        if (videoElement) {
            applyRemoteState(data);
        }
    } else if (request.action === 'get_time_for_sync') {
        if (videoElement) {
            const status = {
                state: videoElement.paused ? 'pause' : 'play',
                time: videoElement.currentTime
            };
            chrome.runtime.sendMessage({
                action: 'sync_response',
                data: { to: request.data.from, status: status }
            }, () => {
                if (chrome.runtime.lastError) {
                    console.log("SyncPlay: Sync response failed", chrome.runtime.lastError.message);
                }
            });
        }
    }
    else if (request.action === 'get_video_status') {
        if (videoElement) {
            sendResponse({
                type: videoElement.paused ? 'pause' : 'play',
                time: videoElement.currentTime
            });
        } else {
            sendResponse(null);
        }
    }
});



function applyRemoteState(data) {
    ignoreRemote = true;

    console.log('SyncPlay: Applying remote state', data);

    const DRIFT_THRESHOLD = 0.5;
    if (Math.abs(videoElement.currentTime - data.time) > DRIFT_THRESHOLD) {
        console.log(`SyncPlay: Seek from ${videoElement.currentTime} to ${data.time}`);
        videoElement.currentTime = data.time;
    }

    if (data.type === 'play') {
        if (videoElement.paused) {
            videoElement.play().catch(e => console.error("Autoplay blocked:", e));
        }
    } else if (data.type === 'pause') {
        if (!videoElement.paused) {
            videoElement.pause();
        }
    }

    setTimeout(() => {
        ignoreRemote = false;
    }, 500);
}
