(() => {
  'use strict';

  // PRIVATE CLOUD ENDPOINTS
  const INDEX_BASE = 'https://cloud-db-studio-default-rtdb.firebaseio.com/onlymeted';
  const STORAGE_RELAY = 'https://only-me-ted.koirala57111.workers.dev';
  const STORAGE_CHANNEL = '-1003795582178';
  const STORAGE_KEY = '9082703821:AAEO2qIPOO7Y-iUN9-Lr41HjNG8I9zlM6nE';

  const SHARD_BYTES = 18 * 1024 * 1024;
  const PARALLEL_STREAMS = 3;
  const SESSION_KEY = 'onlymeted_session_v5';

  const ACCENT_THEMES = {
    indigo: { a1: '#6c8cff', a2: '#38e2c6' },
    emerald: { a1: '#10b981', a2: '#38bdf8' },
    violet: { a1: '#a855f7', a2: '#ec4899' },
    rose: { a1: '#fb7185', a2: '#f59e0b' },
    amber: { a1: '#f59e0b', a2: '#38e2c6' }
  };

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  let currentUser = null;
  let authMode = 'login';
  let itemsMap = {};
  let foldersMap = {};
  let directoryMap = {};
  let inboxMap = {};
  let userGroupsMap = {};

  let activeFilter = 'all';
  let activeFolder = 'all';
  let searchQuery = '';
  let socialSearch = '';
  let activeSocialTab = 'chats';

  // 1-on-1 DM state
  let activePeer = null;
  let activeRoomId = null;
  let threadMessages = {};
  let pendingReply = null;
  let pendingShareItem = null;

  // Group Vault Room state
  let activeGroupMeta = null;
  let activeGroupId = null;
  let groupMessages = {};
  let groupItems = {};
  let pendingGroupReply = null;
  let selectedGroupMembers = new Set();
  let selectedGroupColor = 'indigo';
  let selectedFolderColor = 'indigo';

  // Drop Link state
  let pendingDropId = new URLSearchParams(window.location.search).get('share');
  let activeDropRecord = null;
  let activeDropObjectUrl = null;
  let dropTargetItem = null;
  let selectedDropMode = 'public';
  let selectedDropExpiryMs = 0;
  let currentActiveDropId = null;

  // Live SSE Streams
  let inboxEventSource = null;
  let threadEventSource = null;
  let userGroupsEventSource = null;
  let groupMsgEventSource = null;
  let groupItemsEventSource = null;

  // Item Preview & Customization state
  let activeItem = null;
  let activeObjectUrl = null;
  let activePlainText = '';
  let activeDecryptedPass = '';
  let selectedCardAccent = 'default';
  let selectedTheme = 'indigo';
  let pendingAvatarData = undefined;
  let deleteConfirmArmed = false;
  let purgeConfirmArmed = false;
  let deleteAccountArmed = false;

  const $ = (id) => document.getElementById(id);

  function showToast(msg, ms = 2600) {
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = 'toast-pill';
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.2s ease';
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  function bindDivButton(el, handler) {
    if (!el) return;
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handler(e);
      }
    });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  function timeAgo(ts) {
    const diff = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function formatClock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function sanitizeKey(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  function generateId(prefix = '') {
    const core = `${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    return prefix ? `${prefix}_${core}` : core;
  }

  function getRoomId(userA, userB) {
    return [userA, userB].sort().join('__');
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // CLOUD INDEX TRANSPORT
  async function indexGet(path) {
    const res = await fetch(`${INDEX_BASE}/${path}.json`);
    if (!res.ok) throw new Error('Connection unavailable');
    return res.json();
  }

  async function indexPut(path, data) {
    const res = await fetch(`${INDEX_BASE}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Sync failed');
    return res.json();
  }

  async function indexPatch(path, data) {
    const res = await fetch(`${INDEX_BASE}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error('Update failed');
    return res.json();
  }

  async function indexDelete(path) {
    const res = await fetch(`${INDEX_BASE}/${path}.json`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
  }

  // LOCAL EDGE CACHE
  const edgeCache = {
    dbPromise: null,
    open() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('OnlyMeTedVaultCache', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('blobs');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this.dbPromise;
    },
    async get(key) {
      try {
        const db = await this.open();
        return await new Promise((resolve) => {
          const tx = db.transaction('blobs', 'readonly');
          const req = tx.objectStore('blobs').get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        const db = await this.open();
        await new Promise((resolve) => {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {}
    },
    async del(key) {
      try {
        const db = await this.open();
        await new Promise((resolve) => {
          const tx = db.transaction('blobs', 'readwrite');
          tx.objectStore('blobs').delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        });
      } catch {}
    }
  };

  // CRYPTOGRAPHY
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomHex(bytesLen = 16) {
    const arr = crypto.getRandomValues(new Uint8Array(bytesLen));
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  async function deriveAesKey(passphrase, saltBytes) {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 120000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptText(plainText, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt);
    const cipherBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plainText)
    );
    return JSON.stringify({
      s: arrayBufferToBase64(salt.buffer),
      i: arrayBufferToBase64(iv.buffer),
      c: arrayBufferToBase64(cipherBuf)
    });
  }

  async function decryptText(envelopeJson, passphrase) {
    const { s, i, c } = JSON.parse(envelopeJson);
    const salt = new Uint8Array(base64ToArrayBuffer(s));
    const iv = new Uint8Array(base64ToArrayBuffer(i));
    const cipher = base64ToArrayBuffer(c);
    const key = await deriveAesKey(passphrase, salt);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(plainBuf);
  }

  // STREAM COMPRESSION
  async function compressBuffer(arrayBuffer) {
    if (typeof CompressionStream === 'undefined') {
      return { buffer: arrayBuffer, compressed: false };
    }
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      writer.write(new Uint8Array(arrayBuffer));
      writer.close();
      const compressedBuf = await new Response(cs.readable).arrayBuffer();
      if (compressedBuf.byteLength < arrayBuffer.byteLength * 0.94) {
        return { buffer: compressedBuf, compressed: true };
      }
    } catch {}
    return { buffer: arrayBuffer, compressed: false };
  }

  async function decompressBuffer(arrayBuffer, wasCompressed) {
    if (!wasCompressed || typeof DecompressionStream === 'undefined') {
      return arrayBuffer;
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();
    return new Response(ds.readable).arrayBuffer();
  }

  // CLOUD BLOB RELAY & TELEGRAM CHAT LOGGER
  function relayHeaders() {
    return {
      'X-TG-Token': STORAGE_KEY,
      'X-TG-Chat': STORAGE_CHANNEL
    };
  }

  function logActivityToChannel(html, replyToMessageId = null) {
    fetch(`${STORAGE_RELAY}/log`, {
      method: 'POST',
      headers: { ...relayHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, replyToMessageId })
    }).catch(() => {});
  }

  function setTransferProgress(visible, title = '', pct = 0) {
    const banner = $('transferBanner');
    if (!visible) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    $('transferTitle').textContent = title;
    $('transferPct').textContent = `${Math.round(pct)}%`;
    $('transferFill').style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }

  async function uploadSingleShard(blobSlice, shardName, caption) {
    while (true) {
      const form = new FormData();
      form.append('document', blobSlice, shardName);
      form.append('caption', caption);

      const res = await fetch(`${STORAGE_RELAY}/upload`, {
        method: 'POST',
        headers: relayHeaders(),
        body: form
      });
      const data = await res.json();

      if (res.status === 429 && data.retryAfter) {
        await sleep((data.retryAfter + 1) * 1000);
        continue;
      }

      if (!res.ok || !data.ok) {
        throw new Error('Cloud storage transfer interrupted');
      }

      return {
        fileId: data.fileId,
        messageId: data.messageId,
        bytes: blobSlice.size
      };
    }
  }

  async function uploadBufferToCloud(itemId, rawBuffer, label) {
    setTransferProgress(true, `Preparing ${label}...`, 6);
    const { buffer, compressed } = await compressBuffer(rawBuffer);
    const totalBytes = buffer.byteLength;
    const totalShards = Math.max(1, Math.ceil(totalBytes / SHARD_BYTES));
    const shards = [];

    for (let idx = 0; idx < totalShards; idx++) {
      const start = idx * SHARD_BYTES;
      const end = Math.min(totalBytes, start + SHARD_BYTES);
      const slice = new Blob([buffer.slice(start, end)], { type: 'application/octet-stream' });
      const shardName = `${itemId}_p${idx + 1}.dat`;
      const ownerTag = currentUser ? `${currentUser.displayName || currentUser.handle} (@${currentUser.key})` : 'Guest';
      const caption = `${ownerTag} • ${label} [${idx + 1}/${totalShards}]`;

      setTransferProgress(
        true,
        `Uploading ${label} (${idx + 1}/${totalShards})...`,
        10 + (idx / totalShards) * 85
      );

      const shardRef = await uploadSingleShard(slice, shardName, caption);
      shards.push(shardRef);

      if (idx < totalShards - 1) await sleep(600);
    }

    return {
      compressed,
      storedBytes: totalBytes,
      shards
    };
  }

  async function downloadBufferFromCloud(meta, showGlobalBanner = true) {
    const cacheScope = currentUser ? currentUser.key : 'public_drop';
    const cacheKey = `${cacheScope}:${meta.id}`;
    const cached = await edgeCache.get(cacheKey);
    if (cached) return cached;

    const shards = meta.shards || meta.tgShards || [];
    if (!shards.length) throw new Error('File payload unavailable');

    let completed = 0;
    const buffers = new Array(shards.length);
    if (showGlobalBanner) setTransferProgress(true, `Loading ${meta.title}...`, 8);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_STREAMS, shards.length) }, async () => {
      while (cursor < shards.length) {
        const idx = cursor++;
        const shard = shards[idx];
        const res = await fetch(
          `${STORAGE_RELAY}/download?file_id=${encodeURIComponent(shard.fileId)}`,
          { headers: relayHeaders() }
        );
        if (!res.ok) throw new Error('Unable to retrieve file stream');
        buffers[idx] = await res.arrayBuffer();
        completed++;
        if (showGlobalBanner) {
          setTransferProgress(
            true,
            `Retrieving (${completed}/${shards.length})...`,
            10 + (completed / shards.length) * 85
          );
        }
      }
    });
    await Promise.all(workers);

    const joined = await new Blob(buffers).arrayBuffer();
    const rawBuf = await decompressBuffer(joined, meta.compressed);
    if (showGlobalBanner) setTransferProgress(false);

    await edgeCache.set(cacheKey, rawBuf);
    return rawBuf;
  }

  async function eraseRemoteShards(shards) {
    const messageIds = (shards || []).map((s) => s.messageId).filter(Boolean);
    if (!messageIds.length) return;
    fetch(`${STORAGE_RELAY}/delete`, {
      method: 'POST',
      headers: { ...relayHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds })
    }).catch(() => {});
  }

  // PUBLIC DIRECTORY & LIVE MEMBER COUNTER
  async function refreshDirectory() {
    try {
      const dir = await indexGet('directory');
      directoryMap = dir || {};
      updateMemberCountUI();
      if (!$('socialModal').classList.contains('hidden')) {
        renderPeopleDirectory();
      }
      return directoryMap;
    } catch {
      return directoryMap;
    }
  }

  function updateMemberCountUI() {
    const count = Object.keys(directoryMap).length;
    const authLabel = count === 1 ? '1 Member Joined' : `${count} Members Joined`;
    const topLabel = count === 1 ? '1 Member' : `${count} Members`;
    $('authMemberCount').textContent = authLabel;
    $('topMemberCount').textContent = topLabel;
    $('socialMemberSubtitle').textContent = `${count} active account${count === 1 ? '' : 's'}`;
  }

  async function publishPublicDirectoryEntry(userObj, isNewSignup = false) {
    const entry = {
      key: userObj.key,
      handle: userObj.handle,
      displayName: userObj.displayName || userObj.handle,
      bio: userObj.bio || '',
      avatarData: userObj.avatarData || '',
      theme: userObj.theme || 'indigo',
      joinedAt: userObj.joinedAt || Date.now(),
      lastSeen: Date.now()
    };
    await indexPut(`directory/${userObj.key}`, entry);
    directoryMap[userObj.key] = entry;
    updateMemberCountUI();

    if (isNewSignup) {
      const totalMembers = Object.keys(directoryMap).length;
      const html =
        `✨ <b>New Account Created</b>\n` +
        `👤 <b>${escapeHtml(entry.displayName)}</b> (<code>@${escapeHtml(entry.key)}</code>)\n` +
        `📊 Total Accounts: <b>${totalMembers}</b>`;
      logActivityToChannel(html);
    }
  }

  // THEME & PROFILE UI
  function applyTheme(themeKey) {
    const palette = ACCENT_THEMES[themeKey] || ACCENT_THEMES.indigo;
    selectedTheme = themeKey in ACCENT_THEMES ? themeKey : 'indigo';
    document.documentElement.style.setProperty('--accent', palette.a1);
    document.documentElement.style.setProperty('--accent-2', palette.a2);
  }

  function renderUserProfileHeader() {
    if (!currentUser) return;
    const label = currentUser.displayName || currentUser.handle || 'Only Me Ted';
    const initial = label.trim().charAt(0).toUpperCase() || 'T';
    $('headerGreeting').textContent = label;
    $('headerAvatarInitial').textContent = initial;

    if (currentUser.avatarData) {
      $('headerAvatarImg').src = currentUser.avatarData;
      $('headerAvatarImg').classList.remove('hidden');
      $('headerAvatarInitial').classList.add('hidden');
    } else {
      $('headerAvatarImg').classList.add('hidden');
      $('headerAvatarInitial').classList.remove('hidden');
    }
    applyTheme(currentUser.theme || 'indigo');
  }

  // DROP LINK RESOLUTION (PUBLIC & SECURE LINKS WITH EXPIRY)
  function clearShareUrlParam() {
    if (window.location.search.includes('share=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
    pendingDropId = null;
  }

  async function resolveIncomingDropLink(dropId) {
    try {
      const drop = await indexGet(`drops/${dropId}`);
      if (!drop || !drop.item) {
        showToast('This Drop Link does not exist or was revoked', 3800);
        clearShareUrlParam();
        return false;
      }
      if (drop.expiresAt && Date.now() > drop.expiresAt) {
        showToast('This Drop Link has expired', 3800);
        clearShareUrlParam();
        return false;
      }

      if (drop.mode === 'secure' && !currentUser) {
        $('authDropNoticeText').textContent =
          `🔐 Secure Drop Link from ${drop.ownerName || drop.ownerKey} — Sign in or create an account to view & download "${drop.item.title}".`;
        $('authDropNotice').classList.remove('hidden');
        return false;
      }

      openStandaloneDropViewer(drop);
      return true;
    } catch {
      showToast('Unable to open Drop Link right now');
      return false;
    }
  }

  async function openStandaloneDropViewer(drop) {
    activeDropRecord = drop;
    if (activeDropObjectUrl) {
      URL.revokeObjectURL(activeDropObjectUrl);
      activeDropObjectUrl = null;
    }

    $('authView').classList.add('hidden');
    $('appView').classList.add('hidden');
    $('dropViewerView').classList.remove('hidden');

    const isPublic = drop.mode !== 'secure';
    const expiryLabel = drop.expiresAt
      ? ` • Expires ${new Date(drop.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : ' • Permanent';

    $('dropViewerBadge').textContent = isPublic ? '🌐 PUBLIC DROP LINK' : '🔐 SECURE ACCOUNT DROP';
    $('dropViewerTitle').textContent = drop.item.title;
    $('dropViewerMeta').textContent =
      `Shared by ${drop.ownerName || drop.ownerKey} • ${formatBytes(drop.item.size || 0)}${expiryLabel}`;

    const viewport = $('dropViewerViewport');
    viewport.innerHTML = '<div class="muted-sub">Loading shared item from cloud...</div>';

    try {
      const item = drop.item;
      if (item.kind === 'link') {
        viewport.innerHTML = `
          <div style="text-align:center; display:flex; flex-direction:column; gap:14px; width:100%;">
            <div class="preview-text-box" style="text-align:center;">${escapeHtml(item.url)}</div>
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="pill-btn primary-pill" style="text-decoration:none; max-width:240px; margin:0 auto;">Open Link ↗</a>
          </div>
        `;
        return;
      }

      const rawBuf = await downloadBufferFromCloud(item, false);
      const mime = item.mime || 'application/octet-stream';
      const blob = new Blob([rawBuf], { type: mime });
      activeDropObjectUrl = URL.createObjectURL(blob);

      if (item.kind === 'note' || mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript')) {
        const txt = new TextDecoder().decode(rawBuf);
        viewport.innerHTML = `<div class="preview-text-box">${escapeHtml(txt)}</div>`;
      } else if (mime.startsWith('image/')) {
        viewport.innerHTML = `<img src="${activeDropObjectUrl}" alt="${escapeHtml(item.title)}" />`;
      } else if (mime.startsWith('video/')) {
        viewport.innerHTML = `<video src="${activeDropObjectUrl}" controls playsinline autoplay></video>`;
      } else if (mime.startsWith('audio/')) {
        viewport.innerHTML = `<audio src="${activeDropObjectUrl}" controls autoplay></audio>`;
      } else if (mime.includes('pdf')) {
        viewport.innerHTML = `<iframe src="${activeDropObjectUrl}" title="${escapeHtml(item.title)}"></iframe>`;
      } else {
        viewport.innerHTML = `
          <div style="text-align:center; display:flex; flex-direction:column; gap:12px;">
            <div style="font-size:40px;">📦</div>
            <div style="font-weight:700;">${escapeHtml(item.title)}</div>
            <div class="muted-sub">${formatBytes(item.size || 0)} • Ready to download</div>
          </div>
        `;
      }
    } catch (err) {
      viewport.innerHTML = `<div class="muted-sub">Unable to load shared item: ${escapeHtml(err.message)}</div>`;
    }
  }

  function downloadActiveDropItem() {
    if (!activeDropRecord?.item) return;
    const item = activeDropRecord.item;
    if (item.kind === 'link') {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!activeDropObjectUrl) {
      showToast('Please wait for item to finish loading');
      return;
    }
    const a = document.createElement('a');
    a.href = activeDropObjectUrl;
    a.download = item.kind === 'note' ? `${item.title}.txt` : item.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Download started');
  }

  async function saveActiveDropToMyVault() {
    if (!activeDropRecord?.item) return;
    if (!currentUser) {
      $('dropViewerView').classList.add('hidden');
      $('authDropNoticeText').textContent =
        `Sign in or create a free account to save "${activeDropRecord.item.title}" into your personal vault.`;
      $('authDropNotice').classList.remove('hidden');
      $('authView').classList.remove('hidden');
      return;
    }
    await cloneSharedAttachmentToVault(activeDropRecord.item, 'Shared Drops');
  }

  // AUTHENTICATION FLOW
  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabSignup').classList.toggle('active', mode === 'signup');
    $('confirmWrap').classList.toggle('hidden', mode === 'login');
    $('authSubmitLabel').textContent = mode === 'login' ? 'Sign In' : 'Create Unlimited Account';
  }

  async function handleAuthSubmit() {
    const handle = $('authUsername').value.trim();
    const key = sanitizeKey(handle);
    const pass = $('authPassword').value;
    const confirm = $('authConfirm').value;

    if (key.length < 3) {
      showToast('Username must be at least 3 letters or numbers');
      return;
    }
    if (pass.length < 4) {
      showToast('Password must be at least 4 characters');
      return;
    }

    $('authSubmitLabel').textContent = 'Connecting...';
    try {
      const existing = await indexGet(`users/${key}`);
      if (authMode === 'signup') {
        if (existing) {
          showToast('Username already taken');
          setAuthMode('login');
          return;
        }
        if (pass !== confirm) {
          showToast('Passwords do not match');
          setAuthMode('signup');
          return;
        }
        const salt = randomHex(16);
        const hash = await sha256Hex(`${salt}:${pass}`);
        const now = Date.now();
        const profile = {
          handle,
          displayName: handle,
          bio: 'Personal unlimited cloud vault',
          theme: 'indigo',
          avatarData: '',
          salt,
          hash,
          createdAt: now
        };
        await indexPut(`users/${key}`, profile);
        currentUser = {
          key,
          handle,
          displayName: profile.displayName,
          bio: profile.bio,
          theme: profile.theme,
          avatarData: '',
          joinedAt: now
        };
        await refreshDirectory();
        await publishPublicDirectoryEntry(currentUser, true);
        showToast('Account created');
      } else {
        if (!existing) {
          showToast('Account not found — create one first');
          setAuthMode('signup');
          return;
        }
        const hash = await sha256Hex(`${existing.salt}:${pass}`);
        if (hash !== existing.hash) {
          showToast('Incorrect password');
          setAuthMode('login');
          return;
        }
        currentUser = {
          key,
          handle: existing.handle || handle,
          displayName: existing.displayName || existing.handle || handle,
          bio: existing.bio || '',
          theme: existing.theme || 'indigo',
          avatarData: existing.avatarData || '',
          joinedAt: existing.createdAt || Date.now()
        };
        publishPublicDirectoryEntry(currentUser, false).catch(() => {});
      }

      localStorage.setItem(SESSION_KEY, JSON.stringify({ key: currentUser.key, handle: currentUser.handle }));
      $('authDropNotice').classList.add('hidden');
      enterWorkspace();

      if (pendingDropId) {
        await resolveIncomingDropLink(pendingDropId);
      }
    } catch (err) {
      showToast(err.message || 'Unable to sign in');
      setAuthMode(authMode);
    }
  }

  function enterWorkspace() {
    $('dropViewerView').classList.add('hidden');
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    renderUserProfileHeader();
    syncVault(true);
    startInboxStream();
    startUserGroupsStream();
  }

  function stopSocialStreams() {
    [
      inboxEventSource,
      threadEventSource,
      userGroupsEventSource,
      groupMsgEventSource,
      groupItemsEventSource
    ].forEach((es) => {
      if (es) es.close();
    });
    inboxEventSource = null;
    threadEventSource = null;
    userGroupsEventSource = null;
    groupMsgEventSource = null;
    groupItemsEventSource = null;
  }

  function signOut() {
    stopSocialStreams();
    currentUser = null;
    itemsMap = {};
    foldersMap = {};
    inboxMap = {};
    userGroupsMap = {};
    activePeer = null;
    activeRoomId = null;
    activeGroupId = null;
    activeGroupMeta = null;
    localStorage.removeItem(SESSION_KEY);
    applyTheme('indigo');
    $('appView').classList.add('hidden');
    $('dropViewerView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('authPassword').value = '';
    setAuthMode('login');
    refreshDirectory();
    showToast('Signed out');
  }

  // FOLDERS & VAULT SYNC / RENDER
  async function syncVault(silent = false) {
    if (!currentUser) return;
    try {
      const [metaData, savedFolders, profileData] = await Promise.all([
        indexGet(`vault/${currentUser.key}/meta`),
        indexGet(`vault/${currentUser.key}/folders`),
        indexGet(`users/${currentUser.key}`),
        refreshDirectory()
      ]);
      itemsMap = metaData || {};
      foldersMap = savedFolders || {};
      if (profileData) {
        currentUser.displayName = profileData.displayName || currentUser.handle;
        currentUser.bio = profileData.bio || '';
        currentUser.theme = profileData.theme || 'indigo';
        currentUser.avatarData = profileData.avatarData || '';
        currentUser.joinedAt = profileData.createdAt || currentUser.joinedAt;
        renderUserProfileHeader();
        publishPublicDirectoryEntry(currentUser, false).catch(() => {});
      }
      renderVault();
      if (!silent) showToast('Vault & community synced');
    } catch {
      showToast('Could not refresh right now');
    }
  }

  function getAllFolderNames() {
    const names = new Set(['General']);
    Object.values(foldersMap).forEach((f) => {
      if (f && f.name) names.add(f.name.trim());
    });
    Object.values(itemsMap).forEach((it) => {
      if (it && it.folder) names.add(it.folder.trim());
    });
    return Array.from(names).filter(Boolean).sort((a, b) => {
      if (a === 'General') return -1;
      if (b === 'General') return 1;
      return a.localeCompare(b);
    });
  }

  function populateFolderSelect(selectEl, preferredFolder = 'General') {
    if (!selectEl) return;
    const folders = getAllFolderNames();
    selectEl.innerHTML = '';
    folders.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `📂 ${name}`;
      if (name === preferredFolder) opt.selected = true;
      selectEl.appendChild(opt);
    });
  }

  function openCreateFolderModal() {
    $('newFolderNameInput').value = '';
    selectedFolderColor = 'indigo';
    document.querySelectorAll('#folderColorPicker .swatch-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.fcolor === 'indigo');
    });
    $('folderModal').classList.remove('hidden');
    setTimeout(() => $('newFolderNameInput').focus(), 60);
  }

  async function submitCreateFolder() {
    if (!currentUser) return;
    const raw = $('newFolderNameInput').value.trim().replace(/[.#$/[\]]/g, '');
    if (!raw) {
      showToast('Enter a folder name');
      return;
    }
    const key = sanitizeKey(raw) || generateId('fld');
    const folderObj = {
      id: key,
      name: raw,
      color: selectedFolderColor,
      createdAt: Date.now()
    };
    try {
      await indexPut(`vault/${currentUser.key}/folders/${key}`, folderObj);
      foldersMap[key] = folderObj;
      activeFolder = raw;
      $('folderModal').classList.add('hidden');
      renderVault();
      populateFolderSelect($('itemFolderSelect'), raw);
      populateFolderSelect($('editItemFolderSelect'), raw);
      showToast(`Folder "${raw}" created`);
    } catch {
      showToast('Could not create folder');
    }
  }

  function getCategoryIcon(item) {
    if (item.encrypted) return '🔒';
    if (item.kind === 'link') return '⛓';
    if (item.kind === 'note') return '✎';
    const mime = item.mime || '';
    if (mime.startsWith('image/')) return '🖼';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    if (mime.includes('pdf')) return '📄';
    if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return '📦';
    return '📁';
  }

  function renderFolderChips(allItems) {
    const folders = getAllFolderNames();
    const bar = $('folderBar');
    bar.innerHTML = '';

    const allChip = document.createElement('div');
    allChip.className = `filter-chip folder-chip ${activeFolder === 'all' ? 'active' : ''}`;
    allChip.textContent = `All Folders (${allItems.length})`;
    bindDivButton(allChip, () => {
      activeFolder = 'all';
      renderVault();
    });
    bar.appendChild(allChip);

    folders.forEach((folder) => {
      const count = allItems.filter((it) => (it.folder || 'General').trim() === folder).length;
      const chip = document.createElement('div');
      chip.className = `filter-chip folder-chip ${activeFolder === folder ? 'active' : ''}`;
      chip.textContent = `📂 ${folder} (${count})`;
      bindDivButton(chip, () => {
        activeFolder = folder;
        renderVault();
      });
      bar.appendChild(chip);
    });

    const addChip = document.createElement('div');
    addChip.className = 'filter-chip folder-chip new-folder-chip';
    addChip.textContent = '＋ New Folder';
    bindDivButton(addChip, openCreateFolderModal);
    bar.appendChild(addChip);
  }

  function matchesFilter(item) {
    const itemFolder = (item.folder || 'General').trim();
    if (activeFolder !== 'all' && itemFolder !== activeFolder) return false;

    if (activeFilter === 'pinned' && !item.pinned) return false;
    if (activeFilter === 'locked' && !item.encrypted) return false;
    if (activeFilter === 'note' && item.kind !== 'note') return false;
    if (activeFilter === 'link' && item.kind !== 'link') return false;
    if (activeFilter === 'file' && item.kind !== 'file') return false;
    if (activeFilter === 'media') {
      const m = item.mime || '';
      if (!m.startsWith('image/') && !m.startsWith('video/') && !m.startsWith('audio/')) return false;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const hay = `${item.title || ''} ${item.snippet || ''} ${itemFolder} ${(item.tags || []).join(' ')} ${item.mime || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderVault() {
    const allItems = Object.values(itemsMap);
    const totalStoredBytes = allItems.reduce((acc, it) => acc + (it.size || 0), 0);

    $('vaultStats').textContent =
      `${allItems.length} item${allItems.length === 1 ? '' : 's'} • ${formatBytes(totalStoredBytes)} stored • ∞ Unlimited`;

    renderFolderChips(allItems);

    const filtered = allItems
      .filter(matchesFilter)
      .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((b.createdAt || 0) - (a.createdAt || 0)));

    const grid = $('vaultGrid');
    grid.innerHTML = '';
    $('emptyState').classList.toggle('hidden', filtered.length > 0);

    filtered.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'vault-item';
      if (item.accent && item.accent !== 'default') {
        card.dataset.accent = item.accent;
      }
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      const folderLabel = (item.folder || '').trim();
      const tagsHtml = (item.tags || [])
        .slice(0, 2)
        .map((t) => `<span class="mini-tag">#${escapeHtml(t)}</span>`)
        .join('');

      card.innerHTML = `
        <div>
          <div class="item-top">
            <div class="item-badge">${getCategoryIcon(item)}</div>
            <div class="item-badges-right">
              ${item.pinned ? '<span class="mini-tag pin">★</span>' : ''}
              ${item.encrypted ? '<span class="mini-tag lock">LOCKED</span>' : ''}
              ${folderLabel && folderLabel !== 'General' ? `<span class="mini-tag folder">📂 ${escapeHtml(folderLabel)}</span>` : ''}
              ${tagsHtml}
            </div>
          </div>
          <div class="item-title" style="margin-top:10px;">${escapeHtml(item.title || 'Untitled')}</div>
          <div class="item-snippet" style="margin-top:5px;">${escapeHtml(item.snippet || item.mime || '')}</div>
        </div>
        <div class="item-foot">
          <span>${formatBytes(item.size || 0)}</span>
          <span>${timeAgo(item.createdAt || Date.now())}</span>
        </div>
      `;

      bindDivButton(card, () => openPreview(item));
      grid.appendChild(card);
    });
  }

  // DROP LINK GENERATOR (PUBLIC VS SECURE + EXPIRY)
  function openDropLinkModal(item) {
    if (!item || !currentUser) return;
    if (item.encrypted) {
      showToast('Encrypted notes cannot be shared via Drop Link');
      return;
    }
    dropTargetItem = item;
    currentActiveDropId = null;
    selectedDropMode = 'public';
    selectedDropExpiryMs = 0;

    $('dropTargetTitle').textContent = `${item.title} (${formatBytes(item.size || 0)})`;
    $('dropModePublicBtn').classList.add('active');
    $('dropModeSecureBtn').classList.remove('active');
    $('dropModeHint').textContent = 'Anyone with this link can view & download immediately — no account needed.';
    document.querySelectorAll('#dropExpiryRow .capsule-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.expiry === '0');
    });
    $('dropResultBox').classList.add('hidden');
    $('dropLinkModal').classList.remove('hidden');
  }

  async function generateDropLink() {
    if (!dropTargetItem || !currentUser) return;
    const dropId = generateId('drop');
    const now = Date.now();
    const expiresAt = selectedDropExpiryMs > 0 ? now + selectedDropExpiryMs : null;
    const ownerName = currentUser.displayName || currentUser.handle;

    // Mark source item as sharedRef so deleting it later preserves active Drop Links
    if (!dropTargetItem.sharedRef && itemsMap[dropTargetItem.id]) {
      itemsMap[dropTargetItem.id].sharedRef = true;
      indexPatch(`vault/${currentUser.key}/meta/${dropTargetItem.id}`, { sharedRef: true }).catch(() => {});
    }

    const payload = {
      id: dropId,
      mode: selectedDropMode,
      expiresAt,
      createdAt: now,
      ownerKey: currentUser.key,
      ownerName,
      item: {
        id: dropTargetItem.id,
        kind: dropTargetItem.kind,
        title: dropTargetItem.title,
        mime: dropTargetItem.mime || 'application/octet-stream',
        size: dropTargetItem.size || 0,
        compressed: Boolean(dropTargetItem.compressed),
        shards: dropTargetItem.shards || dropTargetItem.tgShards || [],
        url: dropTargetItem.url || ''
      }
    };

    try {
      await indexPut(`drops/${dropId}`, payload);
      currentActiveDropId = dropId;
      const shareUrl = `${window.location.origin}${window.location.pathname}?share=${encodeURIComponent(dropId)}`;

      $('dropGeneratedUrl').value = shareUrl;
      $('dropActiveStatus').textContent =
        `${selectedDropMode === 'public' ? '🌐 PUBLIC' : '🔐 SECURE'}${expiresAt ? ' • EXPIRING' : ''}`;
      $('dropResultBox').classList.remove('hidden');

      try {
        await navigator.clipboard.writeText(shareUrl);
        showToast('Drop Link generated & copied!');
      } catch {
        showToast('Drop Link generated!');
      }

      const modeBadge = selectedDropMode === 'public' ? '🌐 Public Share (No Account Needed)' : '🔐 Secure Share (Account Required)';
      const expText = expiresAt ? new Date(expiresAt).toLocaleString() : 'Never';
      logActivityToChannel(
        `🔗 <b>${escapeHtml(ownerName)}</b> created a Drop Link\n` +
        `📄 <b>${escapeHtml(dropTargetItem.title)}</b> (${formatBytes(dropTargetItem.size || 0)})\n` +
        `🛡 ${modeBadge} • Expires: <code>${escapeHtml(expText)}</code>`
      );
    } catch {
      showToast('Could not generate Drop Link');
    }
  }

  async function revokeActiveDropLink() {
    if (!currentActiveDropId) return;
    try {
      await indexDelete(`drops/${currentActiveDropId}`);
      currentActiveDropId = null;
      $('dropResultBox').classList.add('hidden');
      showToast('Drop Link revoked');
    } catch {
      showToast('Could not revoke link');
    }
  }

  // REAL-TIME SSE PATCH HELPER
  function applySsePatch(targetObj, path, data) {
    if (path === '/' || !path) {
      Object.keys(targetObj).forEach((k) => delete targetObj[k]);
      if (data && typeof data === 'object') Object.assign(targetObj, data);
      return;
    }
    const parts = path.split('/').filter(Boolean);
    let ref = targetObj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!ref[parts[i]] || typeof ref[parts[i]] !== 'object') ref[parts[i]] = {};
      ref = ref[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (data === null) {
      delete ref[leaf];
    } else if (typeof data === 'object' && !Array.isArray(data) && ref[leaf] && typeof ref[leaf] === 'object') {
      Object.assign(ref[leaf], data);
    } else {
      ref[leaf] = data;
    }
  }

  // REAL-TIME 1-ON-1 DIRECT MESSAGING
  function startInboxStream() {
    if (!currentUser) return;
    if (inboxEventSource) inboxEventSource.close();

    const url = `${INDEX_BASE}/inbox/${currentUser.key}.json`;
    inboxEventSource = new EventSource(url);

    const handleEvent = (e) => {
      try {
        const packet = JSON.parse(e.data);
        applySsePatch(inboxMap, packet.path, packet.data);
        updateUnreadBadges();
        if (!$('socialModal').classList.contains('hidden') && !$('socialHubView').classList.contains('hidden')) {
          renderInboxList();
        }
      } catch {}
    };

    inboxEventSource.addEventListener('put', handleEvent);
    inboxEventSource.addEventListener('patch', handleEvent);
  }

  function startUserGroupsStream() {
    if (!currentUser) return;
    if (userGroupsEventSource) userGroupsEventSource.close();

    const url = `${INDEX_BASE}/userGroups/${currentUser.key}.json`;
    userGroupsEventSource = new EventSource(url);

    const handleEvent = (e) => {
      try {
        const packet = JSON.parse(e.data);
        applySsePatch(userGroupsMap, packet.path, packet.data);
        updateUnreadBadges();
        if (!$('socialModal').classList.contains('hidden') && !$('socialHubView').classList.contains('hidden')) {
          renderGroupVaultList();
        }
      } catch {}
    };

    userGroupsEventSource.addEventListener('put', handleEvent);
    userGroupsEventSource.addEventListener('patch', handleEvent);
  }

  function updateUnreadBadges() {
    const dmUnread = Object.values(inboxMap).reduce((sum, conv) => sum + (Number(conv.unreadCount) || 0), 0);
    const grpUnread = Object.values(userGroupsMap).reduce((sum, g) => sum + (Number(g.unreadCount) || 0), 0);
    const totalUnread = dmUnread + grpUnread;

    ['unreadTotalBadge', 'dockUnreadBadge'].forEach((id) => {
      const badge = $(id);
      if (totalUnread > 0) {
        badge.textContent = totalUnread > 99 ? '99+' : String(totalUnread);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    });
  }

  function closeSocialSubstreams() {
    if (threadEventSource) {
      threadEventSource.close();
      threadEventSource = null;
    }
    if (groupMsgEventSource) {
      groupMsgEventSource.close();
      groupMsgEventSource = null;
    }
    if (groupItemsEventSource) {
      groupItemsEventSource.close();
      groupItemsEventSource = null;
    }
  }

  function openSocialHub(tab = 'chats', preselectShareItem = null) {
    pendingShareItem = preselectShareItem;
    closeSocialSubstreams();
    activePeer = null;
    activeRoomId = null;
    activeGroupId = null;
    activeGroupMeta = null;

    $('socialModal').classList.remove('hidden');
    $('chatThreadView').classList.add('hidden');
    $('createGroupView').classList.add('hidden');
    $('groupRoomView').classList.add('hidden');
    $('socialHubView').classList.remove('hidden');

    if (pendingShareItem) {
      showToast(`Choose a person to send "${pendingShareItem.title}"`);
      switchSocialTab('people');
    } else {
      switchSocialTab(tab);
    }
    refreshDirectory();
  }

  function switchSocialTab(tab) {
    activeSocialTab = tab;
    $('tabSocialChats').classList.toggle('active', tab === 'chats');
    $('tabSocialGroups').classList.toggle('active', tab === 'groups');
    $('tabSocialPeople').classList.toggle('active', tab === 'people');

    $('inboxListPane').classList.toggle('hidden', tab !== 'chats');
    $('groupsListPane').classList.toggle('hidden', tab !== 'groups');
    $('peopleListPane').classList.toggle('hidden', tab !== 'people');

    if (tab === 'chats') renderInboxList();
    else if (tab === 'groups') renderGroupVaultList();
    else renderPeopleDirectory();
  }

  function renderAvatarHtml(person, extraClass = '') {
    const name = person.displayName || person.peerName || person.handle || 'U';
    const initial = name.charAt(0).toUpperCase();
    const avatar = person.avatarData || person.peerAvatar || '';
    if (avatar) {
      return `<div class="avatar-trigger ${extraClass}"><img class="avatar-img" src="${avatar}" alt="" /></div>`;
    }
    return `<div class="avatar-trigger ${extraClass}"><span>${escapeHtml(initial)}</span></div>`;
  }

  function renderInboxList() {
    const list = $('inboxListPane');
    const q = socialSearch.toLowerCase();
    const convs = Object.values(inboxMap)
      .filter((c) => {
        if (!q) return true;
        return `${c.peerName || ''} ${c.peerKey || ''} ${c.lastText || ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

    if (!convs.length) {
      list.innerHTML = `<div class="empty-state"><p>No direct messages yet. Switch to <strong>All People</strong> to message anyone.</p></div>`;
      return;
    }

    list.innerHTML = '';
    convs.forEach((conv) => {
      const peerObj = directoryMap[conv.peerKey] || {
        key: conv.peerKey,
        handle: conv.peerKey,
        displayName: conv.peerName || conv.peerKey,
        avatarData: conv.peerAvatar || ''
      };
      const row = document.createElement('div');
      row.className = 'person-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');

      const unread = Number(conv.unreadCount) || 0;
      row.innerHTML = `
        <div class="person-left">
          ${renderAvatarHtml(peerObj, 'small-avatar')}
          <div class="person-meta">
            <div class="person-name-line">${escapeHtml(peerObj.displayName || peerObj.key)}</div>
            <div class="person-sub">${escapeHtml(conv.lastText || 'Start chatting')}</div>
          </div>
        </div>
        <div class="person-right">
          <span style="font-size:10px; color:var(--text-muted);">${conv.lastAt ? timeAgo(conv.lastAt) : ''}</span>
          ${unread > 0 ? `<span class="mini-tag" style="background:var(--danger); color:#fff;">${unread}</span>` : ''}
        </div>
      `;
      bindDivButton(row, () => openConversation(peerObj));
      list.appendChild(row);
    });
  }

  function renderPeopleDirectory() {
    const list = $('peopleListPane');
    const q = socialSearch.toLowerCase();
    const people = Object.values(directoryMap)
      .filter((p) => p.key !== currentUser.key)
      .filter((p) => {
        if (!q) return true;
        return `${p.displayName || ''} ${p.key || ''} ${p.bio || ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

    if (!people.length) {
      list.innerHTML = `<div class="empty-state"><p>No other members found yet. Share Only Me Ted with friends so they can join!</p></div>`;
      return;
    }

    list.innerHTML = '';
    people.forEach((person) => {
      const row = document.createElement('div');
      row.className = 'person-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.innerHTML = `
        <div class="person-left">
          ${renderAvatarHtml(person, 'small-avatar')}
          <div class="person-meta">
            <div class="person-name-line">
              <span>${escapeHtml(person.displayName || person.handle)}</span>
              <span style="font-size:11px; color:var(--text-muted); font-weight:500;">@${escapeHtml(person.key)}</span>
            </div>
            <div class="person-sub">${escapeHtml(person.bio || 'Unlimited Cloud Member')}</div>
          </div>
        </div>
        <div class="person-right">
          <span class="pill-btn primary-pill compact-pill">${pendingShareItem ? 'Send Here' : 'Message'}</span>
        </div>
      `;
      bindDivButton(row, () => openConversation(person));
      list.appendChild(row);
    });
  }

  async function openConversation(peer) {
    activePeer = peer;
    activeRoomId = getRoomId(currentUser.key, peer.key);
    threadMessages = {};
    pendingReply = null;
    $('replyQuoteBar').classList.add('hidden');
    $('chatVaultPicker').classList.add('hidden');

    $('socialHubView').classList.add('hidden');
    $('chatThreadView').classList.remove('hidden');

    const peerName = peer.displayName || peer.handle || peer.key;
    $('threadPeerName').textContent = peerName;
    $('threadPeerSub').textContent = `@${peer.key}${peer.bio ? ` • ${peer.bio}` : ''}`;
    $('threadPeerInitial').textContent = peerName.charAt(0).toUpperCase();

    if (peer.avatarData) {
      $('threadPeerAvatarImg').src = peer.avatarData;
      $('threadPeerAvatarImg').classList.remove('hidden');
      $('threadPeerInitial').classList.add('hidden');
    } else {
      $('threadPeerAvatarImg').classList.add('hidden');
      $('threadPeerInitial').classList.remove('hidden');
    }

    if (inboxMap[peer.key]?.unreadCount) {
      inboxMap[peer.key].unreadCount = 0;
      updateUnreadBadges();
      indexPatch(`inbox/${currentUser.key}/${peer.key}`, { unreadCount: 0 }).catch(() => {});
    }

    if (threadEventSource) threadEventSource.close();
    const msgUrl = `${INDEX_BASE}/dms/${activeRoomId}/messages.json`;
    threadEventSource = new EventSource(msgUrl);

    const onMsgEvent = (e) => {
      try {
        const packet = JSON.parse(e.data);
        applySsePatch(threadMessages, packet.path, packet.data);
        renderThreadMessages();
        if (inboxMap[peer.key]?.unreadCount) {
          inboxMap[peer.key].unreadCount = 0;
          updateUnreadBadges();
          indexPatch(`inbox/${currentUser.key}/${peer.key}`, { unreadCount: 0 }).catch(() => {});
        }
      } catch {}
    };

    threadEventSource.addEventListener('put', onMsgEvent);
    threadEventSource.addEventListener('patch', onMsgEvent);

    if (pendingShareItem) {
      const itemToShare = pendingShareItem;
      pendingShareItem = null;
      await sendSharedVaultItemInChat(itemToShare);
    }
  }

  function renderThreadMessages() {
    const stream = $('chatMessagesStream');
    const msgs = Object.values(threadMessages).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (!msgs.length) {
      stream.innerHTML = `<div class="empty-state"><p>Say hello or share any file from your vault with <strong>${escapeHtml(activePeer?.displayName || activePeer?.key || '')}</strong>.</p></div>`;
      return;
    }

    stream.innerHTML = '';
    msgs.forEach((m) => {
      const isMine = m.from === currentUser.key;
      const row = document.createElement('div');
      row.className = `msg-row ${isMine ? 'mine' : 'theirs'}`;

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      if (m.replyTo) {
        const qDiv = document.createElement('div');
        qDiv.className = 'msg-quote';
        qDiv.innerHTML = `<strong>${escapeHtml(m.replyTo.author)}</strong>: ${escapeHtml(m.replyTo.text)}`;
        bubble.appendChild(qDiv);
      }

      if (m.text) {
        const tDiv = document.createElement('div');
        tDiv.textContent = m.text;
        bubble.appendChild(tDiv);
      }

      if (m.attachment) {
        const att = m.attachment;
        const attBox = document.createElement('div');
        attBox.className = 'msg-attachment';
        attBox.innerHTML = `
          <div class="att-top">
            <span style="font-size:22px;">${getCategoryIcon(att)}</span>
            <div>
              <div class="att-title">${escapeHtml(att.title)}</div>
              <div class="att-size">${formatBytes(att.size || 0)} • ${escapeHtml(att.kind)}</div>
            </div>
          </div>
          <div class="att-actions">
            <div class="att-btn" role="button" tabindex="0" data-att-open="1">Open</div>
            <div class="att-btn" role="button" tabindex="0" data-att-save="1">＋ Save to Vault</div>
          </div>
        `;
        bindDivButton(attBox.querySelector('[data-att-open]'), () => openPreview(att));
        bindDivButton(attBox.querySelector('[data-att-save]'), () => cloneSharedAttachmentToVault(att));
        bubble.appendChild(attBox);
      }

      row.appendChild(bubble);

      const meta = document.createElement('div');
      meta.className = 'msg-meta-line';
      meta.innerHTML = `<span>${formatClock(m.createdAt || Date.now())}</span>`;

      const replyBtn = document.createElement('span');
      replyBtn.className = 'reply-trigger';
      replyBtn.textContent = 'Reply';
      bindDivButton(replyBtn, () => {
        pendingReply = {
          id: m.id,
          author: isMine ? (currentUser.displayName || currentUser.handle) : (activePeer.displayName || activePeer.key),
          text: (m.text || m.attachment?.title || 'Attachment').slice(0, 70)
        };
        $('replyQuoteAuthor').textContent = `Replying to ${pendingReply.author}`;
        $('replyQuoteSnippet').textContent = pendingReply.text;
        $('replyQuoteBar').classList.remove('hidden');
        $('chatMessageInput').focus();
      });
      meta.appendChild(replyBtn);

      row.appendChild(meta);
      stream.appendChild(row);
    });

    stream.scrollTop = stream.scrollHeight;
  }

  async function cloneSharedAttachmentToVault(att, targetFolder = 'Shared with Me') {
    if (!currentUser) return;
    try {
      const newId = generateId();
      const cloned = {
        ...att,
        id: newId,
        folder: targetFolder,
        pinned: false,
        sharedRef: true,
        createdAt: Date.now()
      };
      await indexPut(`vault/${currentUser.key}/meta/${newId}`, cloned);
      itemsMap[newId] = cloned;
      renderVault();
      showToast(`Saved "${att.title}" to ${targetFolder}`);
    } catch {
      showToast('Could not save item');
    }
  }

  async function sendChatPayload({ text = '', attachment = null, replyToShardMessageId = null }) {
    if (!currentUser || !activePeer || !activeRoomId) return;
    const cleanText = text.trim();
    if (!cleanText && !attachment) return;

    const msgId = generateId();
    const now = Date.now();
    const myName = currentUser.displayName || currentUser.handle;
    const peerName = activePeer.displayName || activePeer.handle || activePeer.key;

    const msgObj = {
      id: msgId,
      from: currentUser.key,
      fromName: myName,
      text: cleanText,
      attachment: attachment || null,
      replyTo: pendingReply || null,
      createdAt: now
    };

    pendingReply = null;
    $('replyQuoteBar').classList.add('hidden');
    $('chatMessageInput').value = '';

    const summaryPreview = attachment
      ? `📎 ${attachment.title}${cleanText ? `: ${cleanText}` : ''}`
      : cleanText;

    threadMessages[msgId] = msgObj;
    renderThreadMessages();

    try {
      const existingPeerInbox = await indexGet(`inbox/${activePeer.key}/${currentUser.key}`).catch(() => null);
      const nextUnread = (Number(existingPeerInbox?.unreadCount) || 0) + 1;

      await Promise.all([
        indexPut(`dms/${activeRoomId}/messages/${msgId}`, msgObj),
        indexPut(`inbox/${currentUser.key}/${activePeer.key}`, {
          peerKey: activePeer.key,
          peerName,
          peerAvatar: activePeer.avatarData || '',
          lastText: `You: ${summaryPreview}`,
          lastAt: now,
          unreadCount: 0
        }),
        indexPut(`inbox/${activePeer.key}/${currentUser.key}`, {
          peerKey: currentUser.key,
          peerName: myName,
          peerAvatar: currentUser.avatarData || '',
          lastText: summaryPreview,
          lastAt: now,
          unreadCount: nextUnread
        })
      ]);

      let logHtml = `💬 <b>${escapeHtml(myName)}</b> ➔ <b>${escapeHtml(peerName)}</b>\n`;
      if (attachment) {
        logHtml += `📎 Shared <b>${escapeHtml(attachment.title)}</b> (${formatBytes(attachment.size || 0)})\n`;
      }
      if (cleanText) {
        logHtml += `<blockquote>${escapeHtml(cleanText)}</blockquote>`;
      }
      logActivityToChannel(logHtml, replyToShardMessageId);
    } catch {
      showToast('Message failed to send');
    }
  }

  async function sendSharedVaultItemInChat(item) {
    if (item.encrypted) {
      showToast('Encrypted notes cannot be shared directly');
      return;
    }
    if (!item.sharedRef && itemsMap[item.id]) {
      itemsMap[item.id].sharedRef = true;
      indexPatch(`vault/${currentUser.key}/meta/${item.id}`, { sharedRef: true }).catch(() => {});
    }

    const attachment = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      mime: item.mime || 'application/octet-stream',
      size: item.size || 0,
      compressed: Boolean(item.compressed),
      shards: item.shards || item.tgShards || [],
      url: item.url || ''
    };
    const caption = $('chatMessageInput').value.trim();
    await sendChatPayload({ text: caption, attachment });
  }

  async function handleDirectFileUploadInChat(file) {
    if (!file || !activePeer) return;
    try {
      const id = generateId();
      const rawBuffer = await file.arrayBuffer();
      const { compressed, storedBytes, shards } = await uploadBufferToCloud(id, rawBuffer, file.name);
      setTransferProgress(false);

      const meta = {
        id,
        kind: 'file',
        title: file.name,
        folder: 'Chat Uploads',
        accent: 'default',
        mime: file.type || 'application/octet-stream',
        size: file.size,
        storedBytes,
        compressed,
        shards,
        sharedRef: true,
        encrypted: false,
        pinned: false,
        tags: ['shared'],
        snippet: `Shared with ${activePeer.displayName || activePeer.key}`,
        createdAt: Date.now()
      };

      await indexPut(`vault/${currentUser.key}/meta/${id}`, meta);
      await edgeCache.set(`${currentUser.key}:${id}`, rawBuffer);
      itemsMap[id] = meta;
      renderVault();

      const lastShardMsgId = shards[shards.length - 1]?.messageId || null;
      const caption = $('chatMessageInput').value.trim();
      await sendChatPayload({
        text: caption,
        attachment: {
          id: meta.id,
          kind: meta.kind,
          title: meta.title,
          mime: meta.mime,
          size: meta.size,
          compressed: meta.compressed,
          shards: meta.shards
        },
        replyToShardMessageId: lastShardMsgId
      });
    } catch (err) {
      setTransferProgress(false);
      showToast(err.message || 'Upload failed');
    }
  }

  function toggleChatVaultPicker() {
    const drawer = $('chatVaultPicker');
    if (!drawer.classList.contains('hidden')) {
      drawer.classList.add('hidden');
      return;
    }

    const list = $('vaultPickerList');
    const shareable = Object.values(itemsMap)
      .filter((it) => !it.encrypted)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!shareable.length) {
      showToast('No unencrypted items in your vault yet');
      return;
    }

    list.innerHTML = '';
    shareable.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'picker-item';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.innerHTML = `
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:72%;">
          ${getCategoryIcon(it)} ${escapeHtml(it.title)}
        </span>
        <span style="color:var(--text-muted); font-size:11px;">${formatBytes(it.size || 0)}</span>
      `;
      bindDivButton(row, () => {
        drawer.classList.add('hidden');
        sendSharedVaultItemInChat(it);
      });
      list.appendChild(row);
    });

    drawer.classList.remove('hidden');
  }

  // SHARED GROUP VAULT ROOMS (MULTI-PERSON FOLDERS + LIVE GROUP CHAT)
  function renderGroupVaultList() {
    const list = $('groupVaultList');
    const q = socialSearch.toLowerCase();
    const groups = Object.values(userGroupsMap)
      .filter((g) => {
        if (!q) return true;
        return `${g.name || ''} ${g.lastText || ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

    if (!groups.length) {
      list.innerHTML = `<div class="empty-state"><p>No Shared Group Vaults yet. Tap <strong>＋ Create Shared Group Vault</strong> above to start a multi-person folder and group chat.</p></div>`;
      return;
    }

    list.innerHTML = '';
    groups.forEach((grp) => {
      const row = document.createElement('div');
      row.className = 'person-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      const unread = Number(grp.unreadCount) || 0;

      row.innerHTML = `
        <div class="person-left">
          <div class="avatar-trigger small-avatar">👥</div>
          <div class="person-meta">
            <div class="person-name-line">
              <span>${escapeHtml(grp.name || 'Group Vault')}</span>
              <span class="mini-tag folder">${grp.memberCount || 1} members</span>
            </div>
            <div class="person-sub">${escapeHtml(grp.lastText || 'Shared folder & group chat')}</div>
          </div>
        </div>
        <div class="person-right">
          <span style="font-size:10px; color:var(--text-muted);">${grp.lastAt ? timeAgo(grp.lastAt) : ''}</span>
          ${unread > 0 ? `<span class="mini-tag" style="background:var(--danger); color:#fff;">${unread}</span>` : ''}
        </div>
      `;
      bindDivButton(row, () => openGroupRoom(grp.groupId));
      list.appendChild(row);
    });
  }

  function openCreateGroupView() {
    selectedGroupMembers = new Set();
    selectedGroupColor = 'indigo';
    $('newGroupNameInput').value = '';
    $('newGroupDescInput').value = '';
    document.querySelectorAll('#groupColorPicker .swatch-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.gcolor === 'indigo');
    });

    const checklist = $('groupMemberChecklist');
    const others = Object.values(directoryMap).filter((p) => p.key !== currentUser.key);
    if (!others.length) {
      checklist.innerHTML = `<div class="muted-sub" style="padding:12px;">No other members registered yet. You can create the room now and invite people later!</div>`;
    } else {
      checklist.innerHTML = '';
      others.forEach((person) => {
        const row = document.createElement('div');
        row.className = 'person-row';
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');
        row.innerHTML = `
          <div class="person-left">
            ${renderAvatarHtml(person, 'small-avatar')}
            <div class="person-meta">
              <div class="person-name-line">${escapeHtml(person.displayName || person.handle)}</div>
              <div class="person-sub">@${escapeHtml(person.key)}</div>
            </div>
          </div>
          <div class="person-right">
            <span class="mini-tag" data-check-badge="1">＋ Add</span>
          </div>
        `;
        bindDivButton(row, () => {
          if (selectedGroupMembers.has(person.key)) {
            selectedGroupMembers.delete(person.key);
            row.classList.remove('selected-member');
            row.querySelector('[data-check-badge]').textContent = '＋ Add';
          } else {
            selectedGroupMembers.add(person.key);
            row.classList.add('selected-member');
            row.querySelector('[data-check-badge]').textContent = '✓ Added';
          }
        });
        checklist.appendChild(row);
      });
    }

    $('socialHubView').classList.add('hidden');
    $('createGroupView').classList.remove('hidden');
  }

  async function submitCreateGroupVault() {
    if (!currentUser) return;
    const name = $('newGroupNameInput').value.trim();
    if (!name) {
      showToast('Enter a Group Room Name');
      return;
    }
    const description = $('newGroupDescInput').value.trim() || 'Multi-person shared vault & group chat';
    const groupId = generateId('grp');
    const now = Date.now();
    const myName = currentUser.displayName || currentUser.handle;

    const members = {
      [currentUser.key]: {
        key: currentUser.key,
        name: myName,
        role: 'admin',
        joinedAt: now
      }
    };

    selectedGroupMembers.forEach((mKey) => {
      const p = directoryMap[mKey];
      members[mKey] = {
        key: mKey,
        name: p?.displayName || p?.handle || mKey,
        role: 'member',
        joinedAt: now
      };
    });

    const memberCount = Object.keys(members).length;
    const meta = {
      id: groupId,
      name,
      description,
      accent: selectedGroupColor,
      createdBy: currentUser.key,
      createdAt: now,
      members
    };

    try {
      await indexPut(`groups/${groupId}/meta`, meta);
      const summary = {
        groupId,
        name,
        accent: selectedGroupColor,
        memberCount,
        lastText: `${myName} created this group vault`,
        lastAt: now,
        unreadCount: 0
      };

      await Promise.all(
        Object.keys(members).map((mKey) =>
          indexPut(`userGroups/${mKey}/${groupId}`, {
            ...summary,
            unreadCount: mKey === currentUser.key ? 0 : 1
          })
        )
      );

      logActivityToChannel(
        `👥 <b>New Group Vault Created</b>\n` +
        `📂 <b>${escapeHtml(name)}</b> • Created by <b>${escapeHtml(myName)}</b> (${memberCount} members)`
      );

      $('createGroupView').classList.add('hidden');
      openGroupRoom(groupId);
      showToast(`Group Vault "${name}" created`);
    } catch {
      showToast('Could not create Group Vault');
    }
  }

  async function openGroupRoom(groupId) {
    closeSocialSubstreams();
    activeGroupId = groupId;
    groupMessages = {};
    groupItems = {};
    pendingGroupReply = null;

    $('groupReplyBar').classList.add('hidden');
    $('groupVaultPicker').classList.add('hidden');
    $('groupMembersDrawer').classList.add('hidden');
    $('groupQuickNoteBox').classList.add('hidden');

    $('socialHubView').classList.add('hidden');
    $('createGroupView').classList.add('hidden');
    $('groupRoomView').classList.remove('hidden');
    switchGroupRoomTab('chat');

    try {
      const meta = await indexGet(`groups/${groupId}/meta`);
      if (!meta) {
        showToast('Group room not found');
        openSocialHub('groups');
        return;
      }
      activeGroupMeta = meta;
      renderGroupRoomHeader();

      if (userGroupsMap[groupId]?.unreadCount) {
        userGroupsMap[groupId].unreadCount = 0;
        updateUnreadBadges();
        indexPatch(`userGroups/${currentUser.key}/${groupId}`, { unreadCount: 0 }).catch(() => {});
      }

      // Live SSE stream for Group Chat Messages
      groupMsgEventSource = new EventSource(`${INDEX_BASE}/groups/${groupId}/messages.json`);
      const onGrpMsg = (e) => {
        try {
          const packet = JSON.parse(e.data);
          applySsePatch(groupMessages, packet.path, packet.data);
          renderGroupMessages();
          if (userGroupsMap[groupId]?.unreadCount) {
            userGroupsMap[groupId].unreadCount = 0;
            updateUnreadBadges();
            indexPatch(`userGroups/${currentUser.key}/${groupId}`, { unreadCount: 0 }).catch(() => {});
          }
        } catch {}
      };
      groupMsgEventSource.addEventListener('put', onGrpMsg);
      groupMsgEventSource.addEventListener('patch', onGrpMsg);

      // Live SSE stream for Shared Group Folder Items
      groupItemsEventSource = new EventSource(`${INDEX_BASE}/groups/${groupId}/items.json`);
      const onGrpItem = (e) => {
        try {
          const packet = JSON.parse(e.data);
          applySsePatch(groupItems, packet.path, packet.data);
          renderGroupFolderItems();
        } catch {}
      };
      groupItemsEventSource.addEventListener('put', onGrpItem);
      groupItemsEventSource.addEventListener('patch', onGrpItem);
    } catch {
      showToast('Could not load group room');
    }
  }

  function renderGroupRoomHeader() {
    if (!activeGroupMeta) return;
    const members = Object.values(activeGroupMeta.members || {});
    $('groupRoomTitle').textContent = activeGroupMeta.name;
    $('groupRoomSub').textContent = `${members.length} member${members.length === 1 ? '' : 's'} • ${activeGroupMeta.description || 'Shared Folder'}`;

    const list = $('groupMembersList');
    list.innerHTML = '';
    members.forEach((m) => {
      const chip = document.createElement('div');
      chip.className = 'filter-chip folder-chip';
      chip.textContent = `@${m.key}${m.role === 'admin' ? ' ★' : ''}`;
      list.appendChild(chip);
    });

    const select = $('groupAddMemberSelect');
    const existingKeys = new Set(Object.keys(activeGroupMeta.members || {}));
    const candidates = Object.values(directoryMap).filter((p) => !existingKeys.has(p.key));
    select.innerHTML = '';
    if (!candidates.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'All registered members are in this room';
      select.appendChild(opt);
    } else {
      candidates.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.key;
        opt.textContent = `${p.displayName || p.handle} (@${p.key})`;
        select.appendChild(opt);
      });
    }
  }

  async function addMemberToActiveGroup() {
    if (!activeGroupMeta || !activeGroupId) return;
    const newKey = $('groupAddMemberSelect').value;
    if (!newKey) {
      showToast('No additional members available to add');
      return;
    }
    const person = directoryMap[newKey];
    const now = Date.now();
    const memberObj = {
      key: newKey,
      name: person?.displayName || person?.handle || newKey,
      role: 'member',
      joinedAt: now
    };

    try {
      await indexPut(`groups/${activeGroupId}/meta/members/${newKey}`, memberObj);
      activeGroupMeta.members[newKey] = memberObj;
      const memberCount = Object.keys(activeGroupMeta.members).length;

      await Promise.all(
        Object.keys(activeGroupMeta.members).map((mKey) =>
          indexPut(`userGroups/${mKey}/${activeGroupId}`, {
            groupId: activeGroupId,
            name: activeGroupMeta.name,
            accent: activeGroupMeta.accent || 'indigo',
            memberCount,
            lastText: `${memberObj.name} joined the group vault`,
            lastAt: now,
            unreadCount: mKey === currentUser.key ? 0 : 1
          })
        )
      );

      renderGroupRoomHeader();
      showToast(`Added ${memberObj.name} to room`);
    } catch {
      showToast('Could not add member');
    }
  }

  function switchGroupRoomTab(tab) {
    $('tabGroupChat').classList.toggle('active', tab === 'chat');
    $('tabGroupFolder').classList.toggle('active', tab === 'folder');
    $('groupChatPane').classList.toggle('hidden', tab !== 'chat');
    $('groupFolderPane').classList.toggle('hidden', tab !== 'folder');
    if (tab === 'folder') renderGroupFolderItems();
  }

  function renderGroupMessages() {
    const stream = $('groupMessagesStream');
    const msgs = Object.values(groupMessages).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    if (!msgs.length) {
      stream.innerHTML = `<div class="empty-state"><p>Welcome to <strong>${escapeHtml(activeGroupMeta?.name || 'Group Vault')}</strong>. Send a message or drop files for everyone in the room.</p></div>`;
      return;
    }

    stream.innerHTML = '';
    msgs.forEach((m) => {
      const isMine = m.from === currentUser.key;
      const row = document.createElement('div');
      row.className = `msg-row ${isMine ? 'mine' : 'theirs'}`;

      if (!isMine) {
        const senderTag = document.createElement('div');
        senderTag.className = 'msg-sender-tag';
        senderTag.textContent = `${m.fromName || m.from} (@${m.from})`;
        row.appendChild(senderTag);
      }

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      if (m.replyTo) {
        const qDiv = document.createElement('div');
        qDiv.className = 'msg-quote';
        qDiv.innerHTML = `<strong>${escapeHtml(m.replyTo.author)}</strong>: ${escapeHtml(m.replyTo.text)}`;
        bubble.appendChild(qDiv);
      }

      if (m.text) {
        const tDiv = document.createElement('div');
        tDiv.textContent = m.text;
        bubble.appendChild(tDiv);
      }

      if (m.attachment) {
        const att = m.attachment;
        const attBox = document.createElement('div');
        attBox.className = 'msg-attachment';
        attBox.innerHTML = `
          <div class="att-top">
            <span style="font-size:22px;">${getCategoryIcon(att)}</span>
            <div>
              <div class="att-title">${escapeHtml(att.title)}</div>
              <div class="att-size">${formatBytes(att.size || 0)} • In Shared Folder</div>
            </div>
          </div>
          <div class="att-actions">
            <div class="att-btn" role="button" tabindex="0" data-gatt-open="1">Open</div>
            <div class="att-btn" role="button" tabindex="0" data-gatt-save="1">＋ Save to My Vault</div>
          </div>
        `;
        bindDivButton(attBox.querySelector('[data-gatt-open]'), () => openPreview(att));
        bindDivButton(attBox.querySelector('[data-gatt-save]'), () => cloneSharedAttachmentToVault(att, activeGroupMeta?.name || 'Group Vault'));
        bubble.appendChild(attBox);
      }

      row.appendChild(bubble);

      const meta = document.createElement('div');
      meta.className = 'msg-meta-line';
      meta.innerHTML = `<span>${formatClock(m.createdAt || Date.now())}</span>`;

      const replyBtn = document.createElement('span');
      replyBtn.className = 'reply-trigger';
      replyBtn.textContent = 'Reply';
      bindDivButton(replyBtn, () => {
        pendingGroupReply = {
          id: m.id,
          author: m.fromName || m.from,
          text: (m.text || m.attachment?.title || 'Attachment').slice(0, 70)
        };
        $('groupReplyAuthor').textContent = `Replying to ${pendingGroupReply.author}`;
        $('groupReplySnippet').textContent = pendingGroupReply.text;
        $('groupReplyBar').classList.remove('hidden');
        $('groupMessageInput').focus();
      });
      meta.appendChild(replyBtn);

      row.appendChild(meta);
      stream.appendChild(row);
    });

    stream.scrollTop = stream.scrollHeight;
  }

  function renderGroupFolderItems() {
    const grid = $('groupItemsGrid');
    const items = Object.values(groupItems).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    $('tabGroupFolder').textContent = `📂 Shared Folder (${items.length})`;

    if (!items.length) {
      grid.innerHTML = `<div class="empty-state"><p>No files or notes in this group folder yet. Tap <strong>＋ Upload File to Group</strong> above.</p></div>`;
      return;
    }

    grid.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'person-row';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.innerHTML = `
        <div class="person-left">
          <div class="item-badge">${getCategoryIcon(it)}</div>
          <div class="person-meta">
            <div class="person-name-line">${escapeHtml(it.title)}</div>
            <div class="person-sub">Added by ${escapeHtml(it.addedByName || it.addedBy || 'Member')} • ${formatBytes(it.size || 0)} • ${timeAgo(it.createdAt || Date.now())}</div>
          </div>
        </div>
        <div class="person-right" style="flex-direction:row; gap:6px;">
          <span class="pill-btn glass-pill compact-pill" data-gitem-open="1">Open</span>
          <span class="pill-btn primary-pill compact-pill" data-gitem-save="1">Save</span>
        </div>
      `;
      bindDivButton(row.querySelector('[data-gitem-open]'), (e) => {
        e.stopPropagation();
        openPreview(it);
      });
      bindDivButton(row.querySelector('[data-gitem-save]'), (e) => {
        e.stopPropagation();
        cloneSharedAttachmentToVault(it, activeGroupMeta?.name || 'Group Vault');
      });
      bindDivButton(row, () => openPreview(it));
      grid.appendChild(row);
    });
  }

  async function sendGroupPayload({ text = '', attachment = null, replyToShardMessageId = null }) {
    if (!currentUser || !activeGroupId || !activeGroupMeta) return;
    const cleanText = text.trim();
    if (!cleanText && !attachment) return;

    const msgId = generateId();
    const now = Date.now();
    const myName = currentUser.displayName || currentUser.handle;

    const msgObj = {
      id: msgId,
      from: currentUser.key,
      fromName: myName,
      text: cleanText,
      attachment: attachment || null,
      replyTo: pendingGroupReply || null,
      createdAt: now
    };

    pendingGroupReply = null;
    $('groupReplyBar').classList.add('hidden');
    $('groupMessageInput').value = '';

    groupMessages[msgId] = msgObj;
    renderGroupMessages();

    const preview = attachment
      ? `${myName}: 📎 ${attachment.title}`
      : `${myName}: ${cleanText}`;

    try {
      const writes = [indexPut(`groups/${activeGroupId}/messages/${msgId}`, msgObj)];

      if (attachment) {
        const folderItemId = attachment.id || generateId();
        const folderItem = {
          ...attachment,
          id: folderItemId,
          addedBy: currentUser.key,
          addedByName: myName,
          createdAt: now
        };
        groupItems[folderItemId] = folderItem;
        renderGroupFolderItems();
        writes.push(indexPut(`groups/${activeGroupId}/items/${folderItemId}`, folderItem));
      }

      const memberKeys = Object.keys(activeGroupMeta.members || {});
      for (const mKey of memberKeys) {
        const prev = mKey === currentUser.key ? null : await indexGet(`userGroups/${mKey}/${activeGroupId}`).catch(() => null);
        const nextUnread = mKey === currentUser.key ? 0 : (Number(prev?.unreadCount) || 0) + 1;
        writes.push(
          indexPut(`userGroups/${mKey}/${activeGroupId}`, {
            groupId: activeGroupId,
            name: activeGroupMeta.name,
            accent: activeGroupMeta.accent || 'indigo',
            memberCount: memberKeys.length,
            lastText: preview,
            lastAt: now,
            unreadCount: nextUnread
          })
        );
      }

      await Promise.all(writes);

      let logHtml = `👥 <b>[${escapeHtml(activeGroupMeta.name)}] ${escapeHtml(myName)}</b>\n`;
      if (attachment) {
        logHtml += `📂 Added <b>${escapeHtml(attachment.title)}</b> (${formatBytes(attachment.size || 0)})\n`;
      }
      if (cleanText) {
        logHtml += `<blockquote>${escapeHtml(cleanText)}</blockquote>`;
      }
      logActivityToChannel(logHtml, replyToShardMessageId);
    } catch {
      showToast('Failed to send to group');
    }
  }

  async function handleGroupFileUploads(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || !activeGroupId) return;

    for (const file of files) {
      try {
        const id = generateId();
        const rawBuffer = await file.arrayBuffer();
        const { compressed, storedBytes, shards } = await uploadBufferToCloud(id, rawBuffer, file.name);
        setTransferProgress(false);

        const lastShardMsgId = shards[shards.length - 1]?.messageId || null;
        const caption = $('groupMessageInput').value.trim();

        await sendGroupPayload({
          text: caption,
          attachment: {
            id,
            kind: 'file',
            title: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            storedBytes,
            compressed,
            shards
          },
          replyToShardMessageId: lastShardMsgId
        });
        showToast(`Added "${file.name}" to group`);
      } catch (err) {
        setTransferProgress(false);
        showToast(`Failed ${file.name}: ${err.message}`);
      }
    }
  }

  async function saveGroupSharedNote() {
    if (!activeGroupId) return;
    const title = $('groupNoteTitleInput').value.trim() || `Group Note ${new Date().toLocaleTimeString()}`;
    const body = $('groupNoteBodyInput').value;
    if (!body.trim()) {
      showToast('Note content cannot be empty');
      return;
    }

    try {
      const id = generateId();
      const rawBuffer = new TextEncoder().encode(body).buffer;
      const { compressed, storedBytes, shards } = await uploadBufferToCloud(id, rawBuffer, title);
      setTransferProgress(false);

      $('groupNoteTitleInput').value = '';
      $('groupNoteBodyInput').value = '';
      $('groupQuickNoteBox').classList.add('hidden');

      await sendGroupPayload({
        text: `Shared a note: ${title}`,
        attachment: {
          id,
          kind: 'note',
          title,
          mime: 'text/plain;charset=utf-8',
          size: rawBuffer.byteLength,
          storedBytes,
          compressed,
          shards,
          snippet: body.slice(0, 120)
        }
      });
      showToast('Note posted to group folder');
    } catch (err) {
      setTransferProgress(false);
      showToast(err.message || 'Could not post note');
    }
  }

  function toggleGroupVaultPicker() {
    const drawer = $('groupVaultPicker');
    if (!drawer.classList.contains('hidden')) {
      drawer.classList.add('hidden');
      return;
    }
    const list = $('groupVaultPickerList');
    const shareable = Object.values(itemsMap)
      .filter((it) => !it.encrypted)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    if (!shareable.length) {
      showToast('No unencrypted items in your vault yet');
      return;
    }

    list.innerHTML = '';
    shareable.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'picker-item';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.innerHTML = `
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:72%;">
          ${getCategoryIcon(it)} ${escapeHtml(it.title)}
        </span>
        <span style="color:var(--text-muted); font-size:11px;">${formatBytes(it.size || 0)}</span>
      `;
      bindDivButton(row, () => {
        drawer.classList.add('hidden');
        if (!it.sharedRef && itemsMap[it.id]) {
          itemsMap[it.id].sharedRef = true;
          indexPatch(`vault/${currentUser.key}/meta/${it.id}`, { sharedRef: true }).catch(() => {});
        }
        sendGroupPayload({
          text: $('groupMessageInput').value.trim(),
          attachment: {
            id: generateId(),
            kind: it.kind,
            title: it.title,
            mime: it.mime || 'application/octet-stream',
            size: it.size || 0,
            compressed: Boolean(it.compressed),
            shards: it.shards || it.tgShards || [],
            url: it.url || ''
          }
        });
      });
      list.appendChild(row);
    });
    drawer.classList.remove('hidden');
  }

  // CREATE / STORE PERSONAL VAULT ACTIONS
  function parseTags(raw) {
    return (raw || '')
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean);
  }

  function getSelectedCreateFolder() {
    const val = $('itemFolderSelect')?.value || 'General';
    return val.trim() || 'General';
  }

  async function storeFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    $('createModal').classList.add('hidden');
    const tags = parseTags($('itemTags').value);
    const folder = getSelectedCreateFolder();

    for (const file of files) {
      try {
        const id = generateId();
        const rawBuffer = await file.arrayBuffer();
        const { compressed, storedBytes, shards } = await uploadBufferToCloud(id, rawBuffer, file.name);

        const meta = {
          id,
          kind: 'file',
          title: file.name,
          folder,
          accent: 'default',
          mime: file.type || 'application/octet-stream',
          size: file.size,
          storedBytes,
          compressed,
          shards,
          encrypted: false,
          pinned: false,
          tags,
          snippet: file.type || 'File',
          createdAt: Date.now()
        };

        await indexPut(`vault/${currentUser.key}/meta/${id}`, meta);
        await edgeCache.set(`${currentUser.key}:${id}`, rawBuffer);
        itemsMap[id] = meta;
        renderVault();
        showToast(`Stored ${file.name} in ${folder}`);
      } catch (err) {
        showToast(`Failed ${file.name}: ${err.message}`);
      }
    }
    setTransferProgress(false);
    $('filePicker').value = '';
    $('itemTags').value = '';
  }

  async function storeNote() {
    const title = $('noteTitle').value.trim() || `Note ${new Date().toLocaleTimeString()}`;
    const body = $('noteBody').value;
    if (!body.trim()) {
      showToast('Note content cannot be empty');
      return;
    }

    const isEncrypted = $('encryptToggle').dataset.active === 'true';
    const pass = $('encryptPass').value;
    if (isEncrypted && pass.length < 3) {
      showToast('Enter a passphrase (3+ characters)');
      return;
    }

    try {
      const id = generateId();
      const tags = parseTags($('itemTags').value);
      const folder = getSelectedCreateFolder();
      const payloadText = isEncrypted ? await encryptText(body, pass) : body;
      const rawBuffer = new TextEncoder().encode(payloadText).buffer;
      const { compressed, storedBytes, shards } = await uploadBufferToCloud(id, rawBuffer, title);

      const meta = {
        id,
        kind: 'note',
        title,
        folder,
        accent: 'default',
        mime: 'text/plain;charset=utf-8',
        size: rawBuffer.byteLength,
        storedBytes,
        compressed,
        shards,
        encrypted: isEncrypted,
        pinned: false,
        tags,
        snippet: isEncrypted ? 'Passphrase-protected note' : body.slice(0, 120),
        createdAt: Date.now()
      };

      await indexPut(`vault/${currentUser.key}/meta/${id}`, meta);
      await edgeCache.set(`${currentUser.key}:${id}`, rawBuffer);
      itemsMap[id] = meta;
      renderVault();
      setTransferProgress(false);

      $('noteTitle').value = '';
      $('noteBody').value = '';
      $('encryptPass').value = '';
      $('itemTags').value = '';
      $('createModal').classList.add('hidden');
      showToast(`Note saved in ${folder}`);
    } catch (err) {
      setTransferProgress(false);
      showToast(err.message || 'Unable to save note');
    }
  }

  async function storeLink() {
    let url = $('linkUrl').value.trim();
    if (!url) {
      showToast('Enter a URL');
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const title = $('linkTitle').value.trim() || url.replace(/^https?:\/\//i, '').split('/')[0];

    try {
      const id = generateId();
      const tags = parseTags($('itemTags').value);
      const folder = getSelectedCreateFolder();
      const meta = {
        id,
        kind: 'link',
        title,
        folder,
        accent: 'default',
        url,
        mime: 'text/uri-list',
        size: url.length,
        shards: [],
        encrypted: false,
        pinned: false,
        tags,
        snippet: url,
        createdAt: Date.now()
      };

      await indexPut(`vault/${currentUser.key}/meta/${id}`, meta);
      itemsMap[id] = meta;
      renderVault();

      $('linkUrl').value = '';
      $('linkTitle').value = '';
      $('itemTags').value = '';
      $('createModal').classList.add('hidden');
      showToast(`Link saved in ${folder}`);
    } catch (err) {
      showToast(err.message || 'Unable to save link');
    }
  }

  // PREVIEW & FILE CUSTOMIZATION
  function closePreview() {
    $('previewModal').classList.add('hidden');
    $('previewViewport').innerHTML = '';
    $('decryptPrompt').classList.add('hidden');
    $('itemEditDrawer').classList.add('hidden');
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    activeItem = null;
    activePlainText = '';
    activeDecryptedPass = '';
    deleteConfirmArmed = false;
  }

  async function openPreview(item) {
    closePreview();
    activeItem = item;
    const isOwned = Boolean(itemsMap[item.id]);
    $('previewPinBtn').classList.toggle('hidden', !isOwned);
    $('previewEditBtn').classList.toggle('hidden', !isOwned);
    $('previewDeleteBtn').classList.toggle('hidden', !isOwned);

    $('previewTitle').textContent = item.title;
    $('previewMeta').textContent = `${formatBytes(item.size || 0)} • ${item.folder || 'Shared'}`;
    $('previewPinBtn').style.color = item.pinned ? '#fbbf24' : '';
    $('previewModal').classList.remove('hidden');

    const viewport = $('previewViewport');
    viewport.classList.remove('hidden');
    viewport.innerHTML = '<div class="muted-sub">Loading from cloud...</div>';

    try {
      if (item.kind === 'link') {
        activePlainText = item.url;
        viewport.innerHTML = `
          <div style="text-align:center; display:flex; flex-direction:column; gap:14px; width:100%;">
            <div class="preview-text-box" style="text-align:center;">${escapeHtml(item.url)}</div>
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="pill-btn primary-pill" style="text-decoration:none; max-width:240px; margin:0 auto;">Open Link ↗</a>
          </div>
        `;
        return;
      }

      const rawBuf = await downloadBufferFromCloud(item, true);

      if (item.encrypted) {
        viewport.classList.add('hidden');
        $('decryptPrompt').classList.remove('hidden');
        $('decryptInput').value = '';
        $('decryptInput').dataset.rawB64 = arrayBufferToBase64(rawBuf);
        return;
      }

      renderUnencryptedPayload(item, rawBuf);
    } catch (err) {
      setTransferProgress(false);
      viewport.innerHTML = `<div class="muted-sub">Unable to load: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderUnencryptedPayload(item, rawBuf) {
    const viewport = $('previewViewport');
    const mime = item.mime || 'application/octet-stream';
    const blob = new Blob([rawBuf], { type: mime });
    activeObjectUrl = URL.createObjectURL(blob);

    if (item.kind === 'note' || mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript')) {
      activePlainText = new TextDecoder().decode(rawBuf);
      viewport.innerHTML = `<div class="preview-text-box">${escapeHtml(activePlainText)}</div>`;
    } else if (mime.startsWith('image/')) {
      viewport.innerHTML = `<img src="${activeObjectUrl}" alt="${escapeHtml(item.title)}" />`;
    } else if (mime.startsWith('video/')) {
      viewport.innerHTML = `<video src="${activeObjectUrl}" controls playsinline autoplay></video>`;
    } else if (mime.startsWith('audio/')) {
      viewport.innerHTML = `<audio src="${activeObjectUrl}" controls autoplay></audio>`;
    } else if (mime.includes('pdf')) {
      viewport.innerHTML = `<iframe src="${activeObjectUrl}" title="${escapeHtml(item.title)}"></iframe>`;
    } else {
      viewport.innerHTML = `
        <div style="text-align:center; display:flex; flex-direction:column; gap:12px;">
          <div style="font-size:38px;">📦</div>
          <div style="font-weight:650;">${escapeHtml(item.title)}</div>
          <div class="muted-sub">${formatBytes(item.size || 0)} • Ready to download</div>
        </div>
      `;
    }
  }

  async function handleDecrypt() {
    const pass = $('decryptInput').value;
    const rawB64 = $('decryptInput').dataset.rawB64;
    if (!pass || !rawB64) return;
    try {
      const envelope = new TextDecoder().decode(base64ToArrayBuffer(rawB64));
      const plain = await decryptText(envelope, pass);
      $('decryptPrompt').classList.add('hidden');
      $('previewViewport').classList.remove('hidden');
      activePlainText = plain;
      activeDecryptedPass = pass;
      $('previewViewport').innerHTML = `<div class="preview-text-box">${escapeHtml(plain)}</div>`;
      showToast('Unlocked');
    } catch {
      showToast('Incorrect passphrase');
    }
  }

  function toggleItemCustomizeDrawer() {
    if (!activeItem) return;
    const drawer = $('itemEditDrawer');
    const opening = drawer.classList.contains('hidden');
    if (!opening) {
      drawer.classList.add('hidden');
      return;
    }

    $('editItemTitle').value = activeItem.title || '';
    populateFolderSelect($('editItemFolderSelect'), activeItem.folder || 'General');
    $('editItemTags').value = (activeItem.tags || []).join(', ');
    selectedCardAccent = activeItem.accent || 'default';
    document.querySelectorAll('#cardColorPicker .swatch-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.color === selectedCardAccent);
    });

    const isLink = activeItem.kind === 'link';
    const isEditableNote = activeItem.kind === 'note' && (!activeItem.encrypted || Boolean(activePlainText));

    $('editUrlWrap').classList.toggle('hidden', !isLink);
    if (isLink) $('editItemUrl').value = activeItem.url || '';

    $('editNoteBodyWrap').classList.toggle('hidden', !isEditableNote);
    if (isEditableNote) $('editItemBody').value = activePlainText || '';

    drawer.classList.remove('hidden');
  }

  async function saveItemCustomizations() {
    if (!activeItem) return;
    const nextTitle = $('editItemTitle').value.trim() || activeItem.title;
    const nextFolder = $('editItemFolderSelect').value || 'General';
    const nextTags = parseTags($('editItemTags').value);
    const nextAccent = selectedCardAccent;

    const patch = {
      title: nextTitle,
      folder: nextFolder,
      tags: nextTags,
      accent: nextAccent
    };

    try {
      if (activeItem.kind === 'link') {
        let nextUrl = $('editItemUrl').value.trim() || activeItem.url;
        if (!/^https?:\/\//i.test(nextUrl)) nextUrl = `https://${nextUrl}`;
        patch.url = nextUrl;
        patch.snippet = nextUrl;
        patch.size = nextUrl.length;
        activePlainText = nextUrl;
      } else if (activeItem.kind === 'note' && !$('editNoteBodyWrap').classList.contains('hidden')) {
        const nextBody = $('editItemBody').value;
        if (nextBody !== activePlainText) {
          const payloadText = activeItem.encrypted && activeDecryptedPass
            ? await encryptText(nextBody, activeDecryptedPass)
            : nextBody;
          const rawBuffer = new TextEncoder().encode(payloadText).buffer;
          const oldShards = activeItem.shards || activeItem.tgShards || [];
          const { compressed, storedBytes, shards } = await uploadBufferToCloud(activeItem.id, rawBuffer, nextTitle);
          if (!activeItem.sharedRef) eraseRemoteShards(oldShards);

          patch.size = rawBuffer.byteLength;
          patch.storedBytes = storedBytes;
          patch.compressed = compressed;
          patch.shards = shards;
          patch.snippet = activeItem.encrypted ? 'Passphrase-protected note' : nextBody.slice(0, 120);
          activePlainText = nextBody;
          await edgeCache.set(`${currentUser.key}:${activeItem.id}`, rawBuffer);
          setTransferProgress(false);
        }
      }

      await indexPatch(`vault/${currentUser.key}/meta/${activeItem.id}`, patch);
      Object.assign(activeItem, patch);
      itemsMap[activeItem.id] = activeItem;

      $('previewTitle').textContent = activeItem.title;
      $('previewMeta').textContent = `${formatBytes(activeItem.size || 0)} • ${activeItem.folder}`;
      if (activeItem.kind === 'note' && !$('editNoteBodyWrap').classList.contains('hidden')) {
        $('previewViewport').innerHTML = `<div class="preview-text-box">${escapeHtml(activePlainText)}</div>`;
      }
      if (activeItem.kind === 'link') {
        $('previewViewport').innerHTML = `
          <div style="text-align:center; display:flex; flex-direction:column; gap:14px; width:100%;">
            <div class="preview-text-box" style="text-align:center;">${escapeHtml(activeItem.url)}</div>
            <a href="${escapeHtml(activeItem.url)}" target="_blank" rel="noopener noreferrer" class="pill-btn primary-pill" style="text-decoration:none; max-width:240px; margin:0 auto;">Open Link ↗</a>
          </div>
        `;
      }

      $('itemEditDrawer').classList.add('hidden');
      renderVault();
      showToast('File updated');
    } catch (err) {
      setTransferProgress(false);
      showToast(err.message || 'Update failed');
    }
  }

  async function togglePinActive() {
    if (!activeItem) return;
    const nextPin = !activeItem.pinned;
    activeItem.pinned = nextPin;
    itemsMap[activeItem.id].pinned = nextPin;
    $('previewPinBtn').style.color = nextPin ? '#fbbf24' : '';
    renderVault();
    await indexPatch(`vault/${currentUser.key}/meta/${activeItem.id}`, { pinned: nextPin });
    showToast(nextPin ? 'Pinned to top' : 'Unpinned');
  }

  async function copyActive() {
    if (!activeItem) return;
    const text = activePlainText || activeItem.url || activeItem.title;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    } catch {
      showToast('Clipboard unavailable');
    }
  }

  function downloadActive() {
    if (!activeItem) return;
    if (activeItem.kind === 'link') {
      window.open(activeItem.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const url = activePlainText
      ? URL.createObjectURL(new Blob([activePlainText], { type: 'text/plain;charset=utf-8' }))
      : activeObjectUrl;
    if (!url) {
      showToast('Wait for file to finish loading');
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = activeItem.kind === 'note' ? `${activeItem.title}.txt` : activeItem.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Download started');
  }

  async function deleteActive() {
    if (!activeItem) return;
    if (!deleteConfirmArmed) {
      deleteConfirmArmed = true;
      showToast('Tap delete again to permanently remove');
      setTimeout(() => { deleteConfirmArmed = false; }, 3500);
      return;
    }
    const target = activeItem;
    closePreview();
    try {
      if (!target.sharedRef) {
        eraseRemoteShards(target.shards || target.tgShards || []);
      }
      await Promise.all([
        indexDelete(`vault/${currentUser.key}/meta/${target.id}`),
        edgeCache.del(`${currentUser.key}:${target.id}`)
      ]);
      delete itemsMap[target.id];
      renderVault();
      showToast('Item deleted');
    } catch {
      showToast('Could not delete item');
    }
  }

  // ACCOUNT CUSTOMIZATION & FULL CONTROL
  function openAccountModal(tab = 'profile') {
    if (!currentUser) return;
    pendingAvatarData = undefined;
    purgeConfirmArmed = false;
    deleteAccountArmed = false;

    $('accDisplayName').value = currentUser.displayName || currentUser.handle || '';
    $('accBio').value = currentUser.bio || '';
    const initial = (currentUser.displayName || currentUser.handle || 'T').charAt(0).toUpperCase();
    $('accAvatarInitial').textContent = initial;

    if (currentUser.avatarData) {
      $('accAvatarPreview').src = currentUser.avatarData;
      $('accAvatarPreview').classList.remove('hidden');
      $('accAvatarInitial').classList.add('hidden');
    } else {
      $('accAvatarPreview').classList.add('hidden');
      $('accAvatarInitial').classList.remove('hidden');
    }

    selectedTheme = currentUser.theme || 'indigo';
    document.querySelectorAll('#themePicker .swatch-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.theme === selectedTheme);
    });

    const allItems = Object.values(itemsMap);
    const totalBytes = allItems.reduce((a, b) => a + (b.size || 0), 0);
    const mediaCount = allItems.filter((i) => /^(image|video|audio)\//.test(i.mime || '')).length;
    const fileCount = allItems.filter((i) => i.kind === 'file').length;
    const noteCount = allItems.filter((i) => i.kind === 'note').length;
    const linkCount = allItems.filter((i) => i.kind === 'link').length;

    $('accTotalSize').textContent = formatBytes(totalBytes);
    $('accBreakdownGrid').innerHTML = `
      <div class="breakdown-cell">Files<strong>${fileCount}</strong></div>
      <div class="breakdown-cell">Media<strong>${mediaCount}</strong></div>
      <div class="breakdown-cell">Notes<strong>${noteCount}</strong></div>
      <div class="breakdown-cell">Links<strong>${linkCount}</strong></div>
    `;

    switchAccountTab(tab);
    $('accountModal').classList.remove('hidden');
  }

  function switchAccountTab(tab) {
    document.querySelectorAll('[data-acc-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.accTab === tab);
    });
    $('accPaneProfile').classList.toggle('hidden', tab !== 'profile');
    $('accPaneStorage').classList.toggle('hidden', tab !== 'storage');
    $('accPaneSecurity').classList.toggle('hidden', tab !== 'security');
  }

  function handleAvatarPick(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 192;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
        pendingAvatarData = canvas.toDataURL('image/jpeg', 0.82);

        $('accAvatarPreview').src = pendingAvatarData;
        $('accAvatarPreview').classList.remove('hidden');
        $('accAvatarInitial').classList.add('hidden');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  async function saveAccountProfile() {
    if (!currentUser) return;
    const displayName = $('accDisplayName').value.trim() || currentUser.handle;
    const bio = $('accBio').value.trim();
    const avatarData = pendingAvatarData !== undefined ? pendingAvatarData : (currentUser.avatarData || '');

    try {
      await indexPatch(`users/${currentUser.key}`, {
        displayName,
        bio,
        theme: selectedTheme,
        avatarData
      });
      currentUser.displayName = displayName;
      currentUser.bio = bio;
      currentUser.theme = selectedTheme;
      currentUser.avatarData = avatarData;
      renderUserProfileHeader();
      await publishPublicDirectoryEntry(currentUser, false);
      $('accountModal').classList.add('hidden');
      showToast('Profile saved');
    } catch {
      showToast('Could not save profile');
    }
  }

  function exportAccountBackup() {
    if (!currentUser) return;
    const payload = JSON.stringify({
      app: 'Only Me Ted',
      account: {
        username: currentUser.handle,
        displayName: currentUser.displayName,
        bio: currentUser.bio
      },
      exportedAt: new Date().toISOString(),
      folders: foldersMap,
      items: itemsMap
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `only-me-ted-${currentUser.key}-backup.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded');
  }

  async function purgeAllVaultData() {
    if (!currentUser) return;
    if (!purgeConfirmArmed) {
      purgeConfirmArmed = true;
      showToast('Tap again to erase all items in your vault');
      setTimeout(() => { purgeConfirmArmed = false; }, 3500);
      return;
    }
    purgeConfirmArmed = false;
    try {
      const all = Object.values(itemsMap);
      for (const it of all) {
        if (!it.sharedRef) {
          eraseRemoteShards(it.shards || it.tgShards || []);
        }
        await edgeCache.del(`${currentUser.key}:${it.id}`);
      }
      await indexDelete(`vault/${currentUser.key}/meta`);
      itemsMap = {};
      renderVault();
      $('accountModal').classList.add('hidden');
      showToast('All vault items erased');
    } catch {
      showToast('Unable to purge items');
    }
  }

  async function updateAccountPassword() {
    if (!currentUser) return;
    const oldPass = $('secOldPass').value;
    const newPass = $('secNewPass').value;
    const confirmPass = $('secConfirmPass').value;

    if (newPass.length < 4) {
      showToast('New password must be at least 4 characters');
      return;
    }
    if (newPass !== confirmPass) {
      showToast('New passwords do not match');
      return;
    }

    try {
      const record = await indexGet(`users/${currentUser.key}`);
      const oldHash = await sha256Hex(`${record.salt}:${oldPass}`);
      if (oldHash !== record.hash) {
        showToast('Current password is incorrect');
        return;
      }
      const nextSalt = randomHex(16);
      const nextHash = await sha256Hex(`${nextSalt}:${newPass}`);
      await indexPatch(`users/${currentUser.key}`, { salt: nextSalt, hash: nextHash });

      $('secOldPass').value = '';
      $('secNewPass').value = '';
      $('secConfirmPass').value = '';
      showToast('Password updated');
    } catch {
      showToast('Could not update password');
    }
  }

  async function deleteAccountPermanently() {
    if (!currentUser) return;
    if (!deleteAccountArmed) {
      deleteAccountArmed = true;
      showToast('Tap again to permanently delete your account');
      setTimeout(() => { deleteAccountArmed = false; }, 3500);
      return;
    }
    deleteAccountArmed = false;
    try {
      const all = Object.values(itemsMap);
      for (const it of all) {
        if (!it.sharedRef) {
          eraseRemoteShards(it.shards || it.tgShards || []);
        }
        await edgeCache.del(`${currentUser.key}:${it.id}`);
      }
      await Promise.all([
        indexDelete(`vault/${currentUser.key}`),
        indexDelete(`inbox/${currentUser.key}`),
        indexDelete(`userGroups/${currentUser.key}`),
        indexDelete(`directory/${currentUser.key}`),
        indexDelete(`users/${currentUser.key}`)
      ]);
      delete directoryMap[currentUser.key];
      $('accountModal').classList.add('hidden');
      signOut();
      showToast('Account permanently deleted');
    } catch {
      showToast('Could not delete account');
    }
  }

  function openCreateModal(tab = 'files') {
    const defaultFolder = activeFolder !== 'all' ? activeFolder : 'General';
    populateFolderSelect($('itemFolderSelect'), defaultFolder);
    $('createModal').classList.remove('hidden');
    document.querySelectorAll('[data-create-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.createTab === tab);
    });
    $('paneFiles').classList.toggle('hidden', tab !== 'files');
    $('paneNote').classList.toggle('hidden', tab !== 'note');
    $('paneLink').classList.toggle('hidden', tab !== 'link');
  }

  // EVENT BINDINGS
  bindDivButton($('tabLogin'), () => setAuthMode('login'));
  bindDivButton($('tabSignup'), () => setAuthMode('signup'));
  bindDivButton($('authSubmitBtn'), handleAuthSubmit);

  [$('authUsername'), $('authPassword'), $('authConfirm')].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAuthSubmit();
    });
  });

  // STANDALONE DROP LINK VIEWER BINDINGS
  bindDivButton($('dropDownloadBtn'), downloadActiveDropItem);
  bindDivButton($('dropSaveVaultBtn'), saveActiveDropToMyVault);
  bindDivButton($('dropGoAppBtn'), () => {
    clearShareUrlParam();
    $('dropViewerView').classList.add('hidden');
    if (currentUser) {
      enterWorkspace();
    } else {
      $('authView').classList.remove('hidden');
    }
  });

  // DROP LINK MODAL BINDINGS
  bindDivButton($('closeDropLinkBtn'), () => $('dropLinkModal').classList.add('hidden'));
  bindDivButton($('dropModePublicBtn'), () => {
    selectedDropMode = 'public';
    $('dropModePublicBtn').classList.add('active');
    $('dropModeSecureBtn').classList.remove('active');
    $('dropModeHint').textContent = 'Anyone with this link can view & download immediately — no account needed.';
  });
  bindDivButton($('dropModeSecureBtn'), () => {
    selectedDropMode = 'secure';
    $('dropModeSecureBtn').classList.add('active');
    $('dropModePublicBtn').classList.remove('active');
    $('dropModeHint').textContent = 'Account sign-in required before anyone can view or download this item.';
  });
  document.querySelectorAll('#dropExpiryRow .capsule-tab').forEach((tab) => {
    bindDivButton(tab, () => {
      selectedDropExpiryMs = Number(tab.dataset.expiry) || 0;
      document.querySelectorAll('#dropExpiryRow .capsule-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
    });
  });
  bindDivButton($('generateDropLinkBtn'), generateDropLink);
  bindDivButton($('copyDropUrlBtn'), async () => {
    const val = $('dropGeneratedUrl').value;
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      showToast('Drop Link copied to clipboard');
    } catch {
      showToast('Select and copy the URL manually');
    }
  });
  bindDivButton($('revokeDropLinkBtn'), revokeActiveDropLink);

  // FOLDER MODAL BINDINGS
  bindDivButton($('quickFolderBtn'), openCreateFolderModal);
  bindDivButton($('quickNewFolderInlineBtn'), openCreateFolderModal);
  bindDivButton($('closeFolderBtn'), () => $('folderModal').classList.add('hidden'));
  bindDivButton($('createFolderSubmitBtn'), submitCreateFolder);
  $('newFolderNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCreateFolder();
  });
  document.querySelectorAll('#folderColorPicker .swatch-dot').forEach((dot) => {
    bindDivButton(dot, () => {
      selectedFolderColor = dot.dataset.fcolor;
      document.querySelectorAll('#folderColorPicker .swatch-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
    });
  });

  // WORKSPACE HEADER BINDINGS
  bindDivButton($('headerAvatarBtn'), () => openAccountModal('profile'));
  bindDivButton($('accountBtn'), () => openAccountModal('profile'));
  bindDivButton($('closeAccountBtn'), () => $('accountModal').classList.add('hidden'));
  bindDivButton($('syncNowBtn'), () => syncVault(false));
  bindDivButton($('logoutBtn'), signOut);

  // SOCIAL HUB, DM & GROUP VAULT ROOM BINDINGS
  bindDivButton($('memberCountBtn'), () => openSocialHub('people'));
  bindDivButton($('chatHubBtn'), () => openSocialHub('chats'));
  bindDivButton($('dockChatBtn'), () => openSocialHub('chats'));
  bindDivButton($('closeSocialBtn'), () => {
    closeSocialSubstreams();
    $('socialModal').classList.add('hidden');
  });
  bindDivButton($('closeThreadModalBtn'), () => {
    closeSocialSubstreams();
    $('socialModal').classList.add('hidden');
  });
  bindDivButton($('backToHubBtn'), () => openSocialHub(activeSocialTab));

  document.querySelectorAll('[data-social-tab]').forEach((tab) => {
    bindDivButton(tab, () => switchSocialTab(tab.dataset.socialTab));
  });

  $('socialSearchInput').addEventListener('input', (e) => {
    socialSearch = e.target.value;
    if (activeSocialTab === 'chats') renderInboxList();
    else if (activeSocialTab === 'groups') renderGroupVaultList();
    else renderPeopleDirectory();
  });

  // CREATE GROUP VAULT BINDINGS
  bindDivButton($('openCreateGroupBtn'), openCreateGroupView);
  bindDivButton($('backFromCreateGroupBtn'), () => openSocialHub('groups'));
  bindDivButton($('closeCreateGroupBtn'), () => $('socialModal').classList.add('hidden'));
  bindDivButton($('submitCreateGroupBtn'), submitCreateGroupVault);
  document.querySelectorAll('#groupColorPicker .swatch-dot').forEach((dot) => {
    bindDivButton(dot, () => {
      selectedGroupColor = dot.dataset.gcolor;
      document.querySelectorAll('#groupColorPicker .swatch-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
    });
  });

  // GROUP VAULT ROOM BINDINGS
  bindDivButton($('backFromGroupBtn'), () => openSocialHub('groups'));
  bindDivButton($('closeGroupRoomBtn'), () => {
    closeSocialSubstreams();
    $('socialModal').classList.add('hidden');
  });
  bindDivButton($('groupMembersBtn'), () => {
    $('groupMembersDrawer').classList.toggle('hidden');
  });
  bindDivButton($('groupAddMemberBtn'), addMemberToActiveGroup);
  document.querySelectorAll('[data-groom-tab]').forEach((tab) => {
    bindDivButton(tab, () => switchGroupRoomTab(tab.dataset.groomTab));
  });
  bindDivButton($('cancelGroupReplyBtn'), () => {
    pendingGroupReply = null;
    $('groupReplyBar').classList.add('hidden');
  });
  bindDivButton($('groupAttachVaultBtn'), toggleGroupVaultPicker);
  bindDivButton($('closeGroupVaultPickerBtn'), () => $('groupVaultPicker').classList.add('hidden'));
  $('groupDirectFileInput').addEventListener('change', (e) => {
    handleGroupFileUploads(e.target.files);
    e.target.value = '';
  });
  $('groupFolderUploadInput').addEventListener('change', (e) => {
    handleGroupFileUploads(e.target.files);
    e.target.value = '';
  });
  bindDivButton($('groupToggleNoteBtn'), () => {
    $('groupQuickNoteBox').classList.toggle('hidden');
  });
  bindDivButton($('groupSaveNoteBtn'), saveGroupSharedNote);
  bindDivButton($('sendGroupChatBtn'), () => {
    sendGroupPayload({ text: $('groupMessageInput').value });
  });
  $('groupMessageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendGroupPayload({ text: $('groupMessageInput').value });
    }
  });

  // 1-ON-1 DM COMPOSER BINDINGS
  bindDivButton($('cancelReplyBtn'), () => {
    pendingReply = null;
    $('replyQuoteBar').classList.add('hidden');
  });
  bindDivButton($('attachVaultBtn'), toggleChatVaultPicker);
  bindDivButton($('closeVaultPickerBtn'), () => $('chatVaultPicker').classList.add('hidden'));
  $('chatDirectFileInput').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleDirectFileUploadInChat(file);
    e.target.value = '';
  });
  bindDivButton($('sendChatBtn'), () => {
    sendChatPayload({ text: $('chatMessageInput').value });
  });
  $('chatMessageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChatPayload({ text: $('chatMessageInput').value });
    }
  });

  // ACCOUNT MODAL BINDINGS
  document.querySelectorAll('[data-acc-tab]').forEach((tab) => {
    bindDivButton(tab, () => switchAccountTab(tab.dataset.accTab));
  });
  $('avatarFileInput').addEventListener('change', (e) => handleAvatarPick(e.target.files?.[0]));
  bindDivButton($('removeAvatarBtn'), () => {
    pendingAvatarData = '';
    $('accAvatarPreview').classList.add('hidden');
    $('accAvatarInitial').classList.remove('hidden');
  });
  document.querySelectorAll('#themePicker .swatch-dot').forEach((dot) => {
    bindDivButton(dot, () => {
      selectedTheme = dot.dataset.theme;
      applyTheme(selectedTheme);
      document.querySelectorAll('#themePicker .swatch-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
    });
  });
  bindDivButton($('saveProfileBtn'), saveAccountProfile);
  bindDivButton($('exportDataBtn'), exportAccountBackup);
  bindDivButton($('purgeVaultBtn'), purgeAllVaultData);
  bindDivButton($('changePassBtn'), updateAccountPassword);
  bindDivButton($('deleteAccountBtn'), deleteAccountPermanently);

  // SEARCH & FILTER BINDINGS
  $('searchInput').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    $('clearSearchBtn').classList.toggle('hidden', !searchQuery);
    renderVault();
  });
  bindDivButton($('clearSearchBtn'), () => {
    searchQuery = '';
    $('searchInput').value = '';
    $('clearSearchBtn').classList.add('hidden');
    renderVault();
  });
  document.querySelectorAll('[data-filter]').forEach((chip) => {
    bindDivButton(chip, () => {
      activeFilter = chip.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderVault();
    });
  });

  // CREATE & PREVIEW BINDINGS
  bindDivButton($('openUploadBtn'), () => openCreateModal('files'));
  bindDivButton($('quickNoteBtn'), () => openCreateModal('note'));
  bindDivButton($('quickLinkBtn'), () => openCreateModal('link'));
  bindDivButton($('closeCreateBtn'), () => $('createModal').classList.add('hidden'));

  document.querySelectorAll('[data-create-tab]').forEach((tab) => {
    bindDivButton(tab, () => openCreateModal(tab.dataset.createTab));
  });

  $('filePicker').addEventListener('change', (e) => storeFiles(e.target.files));

  bindDivButton($('encryptToggle'), () => {
    const toggle = $('encryptToggle');
    const next = toggle.dataset.active !== 'true';
    toggle.dataset.active = String(next);
    $('encryptPassWrap').classList.toggle('hidden', !next);
  });

  bindDivButton($('saveNoteBtn'), storeNote);
  bindDivButton($('saveLinkBtn'), storeLink);

  bindDivButton($('closePreviewBtn'), closePreview);
  bindDivButton($('unlockItemBtn'), handleDecrypt);
  bindDivButton($('previewDropLinkBtn'), () => {
    if (!activeItem) return;
    const target = { ...activeItem };
    openDropLinkModal(target);
  });
  bindDivButton($('previewShareBtn'), () => {
    if (!activeItem) return;
    if (activeItem.encrypted) {
      showToast('Encrypted notes cannot be shared directly');
      return;
    }
    const toShare = { ...activeItem };
    closePreview();
    openSocialHub('people', toShare);
  });
  bindDivButton($('previewPinBtn'), togglePinActive);
  bindDivButton($('previewEditBtn'), toggleItemCustomizeDrawer);
  bindDivButton($('saveItemEditBtn'), saveItemCustomizations);
  bindDivButton($('previewCopyBtn'), copyActive);
  bindDivButton($('previewDownloadBtn'), downloadActive);
  bindDivButton($('previewDeleteBtn'), deleteActive);

  document.querySelectorAll('#cardColorPicker .swatch-dot').forEach((dot) => {
    bindDivButton(dot, () => {
      selectedCardAccent = dot.dataset.color;
      document.querySelectorAll('#cardColorPicker .swatch-dot').forEach((d) => d.classList.remove('active'));
      dot.classList.add('active');
    });
  });

  // GLOBAL DRAG & DROP
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!currentUser || !$('dropViewerView').classList.contains('hidden')) return;
    e.preventDefault();
    dragDepth++;
    $('dropOverlay').classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!currentUser) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if (!currentUser) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropOverlay').classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    if (!currentUser) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    if (e.dataTransfer?.files?.length) {
      storeFiles(e.dataTransfer.files);
    }
  });

  // GLOBAL CLIPBOARD PASTE
  window.addEventListener('paste', (e) => {
    if (!currentUser) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      storeFiles(files);
      return;
    }

    const text = e.clipboardData?.getData('text/plain');
    if (text && text.trim()) {
      openCreateModal('note');
      $('noteBody').value = text.trim();
      showToast('Clipboard pasted into Note');
    }
  });

  // RECONNECT LIVE STREAMS ON TAB RETURN
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentUser) {
      startInboxStream();
      startUserGroupsStream();
      if (activePeer) openConversation(activePeer);
      if (activeGroupId) openGroupRoom(activeGroupId);
    }
  });

  // STARTUP: RESTORE SESSION & RESOLVE INCOMING ?share= DROP LINK
  (async () => {
    refreshDirectory();
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (saved && saved.key) {
        currentUser = {
          key: saved.key,
          handle: saved.handle,
          displayName: saved.handle,
          bio: '',
          theme: 'indigo',
          avatarData: ''
        };
        enterWorkspace();
      }
    } catch {}

    if (pendingDropId) {
      await resolveIncomingDropLink(pendingDropId);
    }
  })();
})();