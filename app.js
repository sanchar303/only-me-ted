(() => {
  'use strict';

  // STRICT RTDB ENDPOINT & ROOT FOLDER (METADATA & AUTH ONLY — 0 KB FILE TRAFFIC)
  const RTDB_BASE = 'https://cloud-db-studio-default-rtdb.firebaseio.com/onlymeted';
  // 18 MB raw binary shard stays safely below Telegram's 20 MB getFile download limit
  const TG_SHARD_BYTES = 18 * 1024 * 1024;
  const PARALLEL_DOWNLOADS = 3;
  const SESSION_KEY = 'onlymeted_session_v2';

  document.addEventListener('contextmenu', (e) => e.preventDefault());

  let currentUser = null;
  let authMode = 'login';
  let itemsMap = {};
  let tgConfig = { workerUrl: '', botToken: '', chatId: '' };
  let activeFilter = 'all';
  let searchQuery = '';
  let activeItem = null;
  let activeObjectUrl = null;
  let activePlainText = '';
  let deleteConfirmArmed = false;

  const $ = (id) => document.getElementById(id);

  function showToast(msg, ms = 2700) {
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

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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

  // INDEXEDDB EDGE CACHE FOR ZERO-LATENCY REPEAT ACCESS
  const edgeCache = {
    dbPromise: null,
    open() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('OnlyMeTedTgCache', 1);
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

  // CRYPTO HELPERS
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

  // STREAM GZIP COMPRESSION
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

  // TELEGRAM ENGINE HELPERS
  function getWorkerBase() {
    return (tgConfig.workerUrl || '').trim().replace(/\/+$/, '');
  }

  function getTgHeaders() {
    const headers = {};
    if (tgConfig.botToken) headers['X-TG-Token'] = tgConfig.botToken.trim();
    if (tgConfig.chatId) headers['X-TG-Chat'] = tgConfig.chatId.trim();
    return headers;
  }

  function updateEngineStatusUI() {
    const configured = Boolean(getWorkerBase());
    $('setupBanner').classList.toggle('hidden', configured);
    const pill = $('syncDot');
    if (configured) {
      pill.classList.remove('warn');
      $('syncText').textContent = 'TG Live';
    } else {
      pill.classList.add('warn');
      $('syncText').textContent = 'Setup TG';
    }
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

  async function uploadSingleShardToTelegram(blobSlice, shardName, caption) {
    const workerUrl = getWorkerBase();
    if (!workerUrl) throw new Error('Configure Telegram Engine in Settings (⚙) first');

    while (true) {
      const form = new FormData();
      form.append('document', blobSlice, shardName);
      form.append('caption', caption);

      const res = await fetch(`${workerUrl}/upload`, {
        method: 'POST',
        headers: getTgHeaders(),
        body: form
      });
      const data = await res.json();

      if (res.status === 429 && data.retryAfter) {
        await sleep((data.retryAfter + 1) * 1000);
        continue;
      }

      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Telegram upload failed (${res.status})`);
      }

      return {
        fileId: data.fileId,
        messageId: data.messageId,
        bytes: blobSlice.size
      };
    }
  }

  async function uploadBufferToTelegram(itemId, rawBuffer, label) {
    setTransferProgress(true, `Preparing ${label}...`, 6);
    const { buffer, compressed } = await compressBuffer(rawBuffer);
    const totalBytes = buffer.byteLength;
    const totalShards = Math.max(1, Math.ceil(totalBytes / TG_SHARD_BYTES));
    const tgShards = [];

    for (let idx = 0; idx < totalShards; idx++) {
      const start = idx * TG_SHARD_BYTES;
      const end = Math.min(totalBytes, start + TG_SHARD_BYTES);
      const slice = new Blob([buffer.slice(start, end)], { type: 'application/octet-stream' });
      const shardName = `${itemId}_part${idx + 1}of${totalShards}.omt`;
      const caption = `OnlyMeTed | ${currentUser.handle} | ${label} [${idx + 1}/${totalShards}]`;

      setTransferProgress(
        true,
        `Streaming to Telegram (${idx + 1}/${totalShards})...`,
        10 + (idx / totalShards) * 85
      );

      const shardRef = await uploadSingleShardToTelegram(slice, shardName, caption);
      tgShards.push(shardRef);

      // Gentle pacing to avoid Telegram per-chat 429 rate limits on multi-part uploads
      if (idx < totalShards - 1) await sleep(650);
    }

    return {
      compressed,
      storedBytes: totalBytes,
      tgShards
    };
  }

  async function downloadBufferFromTelegram(meta) {
    const cacheKey = `${currentUser.key}:${meta.id}`;
    const cached = await edgeCache.get(cacheKey);
    if (cached) return cached;

    const workerUrl = getWorkerBase();
    if (!workerUrl) throw new Error('Configure Telegram Engine in Settings (⚙) first');

    const shards = meta.tgShards || [];
    if (!shards.length) throw new Error('No Telegram shards linked to this entry');

    let completed = 0;
    const buffers = new Array(shards.length);
    setTransferProgress(true, `Fetching ${meta.title} from Telegram...`, 8);

    let cursor = 0;
    const workers = Array.from({ length: Math.min(PARALLEL_DOWNLOADS, shards.length) }, async () => {
      while (cursor < shards.length) {
        const idx = cursor++;
        const shard = shards[idx];
        const res = await fetch(
          `${workerUrl}/download?file_id=${encodeURIComponent(shard.fileId)}`,
          { headers: getTgHeaders() }
        );
        if (!res.ok) {
          let errMsg = `Shard ${idx + 1} download failed (${res.status})`;
          try {
            const j = await res.json();
            if (j.error) errMsg = j.error;
          } catch {}
          throw new Error(errMsg);
        }
        buffers[idx] = await res.arrayBuffer();
        completed++;
        setTransferProgress(
          true,
          `Downloading (${completed}/${shards.length})...`,
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
    syncVault(true);
  }

  function signOut() {
    currentUser = null;
    itemsMap = {};
    tgConfig = { workerUrl: '', botToken: '', chatId: '' };
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
      const [metaData, cfgData] = await Promise.all([
        rtdbGet(`vault/${currentUser.key}/meta`),
        rtdbGet(`vault/${currentUser.key}/tgConfig`)
      ]);
      itemsMap = metaData || {};
      if (cfgData) {
        tgConfig = {
          workerUrl: cfgData.workerUrl || '',
          botToken: cfgData.botToken || '',
          chatId: cfgData.chatId || ''
        };
      }
      updateEngineStatusUI();
      renderVault();
      if (!silent) showToast('Index synced');
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderVault() {
    const allItems = Object.values(itemsMap);
    const totalTgBytes = allItems.reduce((acc, it) => acc + (it.size || 0), 0);
    const approxMetaBytes = JSON.stringify(itemsMap).length;

    $('vaultStats').textContent =
      `${allItems.length} item${allItems.length === 1 ? '' : 's'} • ${formatBytes(totalTgBytes)} on Telegram • ${formatBytes(approxMetaBytes)} RTDB index`;

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

      const shardCount = (item.tgShards || []).length;
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
              ${item.encrypted ? '<span class="mini-tag lock">AES</span>' : ''}
              ${shardCount > 0 ? `<span class="mini-tag tg">TG×${shardCount}</span>` : ''}
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

  // TELEGRAM SETTINGS MODAL
  function openSettingsModal() {
    $('cfgWorkerUrl').value = tgConfig.workerUrl || '';
    $('cfgBotToken').value = tgConfig.botToken || '';
    $('cfgChatId').value = tgConfig.chatId || '';
    $('settingsModal').classList.remove('hidden');
  }

  async function saveEngineConfig() {
    const nextCfg = {
      workerUrl: $('cfgWorkerUrl').value.trim().replace(/\/+$/, ''),
      botToken: $('cfgBotToken').value.trim(),
      chatId: $('cfgChatId').value.trim()
    };
    if (!nextCfg.workerUrl) {
      showToast('Enter your Cloudflare Worker URL');
      return;
    }
    try {
      await rtdbPut(`vault/${currentUser.key}/tgConfig`, nextCfg);
      tgConfig = nextCfg;
      updateEngineStatusUI();
      $('settingsModal').classList.add('hidden');
      showToast('Telegram engine synced to all devices');
    } catch (err) {
      showToast(`Save failed: ${err.message}`);
    }
  }

  async function testEnginePing() {
    const workerUrl = $('cfgWorkerUrl').value.trim().replace(/\/+$/, '');
    if (!workerUrl) {
      showToast('Enter Worker URL first');
      return;
    }
    const headers = {};
    const tok = $('cfgBotToken').value.trim();
    const chat = $('cfgChatId').value.trim();
    if (tok) headers['X-TG-Token'] = tok;
    if (chat) headers['X-TG-Chat'] = chat;

    try {
      showToast('Pinging Telegram Bot API...');
      const res = await fetch(`${workerUrl}/ping`, { headers });
      const data = await res.json();
      if (data.ok && data.result?.username) {
        showToast(`Connected: @${data.result.username}`);
      } else {
        showToast(`Ping error: ${data.error || data.description || 'Check token'}`);
      }
    } catch (err) {
      showToast(`Worker unreachable: ${err.message}`);
    }
  }

  // STORE ACTIONS
  function parseTags() {
    return $('itemTags').value
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]/g, ''))
      .filter(Boolean);
  }

  async function storeFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!getWorkerBase()) {
      openSettingsModal();
      showToast('Configure Telegram Engine first');
      return;
    }

    $('createModal').classList.add('hidden');
    const tags = parseTags();

    for (const file of files) {
      try {
        const id = generateId();
        const rawBuffer = await file.arrayBuffer();
        const { compressed, storedBytes, tgShards } = await uploadBufferToTelegram(id, rawBuffer, file.name);

        const meta = {
          id,
          kind: 'file',
          title: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          storedBytes,
          compressed,
          tgShards,
          encrypted: false,
          pinned: false,
          tags,
          snippet: `${file.type || 'Binary File'} • ${tgShards.length} TG shard${tgShards.length > 1 ? 's' : ''}`,
          createdAt: Date.now()
        };

        await rtdbPut(`vault/${currentUser.key}/meta/${id}`, meta);
        await edgeCache.set(`${currentUser.key}:${id}`, rawBuffer);
        itemsMap[id] = meta;
        renderVault();
        showToast(`Stored ${file.name} on Telegram`);
      } catch (err) {
        showToast(`Failed ${file.name}: ${err.message}`);
      }
    }
    setTransferProgress(false);
    $('filePicker').value = '';
    $('itemTags').value = '';
  }

  async function storeNote() {
    if (!getWorkerBase()) {
      openSettingsModal();
      showToast('Configure Telegram Engine first');
      return;
    }

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
      const { compressed, storedBytes, tgShards } = await uploadBufferToTelegram(id, rawBuffer, `${title}.txt`);

      const meta = {
        id,
        kind: 'note',
        title,
        mime: 'text/plain;charset=utf-8',
        size: rawBuffer.byteLength,
        storedBytes,
        compressed,
        tgShards,
        encrypted: isEncrypted,
        pinned: false,
        tags,
        snippet: isEncrypted ? 'Encrypted AES-256 note on Telegram' : body.slice(0, 120),
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
      showToast(isEncrypted ? 'Encrypted note saved to Telegram' : 'Note saved to Telegram');
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
        tgShards: [],
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
      showToast('Bookmark saved');
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
    viewport.classList.remove('hidden');
    viewport.innerHTML = '<div class="muted-sub">Streaming from Telegram CDN...</div>';

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

      const rawBuf = await downloadBufferFromTelegram(item);

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
          <div class="muted-sub">${formatBytes(item.size || 0)} • Reassembled from ${(item.tgShards || []).length} Telegram shard(s)</div>
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
      showToast('Wait for Telegram stream to finish');
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
      showToast('Tap delete again to erase from RTDB & Telegram');
      setTimeout(() => { deleteConfirmArmed = false; }, 3500);
      return;
    }
    const target = activeItem;
    closePreview();
    try {
      const messageIds = (target.tgShards || []).map((s) => s.messageId).filter(Boolean);
      const workerUrl = getWorkerBase();
      if (workerUrl && messageIds.length) {
        fetch(`${workerUrl}/delete`, {
          method: 'POST',
          headers: { ...getTgHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds })
        }).catch(() => {});
      }
      await Promise.all([
        rtdbDelete(`vault/${currentUser.key}/meta/${target.id}`),
        edgeCache.del(`${currentUser.key}:${target.id}`)
      ]);
      delete itemsMap[target.id];
      renderVault();
      showToast('Erased from Vault & Telegram');
    } catch (err) {
      showToast(`Delete failed: ${err.message}`);
    }
  }

  function exportVaultManifest() {
    if (!currentUser) return;
    const payload = JSON.stringify({
      app: 'Only Me Ted',
      storageEngine: 'Telegram Bot API Sharded Index',
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
    showToast('Manifest exported');
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

  // BINDINGS
  bindDivButton($('tabLogin'), () => setAuthMode('login'));
  bindDivButton($('tabSignup'), () => setAuthMode('signup'));
  bindDivButton($('authSubmitBtn'), handleAuthSubmit);

  [$('authUsername'), $('authPassword'), $('authConfirm')].forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAuthSubmit();
    });
  });

  bindDivButton($('settingsBtn'), openSettingsModal);
  bindDivButton($('openSetupFromBanner'), openSettingsModal);
  bindDivButton($('closeSettingsBtn'), () => $('settingsModal').classList.add('hidden'));
  bindDivButton($('saveEngineBtn'), saveEngineConfig);
  bindDivButton($('testEngineBtn'), testEnginePing);

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

  // DRAG & DROP
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

  // GLOBAL PASTE
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