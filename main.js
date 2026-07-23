const { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');
const path = require('path');
const DiscordRPC = require('discord-rpc');

let isQuitting = false;
let mainWindow;
let tray = null;
let currentPlayState = 'paused';
let currentSongInfo = null;
let rpc = null;
let rpcReady = false;
const discordClientId = '1529882204325412935';

const CONFIG = {
  pollIntervalMs: 2000,
  sessionCacheSize: 512 * 1024 * 1024,
  jsCallThrottleMs: 500,
};

let _lastJsCall = 0;
function throttledExecuteJS(script) {
  const now = Date.now();
  const elapsed = now - _lastJsCall;
  if (elapsed < CONFIG.jsCallThrottleMs) {
    return Promise.resolve(null);
  }
  _lastJsCall = now;
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  return mainWindow.webContents.executeJavaScript(script).catch(() => null);
}

let _pendingStatePoll = null;
function scheduleStatePoll() {
  if (_pendingStatePoll) return;
  _pendingStatePoll = setTimeout(() => {
    _pendingStatePoll = null;
    updatePlayPauseIcon();
    fetchSongInfo();
  }, CONFIG.pollIntervalMs);
}

function cancelStatePoll() {
  if (_pendingStatePoll) {
    clearTimeout(_pendingStatePoll);
    _pendingStatePoll = null;
  }
}

function playerCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const wasHidden = !mainWindow.isVisible();
  if (wasHidden) {
    mainWindow.show();
    mainWindow.focus();
  }

  mainWindow.webContents.executeJavaScript(`
    (function() {
      try {
        const video = document.querySelector('video');

        switch('${command}') {
          case 'playPause':
            if (video) { video.paused ? video.play() : video.pause(); return 'ok'; }
            return 'no-player-controls';
          case 'next':
            const nextBtns = document.querySelectorAll('[aria-label*="next" i], [aria-label*="Next" i], [title*="Next" i], [title*="next" i]');
            for (const btn of nextBtns) { if (btn.offsetParent !== null) { btn.click(); return 'ok'; } }
            if (video) { video.currentTime = video.duration; return 'ok'; }
            return 'no-controls';
          case 'previous':
            const prevBtns = document.querySelectorAll('[aria-label*="previous" i], [aria-label*="Previous" i], [title*="Previous" i], [title*="previous" i]');
            for (const btn of prevBtns) { if (btn.offsetParent !== null) { btn.click(); return 'ok'; } }
            if (video && video.currentTime > 3) { video.currentTime = 0; return 'ok'; }
            return 'no-controls';
          case 'shuffle':
            const shuffleBtns = document.querySelectorAll('[aria-label*="shuffle" i], [title*="shuffle" i]');
            for (const btn of shuffleBtns) { if (btn.offsetParent !== null) { btn.click(); return 'ok'; } }
            return 'no-shuffle-btn';
          case 'loop':
            const loopBtns = document.querySelectorAll('[aria-label*="repeat" i], [aria-label*="Repeat" i], [title*="repeat" i], [title*="Repeat" i]');
            for (const btn of loopBtns) { if (btn.offsetParent !== null) { btn.click(); return 'ok'; } }
            return 'no-loop-btn';
          default: return 'unknown';
        }
      } catch(e) { return 'error: ' + e.message; }
    })()
  `).then((result) => {
    if (command === 'playPause') {
      updatePlayPauseIcon();
    }
    if (wasHidden) {
      mainWindow.hide();
    }
  }).catch(() => {
    if (wasHidden) {
      mainWindow.hide();
    }
  });
}

function updateThumbarButtons() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const playIcon = currentPlayState === 'playing' ? iconPaused : iconPlay;
  const playTooltip = currentPlayState === 'playing' ? 'Pause' : 'Play';

  const thumbarButtons = [
    {
      tooltip: 'Previous',
      icon: iconPrevious,
      click: () => playerCommand('previous'),
    },
    {
      tooltip: playTooltip,
      icon: playIcon,
      click: () => playerCommand('playPause'),
    },
    {
      tooltip: 'Next',
      icon: iconNext,
      click: () => playerCommand('next'),
    },
  ];

  mainWindow.setThumbarButtons(thumbarButtons);
}

