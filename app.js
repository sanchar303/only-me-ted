(() => {
  'use strict';

  // STRICT RTDB ENDPOINT & ROOT FOLDER
  const RTDB_BASE = 'https://cloud-db-studio-default-rtdb.firebaseio.com/onlymeted';
  const SHARD_SIZE = 360 * 1024; // 360 KB Base64 shard per RTDB node
  const PARALLEL_WORKERS = 4;
  const SESSION_KEY = 'onlymeted_session_v1';

  // Disable right-click context menu
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // State
  let currentUser = null; // { key, handle }
  let authMode = 'login';
  let itemsMap = {};
  let activeFilter = 'all';
  let searchQuery = '';
  let activeItem = null;
  let activeObjectUrl = null;
  let activePlainText = '';
  let deleteConfirmArmed = false;

  // DOM Helpers
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
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
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

  // RTDB REST HELPERS
  async function rtdbGet(path) {
    const res = await fetch(`${RTDB_BASE}/${path}.json`);
    if (!res.ok) throw new Error(`RTDB GET failed (${res.status})`);
    return res.json();
  }

  async function rtdbPut(path, data) {
    const res = await fetch(`${RTDB_BASE}/${path}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`RTDB PUT failed (${res.status})`);
    return res.json();
  }

  async function rtdbPatch(path, data) {
    const res = await fetch(`${RTDB_BASE}/${path}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`RTDB PATCH failed (${res.status})`);
    return res.json();
  }

  async function rtdbDelete(path) {
    const res = await fetch(`${RTDB_BASE}/${path}.json`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`RTDB DELETE failed (${res.status})`);
  }

  // INDEXEDDB EDGE CACHE FOR INSTANT RE-OPEN
  const edgeCache = {
    dbPromise: null,
    open() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('OnlyMeTedEdgeCache', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('blobs');
        };
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
      } catch {
        // Ignore quota limits silently
      }
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

  // CRYPTO HELPERS (SHA-256 AUTH + AES-GCM 256 LOCKER)
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomHex(bytesLen = 16) {
    const arr = crypto.getRandomValues(new Uint8Array(bytesLen));
    return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
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

  // STREAM COMPRESSION & BASE64 ENGINE
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
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

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

  // PARALLEL SHARD UPLOADER & DOWNLOADER
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

  async function uploadShardedPayload(itemId, rawBuffer, label) {
    setTransferProgress(true, `Compressing ${label}...`, 8);
    const { buffer, compressed } = await compressBuffer(rawBuffer);
    const b64 = arrayBufferToBase64(buffer);
    const totalChunks = Math.max(1, Math.ceil(b64.length / SHARD_SIZE));
    let completed = 0;

    const tasks = Array.from({ length: totalChunks }, (_, idx) => async () => {
      const slice = b64.slice(idx * SHARD_SIZE, (idx + 1) * SHARD_SIZE);
      await rtdbPut(`vault/${currentUser.key}/chunks/${itemId}/c_${idx}`, slice);
      completed++;
      const pct = 12 + (completed / totalChunks) * 86;
      setTransferProgress(true, `Sharding ${label} (${completed}/${totalChunks})...`, pct);
    });

    // Worker pool
    let cursor = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_WORKERS, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const current = cursor++;
        await tasks[current]();
      }
    });
    await Promise.all(workers);

    return {
      compressed,
      compressedBytes: buffer.byteLength,
      chunkCount: totalChunks
    };
  }

  async function downloadShardedPayload(meta) {
    const cacheKey = `${currentUser.key}:${meta.id}`;
    const cached = await edgeCache.get(cacheKey);
    if (cached) return cached;

    const total = meta.chunkCount || 1;
    let completed = 0;
    const parts = new Array(total);
    setTransferProgress(true, `Fetching ${meta.title}...`, 10);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_WORKERS, total) }, async () => {
      while (cursor < total) {
        const idx = cursor++;
        const shard = await rtdbGet(`vault/${currentUser.key}/chunks/${meta.id}/c_${idx}`);
        if (shard == null) throw new Error(`Missing shard ${idx}`);
        parts[idx] = shard;
        completed++;
        setTransferProgress(true, `Reassembling (${completed}/${total})...`, 10 + (completed / total) * 85);
      }
    });
    await Promise.all(workers);

    const joinedB64 = parts.join('');
    const compressedBuf = base64ToArrayBuffer(joinedB64);
    const rawBuf = await decompressBuffer(compressedBuf, meta.compressed);
    setTransferProgress(false);

    await edgeCache.set(cacheKey, rawBuf);
    return rawBuf;
  }

  // AUTHENTICATION FLOW
  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabSignup').classList.toggle('active', mode === 'signup');
    $('confirmWrap').classList.toggle('hidden', mode === 'login');
    $('authSubmitLabel').textContent = mode === 'login' ? 'Unlock Vault' : 'Initialize Unlimited Vault';
  }

  async function handleAuthSubmit() {
    const handle = $('authUsername').value.trim();
    const key = sanitizeKey(handle);
    const pass = $('authPassword').value;
    const confirm = $('authConfirm').value;

    if (key.length < 3) {
      showToast('Handle must be at least 3 letters/numbers');
      return;
    }
    if (pass.length < 4) {
      showToast('Master Key must be at least 4 characters');
      return;
    }

    $('authSubmitLabel').textContent = 'Connecting...';
    try {
      const existing = await rtdbGet(`users/${key}`);
      if (authMode === 'signup') {
        if (existing) {
          showToast('Vault handle already claimed');
          setAuthMode('login');
          return;
        }
        if (pass !== confirm) {
          showToast('Master keys do not match');
          setAuthMode('signup');
          return;
        }
        const salt = randomHex(16);
        const hash = await sha256Hex(`${salt}:${pass}`);
        await rtdbPut(`users/${key}`, {
          handle,
          salt,
          hash,
          createdAt: Date.now()
        });
        showToast('Vault created on Cloud Studio DB');
      } else {
        if (!existing) {
          showToast('Vault not found — create one first');
          setAuthMode('signup');
          return;
        }
        const hash = await sha256Hex(`${existing.salt}:${pass}`);
        if (hash !== existing.hash) {
          showToast('Invalid Master Key');
          setAuthMode('login');
          return;
        }
      }

      currentUser = { key, handle: existing?.handle || handle };
      localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
      enterWorkspace();
    } catch (err) {
      showToast(`Sync error: ${err.message}`);
      setAuthMode(authMode);
    }
  }

  function enterWorkspace() {
    $('authView').classList.add('hidden');
    $('appView').classList.remove('hidden');
    syncVault();
  }

  function signOut() {
    currentUser = null;
    itemsMap = {};
    localStorage.removeItem(SESSION_KEY);
    $('appView').classList.add('hidden');
    $('authView').classList.remove('hidden');
    $('authPassword').value = '';
    setAuthMode('login');
    showToast('Vault locked');
  }

  // VAULT SYNC & RENDER
  async function syncVault(silent = false) {
    if (!currentUser) return;
    $('syncText').textContent = 'Syncing';
    try {
      const data = await rtdbGet(`vault/${currentUser.key}/meta`);
      itemsMap = data || {};
      $('syncText').textContent = 'Live';
      renderVault();
      if (!silent) showToast('Vault synced');
    } catch (err) {
      $('syncText').textContent = 'Offline';
      showToast(`Sync issue: ${err.message}`);
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

  function matchesFilter(item) {
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
      const hay = `${item.title || ''} ${item.snippet || ''} ${(item.tags || []).join(' ')} ${item.mime || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderVault() {
    const allItems = Object.values(itemsMap);
    const totalLogical = allItems.reduce((acc, it) => acc + (it.size || 0), 0);
    const totalCloud = allItems.reduce((acc, it) => acc + (it.compressedSize || it.size || 0), 0);
    const savedPct = totalLogical > 0 ? Math.max(0, Math.round((1 - totalCloud / totalLogical) * 100)) : 0;

    $('vaultStats').textContent =
      `${allItems.length} item${allItems.length === 1 ? '' : 's'} • ${formatBytes(totalLogical)} (${savedPct}% GZIP saved)`;

    const filtered = allItems
      .filter(matchesFilter)
      .sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((b.createdAt || 0) - (a.createdAt || 0)));

    const grid = $('vaultGrid');
    grid.innerHTML = '';

    $('emptyState').classList.toggle('hidden', filtered.length > 0);

    filtered.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'vault-item';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');

      const tagsHtml = (item.tags || [])
        .slice(0, 2)
        .map((t) => `<span class="mini-tag">#${t}</span>`)
        .join('');

      card.innerHTML = `
        <div>
          <div class="item-top">
            <div class="item-badge">${getCategoryIcon(item)}</div>
            <div class="item-badges-right">
              ${item.pinned ? '<span class="mini-tag pin">★</span>' : ''}
              ${item.encrypted ? '<span class="mini-tag lock">AES</span>' : ''}
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // STORE ACTIONS (FILES, NOTES, LINKS, CLIPBOARD)
  function parseTags() {
    return $('itemTags').value
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean);
  }

  async function storeFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    $('createModal').classList.add('hidden');
    const tags = parseTags();

    for (const file of files) {
      try {
        const id = generateId();
        const rawBuffer = await file.arrayBuffer();
        const { compressed, compressedBytes, chunkCount } = await uploadShardedPayload(id, rawBuffer, file.name);

        const meta = {
          id,
          kind: 'file',
          title: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          compressedSize: compressedBytes,
          compressed,
          chunkCount,
          encrypted: false,
          pinned: false,
          tags,
          snippet: `${file.type || 'Binary File'} • ${chunkCount} shard${chunkCount > 1 ? 's' : ''}`,
          createdAt: Date.now()
        };

        await rtdbPut(`vault/${currentUser.key}/meta/${id}`, meta);
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
      showToast('Enter an encryption passphrase (3+ chars)');
      return;
    }

    try {
      const id = generateId();
      const tags = parseTags();
      const payloadText = isEncrypted ? await encryptText(body, pass) : body;
      const rawBuffer = new TextEncoder().encode(payloadText).buffer;
      const { compressed, compressedBytes, chunkCount } = await uploadShardedPayload(id, rawBuffer, title);

      const meta = {
        id,
        kind: 'note',
        title,
        mime: 'text/plain;charset=utf-8',
        size: rawBuffer.byteLength,
        compressedSize: compressedBytes,
        compressed,
        chunkCount,
        encrypted: isEncrypted,
        pinned: false,
        tags,
        snippet: isEncrypted ? 'Encrypted AES-256 payload' : body.slice(0, 120),
        createdAt: Date.now()
      };

      await rtdbPut(`vault/${currentUser.key}/meta/${id}`, meta);
      await edgeCache.set(`${currentUser.key}:${id}`, rawBuffer);
      itemsMap[id] = meta;
      renderVault();
      setTransferProgress(false);

      $('noteTitle').value = '';
      $('noteBody').value = '';
      $('encryptPass').value = '';
      $('itemTags').value = '';
      $('createModal').classList.add('hidden');
      showToast(isEncrypted ? 'Encrypted note saved' : 'Note saved');
    } catch (err) {
      setTransferProgress(false);
      showToast(`Error: ${err.message}`);
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
      const tags = parseTags();
      const meta = {
        id,
        kind: 'link',
        title,
        url,
        mime: 'text/uri-list',
        size: url.length,
        compressedSize: url.length,
        compressed: false,
        chunkCount: 0,
        encrypted: false,
        pinned: false,
        tags,
        snippet: url,
        createdAt: Date.now()
      };

      await rtdbPut(`vault/${currentUser.key}/meta/${id}`, meta);
      itemsMap[id] = meta;
      renderVault();

      $('linkUrl').value = '';
      $('linkTitle').value = '';
      $('itemTags').value = '';
      $('createModal').classList.add('hidden');
      showToast('Link bookmarked');
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  // UNIVERSAL PREVIEWER
  function closePreview() {
    $('previewModal').classList.add('hidden');
    $('previewViewport').innerHTML = '';
    $('decryptPrompt').classList.add('hidden');
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
    activeItem = null;
    activePlainText = '';
    deleteConfirmArmed = false;
  }

  async function openPreview(item) {
    closePreview();
    activeItem = item;
    $('previewTitle').textContent = item.title;
    $('previewMeta').textContent = `${formatBytes(item.size || 0)} • ${item.mime || item.kind}`;
    $('previewPinBtn').style.color = item.pinned ? '#fbbf24' : '';
    $('previewModal').classList.remove('hidden');

    const viewport = $('previewViewport');
    viewport.innerHTML = '<div class="muted-sub">Loading from sharded cloud...</div>';

    try {
      if (item.kind === 'link') {
        activePlainText = item.url;
        viewport.innerHTML = `
          <div style="text-align:center; display:flex; flex-direction:column; gap:14px; width:100%;">
            <div class="preview-text-box" style="text-align:center;">${escapeHtml(item.url)}</div>
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="pill-btn primary-pill" style="text-decoration:none; max-width:240px; margin:0 auto;">Open Destination ↗</a>
          </div>
        `;
        return;
      }

      const rawBuf = await downloadShardedPayload(item);

      if (item.encrypted) {
        viewport.classList.add('hidden');
        $('decryptPrompt').classList.remove('hidden');
        $('decryptInput').value = '';
        $('decryptInput').dataset.rawB64 = arrayBufferToBase64(rawBuf);
        return;
      }

      viewport.classList.remove('hidden');
      renderUnencryptedPayload(item, rawBuf);
    } catch (err) {
      setTransferProgress(false);
      viewport.innerHTML = `<div class="muted-sub">Failed to load: ${escapeHtml(err.message)}</div>`;
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
          <div class="muted-sub">${formatBytes(item.size || 0)} • Ready for instant download</div>
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
      $('previewViewport').innerHTML = `<div class="preview-text-box">${escapeHtml(plain)}</div>`;
      showToast('Decrypted');
    } catch {
      showToast('Incorrect passphrase');
    }
  }

  async function togglePinActive() {
    if (!activeItem) return;
    const nextPin = !activeItem.pinned;
    activeItem.pinned = nextPin;
    itemsMap[activeItem.id].pinned = nextPin;
    $('previewPinBtn').style.color = nextPin ? '#fbbf24' : '';
    renderVault();
    await rtdbPatch(`vault/${currentUser.key}/meta/${activeItem.id}`, { pinned: nextPin });
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
      showToast('Wait for payload to finish loading');
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
      showToast('Tap delete again to permanently erase');
      setTimeout(() => { deleteConfirmArmed = false; }, 3500);
      return;
    }
    const targetId = activeItem.id;
    closePreview();
    try {
      await Promise.all([
        rtdbDelete(`vault/${currentUser.key}/meta/${targetId}`),
        rtdbDelete(`vault/${currentUser.key}/chunks/${targetId}`),
        edgeCache.del(`${currentUser.key}:${targetId}`)
      ]);
      delete itemsMap[targetId];
      renderVault();
      showToast('Erased from cloud');
    } catch (err) {
      showToast(`Delete failed: ${err.message}`);
    }
  }

  async function exportVaultManifest() {
    if (!currentUser) return;
    const payload = JSON.stringify({
      app: 'Only Me Ted',
      vault: currentUser.handle,
      exportedAt: new Date().toISOString(),
      items: itemsMap
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `onlymeted-${currentUser.key}-manifest.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Vault manifest exported');
  }

  // CREATE MODAL TABS
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

  bindDivButton($('syncNowBtn'), () => syncVault(false));
  bindDivButton($('exportVaultBtn'), exportVaultManifest);
  bindDivButton($('logoutBtn'), signOut);

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
  bindDivButton($('previewCopyBtn'), copyActive);
  bindDivButton($('previewDownloadBtn'), downloadActive);
  bindDivButton($('previewDeleteBtn'), deleteActive);

  // GLOBAL DRAG & DROP ANYWHERE IN WORKSPACE
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

  // GLOBAL CTRL+V / CMD+V CLIPBOARD CAPTURE
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
      currentUser = saved;
      enterWorkspace();
    }
  } catch {}
})();
