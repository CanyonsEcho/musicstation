# Musicstation

A lightweight Electron wrapper that turns YouTube Music into a standalone desktop app. It runs quietly in the background with system tray integration, global media keys, Discord Rich Presence, and a built-in ad blocker.

## Features

* **Native Window:** Runs the official YouTube Music web app in a dedicated window.
* **System Tray Integration:** Closing the window minimizes it to the tray. Play, pause, skip, shuffle, and loop directly from the tray right click menu.
* **Taskbar Controls:** Quick play/pause and skip buttons built right into the Windows taskbar preview window.
* **Discord Rich Presence:** Automatically shows what you're listening to (track title, artist, album, and time remaining) on your Discord profile.
* **Built-in Adblock:** Uses `@ghostery/adblocker-electron` to strip out ads and tracking scripts automatically.
* **Launch on Startup:** Automatically boots up when you log into Windows so your music is always ready.

---

## Getting Started

### Prerequisites

* [Node.js](https://nodejs.org/) (v18 or later recommended)
* npm (pre-installed with Node)

### Installation

Clone the repository, navigate into the project folder, and install the dependencies:

```bash
cd musicstation
npm install

```

### Running in Development

```bash
npm start

```

### Building the Installer

To package the app into a production-ready Windows NSIS installer (`.exe`), run:

```bash
npm run build

```

*This uses `electron-builder` under the hood. The installer will be generated inside the `dist/` directory.*

---

## Tech Stack

* [Electron](https://www.electronjs.org/) — App framework
* [@ghostery/adblocker-electron](https://www.npmjs.com/package/@ghostery/adblocker-electron) — Ad blocking
* [discord-rpc](https://www.npmjs.com/package/discord-rpc) — Discord profile status integration
* [electron-builder](https://www.electronjs.org/docs/latest/tutorial/electron-builder) — Packaging and distribution