function updatePlayPauseIcon() {
  throttledExecuteJS(`
    (function() {
      const video = document.querySelector('video');
      return video ? video.paused : true;
    })()
  `).then((paused) => {
    if (paused === null) return;
    const newState = paused ? 'paused' : 'playing';
    if (newState === currentPlayState) return;
    currentPlayState = newState;
    updateThumbarButtons();
    updateTrayMenu();
    updateDiscordPresence();
  });
}

function fetchSongInfo() {
  throttledExecuteJS(`
    (function() {
      const video = document.querySelector('video');
      if (!video) return null;

      const titleEl = document.querySelector('.title.ytmusic-player-bar, .ytmusic-player-bar .title, ytmusic-player-bar .title, #song-title, .ytmusic-detail-header-renderer .title, ytmusic-detail-header-renderer .title, .content-info-wrapper .title, #layout .title, .middle-controls .ytmusic-player-bar .title');
      const bylineEl = document.querySelector('.byline.ytmusic-player-bar, .ytmusic-player-bar .byline, ytmusic-player-bar .byline, #byline, .ytmusic-detail-header-renderer .byline, ytmusic-detail-header-renderer .byline, .content-info-wrapper .byline, .subtitle.ytmusic-player-bar');

      const docTitle = document.title.replace(' | YouTube Music', '').replace(' - YouTube Music', '').trim();
      const pageNames = ['Home', 'Explore', 'Library', 'Search', 'Premium', 'Settings'];

      let title = docTitle || 'Unknown';
      if (titleEl) {
        const elTitle = titleEl.textContent.trim();
        if (elTitle && !pageNames.includes(elTitle) && elTitle !== 'YouTube Music') {
          title = elTitle;
        }
      }

      if (!title || title === 'YouTube Music') return null;

      let artist = 'Unknown';
      let album = '';
      if (bylineEl) {
        const links = bylineEl.querySelectorAll('a');
        if (links.length > 0) {
          artist = links[0].textContent.trim();
          if (links.length > 1) {
            album = links[1].textContent.trim();
          }
        } else {
          artist = bylineEl.textContent.trim();
        }
      }

      let thumbnailUrl = '';
      const imgEl = document.querySelector('.ytmusic-player-bar .image, ytmusic-player-bar .image, .ytmusic-player-bar img, ytmusic-player-bar img, #thumbnail img, .ytmusic-detail-header-renderer img');

      const currentTime = video.currentTime || 0;
      const duration = video.duration || 0;
      const paused = video.paused;

      return { title, artist, album, thumbnailUrl, currentTime, duration, paused };
    })()
  `).then((info) => {
    if (!info || !info.title) {
      if (currentSongInfo) {
        currentSongInfo = null;
        updateDiscordPresence();
      }
      return;
    }

    currentSongInfo = info;
    updateDiscordPresence();
  });
}

function updateDiscordPresence() {
  if (!rpcReady || !rpc) return;

  if (currentSongInfo && !currentSongInfo.paused) {
    const info = currentSongInfo;
    const endTime = Date.now() + Math.max(0, (info.duration - info.currentTime)) * 1000;

    rpc.setActivity({
      details: info.title.substring(0, 128),
      state: info.artist.substring(0, 128) + (info.album ? ' - ' + info.album.substring(0, 128) : ''),
      endTimestamp: endTime,
      largeImageKey: 'musicstation_logo',
      largeImageText: 'Musicstation',
      instance: false,
    }).catch(() => {});
  } else {
    rpc.setActivity({
      details: 'Idle',
      largeImageKey: 'musicstation_logo',
      largeImageText: 'Musicstation',
      instance: false,
    }).catch(() => {});
  }
}

