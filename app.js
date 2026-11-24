(() => {
  'use strict';

  // PRIVATE CLOUD ENDPOINTS (FIXED & HIDDEN FROM USER INTERFACE)
  const INDEX_BASE = 'https://cloud-db-studio-default-rtdb.firebaseio.com/onlymeted';
  const STORAGE_RELAY = 'https://only-me-ted.koirala57111.workers.dev';
  const STORAGE_CHANNEL = '-1003795582178';
  const STORAGE_KEY = '9082703821:AAEO2qIPOO7Y-iUN9-Lr41HjNG8I9zlM6nE';

  const SHARD_BYTES = 18 * 1024 * 1024;
  const PARALLEL_STREAMS = 3;
  const SESSION_KEY = 'onlymeted_session_v3';

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
  let activeFilter = 'all';
  let activeFolder = 'all';
  let searchQuery = '';
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
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function sanitizeKey(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  }

  function generateId() {
    return `${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
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

  // LOCAL EDGE CACHE FOR INSTANT ACCESS
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

  // CRYPTOGRAPHY (AUTH HASHING & AES-256 NOTE ENCRYPTION)
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

  // SILENT INFINITE CLOUD BLOB RELAY
  function relayHeaders() {
    return {
      'X-TG-Token': STORAGE_KEY,
      'X-TG-Chat': STORAGE_CHANNEL
    };
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
      const caption = `${currentUser.key}:${itemId}:${idx + 1}/${totalShards}`;

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

  async function downloadBufferFromCloud(meta) {
    const cacheKey = `${currentUser.key}:${meta.id}`;
    const cached = await edgeCache.get(cacheKey);
    if (cached) return cached;

    const shards = meta.shards || meta.tgShards || [];
    if (!shards.length) throw new Error('File payload unavailable');

    let completed = 0;
    const buffers = new Array(shards.length);
    setTransferProgress(true, `Loading ${meta.title}...`, 8);

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
        setTransferProgress(
          true,
          `Retrieving (${completed}/${shards.length})...`,
          10 + (completed / shards.length) * 85
        );
      }
    });
    await Promise.all(workers);

    const joined = await new Blob(buffers).arrayBuffer();
    const rawBuf = await decompressBuffer(joined, meta.compressed);
    setTransferProgress(false);

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
        const profile = {
          handle,
          displayName: handle,
          bio: 'Personal unlimited cloud vault',
          theme: 'indigo',
          avatarData: '',
          salt,
          hash,
          createdAt: Date.now()
        };
        await indexPut(`users/${key}`, profile);
        currentUser = {
          key,
          handle,
          displayName: profile.displayName,
          bio: profile.bio,
          theme: profile.theme,
          avatarData: ''
        };
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
          avatarData: existing.avatarData || ''
        };
      }

      localStorage.setItem(SESSION_KEY, JSON.stringify({ key: currentUser.key, handle: currentUser.handle }));
      enterWorkspace();
    } catch (err) {
      showToast(err.message || 'Unable to sign in');
      setAuthMode(authMode);
    }
  }

  function enterWorkspace() {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    renderUserProfileHeader();
    syncVault(true);
  }

  function signOut() {
    currentUser = null;
    itemsMap = {};
    localStorage.removeItem(SESSION_KEY);
    applyTheme('indigo');
    $('appView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('authPassword').value = '';
    setAuthMode('login');
    showToast('Signed out');
  }

  // VAULT SYNC & RENDER
  async function syncVault(silent = false) {
    if (!currentUser) return;
    $('syncText').textContent = 'Syncing';
    try {
      const [metaData, profileData] = await Promise.all([
        indexGet(`vault/${currentUser.key}/meta`),
        indexGet(`users/${currentUser.key}`)
      ]);
      itemsMap = metaData || {};
      if (profileData) {
        currentUser.displayName = profileData.displayName || currentUser.handle;
        currentUser.bio = profileData.bio || '';
        currentUser.theme = profileData.theme || 'indigo';
        currentUser.avatarData = profileData.avatarData || '';
        renderUserProfileHeader();
      }
      $('syncText').textContent = 'Synced';
      renderVault();
      if (!silent) showToast('Vault up to date');
    } catch {
      $('syncText').textContent = 'Offline';
      showToast('Could not refresh right now');
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
    const folders = Array.from(
      new Set(allItems.map((it) => (it.folder || 'General').trim()).filter(Boolean))
    ).sort();

    const bar = $('folderBar');
    if (folders.length <= 1 && folders[0] === 'General') {
      bar.classList.add('hidden');
      activeFolder = 'all';
      return;
    }

    bar.classList.remove('hidden');
    bar.innerHTML = '';

    const allChip = document.createElement('div');
    allChip.className = `filter-chip folder-chip ${activeFolder === 'all' ? 'active' : ''}`;
    allChip.textContent = 'All Folders';
    bindDivButton(allChip, () => {
      activeFolder = 'all';
      renderVault();
    });
    bar.appendChild(allChip);

    folders.forEach((folder) => {
      const chip = document.createElement('div');
      chip.className = `filter-chip folder-chip ${activeFolder === folder ? 'active' : ''}`;
      chip.textContent = `📂 ${folder}`;
      bindDivButton(chip, () => {
        activeFolder = folder;
        renderVault();
      });
      bar.appendChild(chip);
    });
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
              ${folderLabel && folderLabel !== 'General' ? `<span class="mini-tag folder">${escapeHtml(folderLabel)}</span>` : ''}
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

  // CREATE / STORE ACTIONS
  function parseTags(raw) {
    return (raw || '')
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean);
  }

  function parseFolder(raw) {
    const clean = (raw || '').trim().replace(/[.#$/[\]]/g, '');
    return clean || 'General';
  }

  async function storeFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    $('createModal').classList.add('hidden');
    const tags = parseTags($('itemTags').value);
    const folder = parseFolder($('itemFolder').value);

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
        showToast(`Stored ${file.name}`);
      } catch (err) {
        showToast(`Failed ${file.name}: ${err.message}`);
      }
    }
    setTransferProgress(false);
    $('filePicker').value = '';
    $('itemTags').value = '';
    $('itemFolder').value = '';
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
      const folder = parseFolder($('itemFolder').value);
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
      $('itemFolder').value = '';
      $('createModal').classList.add('hidden');
      showToast('Note saved');
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
      const folder = parseFolder($('itemFolder').value);
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
      $('itemFolder').value = '';
      $('createModal').classList.add('hidden');
      showToast('Link saved');
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
    $('previewTitle').textContent = item.title;
    $('previewMeta').textContent = `${formatBytes(item.size || 0)} • ${item.folder || 'General'}`;
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

      const rawBuf = await downloadBufferFromCloud(item);

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
    $('editItemFolder').value = activeItem.folder || 'General';
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
    const nextFolder = parseFolder($('editItemFolder').value);
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
          eraseRemoteShards(oldShards);

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
      eraseRemoteShards(target.shards || target.tgShards || []);
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

  // ACCOUNT CUSTOMIZATION & FULL ACCOUNT CONTROL
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

    // Storage telemetry breakdown
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
        eraseRemoteShards(it.shards || it.tgShards || []);
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
        eraseRemoteShards(it.shards || it.tgShards || []);
        await edgeCache.del(`${currentUser.key}:${it.id}`);
      }
      await Promise.all([
        indexDelete(`vault/${currentUser.key}`),
        indexDelete(`users/${currentUser.key}`)
      ]);
      $('accountModal').classList.add('hidden');
      signOut();
      showToast('Account permanently deleted');
    } catch {
      showToast('Could not delete account');
    }
  }

  function openCreateModal(tab = 'files') {
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

  bindDivButton($('headerAvatarBtn'), () => openAccountModal('profile'));
  bindDivButton($('accountBtn'), () => openAccountModal('profile'));
  bindDivButton($('closeAccountBtn'), () => $('accountModal').classList.add('hidden'));
  bindDivButton($('syncNowBtn'), () => syncVault(false));
  bindDivButton($('logoutBtn'), signOut);

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
    if (!currentUser) return;
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

  // AUTO-RESTORE SESSION
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
})();