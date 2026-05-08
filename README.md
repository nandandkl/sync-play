# SyncPlay

SyncPlay is a browser extension that allows you to watch videos together in real-time by synchronizing playback across multiple browsers.

## Features

-   **Playback Sync**: Synchronizes play, pause, and seek events.
-   **HTML5 Video Support**: Works on websites using standard HTML5 `<video>` tags.
-   **Room System**: Join or create rooms using a simple Room Code.

## Interface

<p align="center">
  <img src="https://github.com/nandandkl/sync-play/blob/48f6b6e5bc9001bcbd248af236ca93c9a7b56501/icons/screenshot-1.png" width="40%">
  <img src="https://github.com/nandandkl/sync-play/blob/48f6b6e5bc9001bcbd248af236ca93c9a7b56501/icons/screenshot-2.png" width="40%">
</p>

## Installation (Developer Mode)

To install the extension manually:

1.  **Download** this `extension` folder.
2.  Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, or `brave://extensions`).
3.  Enable **Developer mode**.
4.  Click **Load unpacked** and select this `extension` folder.

## How to Use

1.  Go to a video site (e.g., YouTube).
2.  Click the SyncPlay extension icon.
3.  Enter a **Room Code**.
4.  Click **Join / Create Room**.
5.  Share the Room Code with others so they can join the same session.

## Technical Details

-   **Signaling Server**: The extension connects to `https://sync-play-connect.onrender.com` for real-time communication.
-   **Permissions**: Requires `activeTab`, `scripting`, and `storage` permissions to function.