function createWindow() {
  const ses = session.fromPartition('persist:musicstation', { cache: CONFIG.sessionCacheSize });
  ses.setProxy({ proxyRules: 'direct://' }).catch(() => {});

  ses.setCacheSizeLimit(CONFIG.sessionCacheSize).catch(() => {});
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'Musicstation',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: ses,
      backgroundThrottling: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    cancelStatePoll();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) => {
    blocker.enableBlockingInSession(mainWindow.webContents.session);
  });

  mainWindow.loadURL('https://music.youtube.com', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('Musicstation');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.setTitle('Musicstation');
    updateThumbarButtons();
    scheduleStatePoll();
  });

  mainWindow.on('show', () => {
    mainWindow.setTitle('Musicstation');
    updateThumbarButtons();
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error('empty icon');
  } catch {
    icon = nativeImage.createFromDataURL(iconFallbackDataUrl);
  }

  function tryCreateTray(retries = 3) {
    try {
      if (tray) {
        try { tray.destroy(); } catch (_) {}
        tray = null;
      }
      tray = new Tray(icon);
      tray.setToolTip('Musicstation');

      const contextMenu = Menu.buildFromTemplate([
        { label: 'Open', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { type: 'separator' },
        { label: 'Play/Pause', click: () => playerCommand('playPause') },
        { label: 'Next',        click: () => playerCommand('next') },
        { label: 'Previous',    click: () => playerCommand('previous') },
        { label: 'Shuffle',     click: () => playerCommand('shuffle') },
        { label: 'Loop',        click: () => playerCommand('loop') },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; mainWindow.destroy(); app.quit(); } },
      ]);

      tray.setContextMenu(contextMenu);
      tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
    } catch (err) {
      console.error('Tray creation failed:', err.message);
      if (retries > 0) {
        setTimeout(() => tryCreateTray(retries - 1), 500);
      }
    }
  }

  tryCreateTray(3);
}

function updateTrayMenu() {
  if (!tray) return;
  const isPlaying = currentPlayState === 'playing';
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: isPlaying ? 'Pause' : 'Play', click: () => playerCommand('playPause') },
    { label: 'Next',        click: () => playerCommand('next') },
    { label: 'Previous',    click: () => playerCommand('previous') },
    { label: 'Shuffle',     click: () => playerCommand('shuffle') },
    { label: 'Loop',        click: () => playerCommand('loop') },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; mainWindow.destroy(); app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function registerMediaShortcuts() {
  globalShortcut.register('MediaPlayPause',    () => playerCommand('playPause'));
  globalShortcut.register('MediaNextTrack',    () => playerCommand('next'));
  globalShortcut.register('MediaPreviousTrack', () => playerCommand('previous'));
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true });

  createWindow();
  createTray();
  registerMediaShortcuts();
  updateThumbarButtons();

  rpc = new DiscordRPC.Client({ transport: 'ipc' });

  rpc.on('ready', () => {
    rpcReady = true;
    updateDiscordPresence();
  });

  rpc.on('disconnected', () => {
    rpcReady = false;
  });

  rpc.login({ clientId: discordClientId }).catch((err) => {
    console.error('Discord RPC login failed:', err.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  cancelStatePoll();
  if (rpc) {
    rpc.destroy();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

const iconFallbackDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAONJREFUWEft1rENwyAQBdD/RWQM90xAR0dHZ4WMQMkIVJQMEZERKOkYgRGYgCWyZdlCXLhIan7r0/0n2Aa23c0dACIDByADAQkQEJCAgIAEBAQkICDgDwG2fR+Zz4hYRJSqakTEGJMiYtv3kfk4Ii4RcY6IU0Q8I+IZET/zWwAREVprV601zLPGGCzLgnVdYYzBuq6Y5xnLsmBd16+3CYAxBtu2YVkWTNOEaZowzzOstZjnGcYYWGvxX2BVhXMOzjk453B/HiklEEJgjAHvPaSUUEoBALz3cM7Be5+/xRgDAHjvYa1FRMAYAwB4Vbvv/U/9AuY0J1sn0+I2AAAAAElFTkSuQmCC';

function loadThumbarIcon(filename) {
  const img = nativeImage.createFromPath(path.join(__dirname, filename));
  return img.resize({ width: 32, height: 32 });
}

const iconPlay     = loadThumbarIcon('play.png');
const iconPaused  = loadThumbarIcon('paused.png');
const iconNext     = loadThumbarIcon('next.png');
const iconPrevious = loadThumbarIcon('prev.png');