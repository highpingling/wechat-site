// chat.js
// 前端聊天管理：导入/导出、File System Access 自动保存（Chromium/Brave）、IndexedDB 备份、记忆 chunk 管理与 /api/summarize 占位调用
// 设计目标：最小可行实现（Option A）

const DB_NAME = 'wechat_chat_db_v1';
const HANDLE_STORE = 'file_handles';
const BACKUP_STORE = 'backups';

// 简单 IndexedDB helper
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(BACKUP_STORE)) db.createObjectStore(BACKUP_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store, key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const r = s.put(value, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Chat state
const ChatManager = {
  messages: [], // {role:'me'|'assistant', text, ts}
  memoryChunks: [], // {id, summary, createdAt, score?: number}
  recentN: 25,
  autosave: false,
  savedFileHandle: null, // FileSystemFileHandle (Chromium)
  messagesSinceLastSummarize: 0,
  summarizeThreshold: 30, // 改为 30 条触发总结
  maxMemoryChunks: 40,
  lastSummarizeTime: 0, // 记录上次总结时间
  initOptions: {},

  async init(opts = {}) {
    this.initOptions = opts;
    // bind UI
    this.chatMessagesEl = opts.chatMessagesEl;
    this.addMessageFn = opts.addMessageFn; // function to render message to UI
    // load config from localStorage
    this.recentN = parseInt(localStorage.getItem('recentN') || '25', 10);
    this.autosave = localStorage.getItem('autosave') === 'true';
    // load saved handle if any
    try {
      const handle = await idbGet(HANDLE_STORE, 'savedFileHandle');
      if (handle) this.savedFileHandle = handle;
    } catch (e) {
      console.warn('no saved file handle in idb', e);
    }

    // hook UI controls if present
    const importBtn = document.getElementById('import-btn');
    const exportBtn = document.getElementById('export-btn');
    const autosaveToggle = document.getElementById('autosave-toggle');
    const recentSelect = document.getElementById('recent-n-select');

    if (importBtn) importBtn.addEventListener('click', () => this.triggerImport());
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportCurrentSession());
    if (autosaveToggle) {
      autosaveToggle.checked = this.autosave;
      autosaveToggle.addEventListener('change', (e) => {
        this.autosave = e.target.checked;
        localStorage.setItem('autosave', this.autosave);
        if (this.autosave) this.ensureSaveSchedule();
      });
    }
    if (recentSelect) {
      recentSelect.value = String(this.recentN);
      recentSelect.addEventListener('change', (e) => {
        this.recentN = parseInt(e.target.value, 10);
        localStorage.setItem('recentN', String(this.recentN));
      });
    }

    // load backup messages if exist
    const backup = await idbGet(BACKUP_STORE, 'latest_session');
    if (backup && Array.isArray(backup.messages) && backup.messages.length) {
      // we don't auto-restore here; let user import via modal on start
      console.log('found backup session in indexeddb:', backup);
    }

    // show startup modal to import or start new
    this.showStartupModal();

    // periodic auto backup to IndexedDB
    setInterval(() => this.backupToIndexedDB(), 30_000); // every 30s

    // schedule periodic summarize check (每3分钟检查一次)
    setInterval(() => this.maybeSummarizeByTime(), 180_000);

    // beforeunload attempt to save
    window.addEventListener('beforeunload', (e) => {
      // try to save synchronously via file handle if available (best-effort)
      if (this.savedFileHandle) {
        e.preventDefault();
        // Note: writing during beforeunload may not be allowed in all browsers
        try {
          this.writeToSavedFile();
        } catch (err) {
          console.warn('write on beforeunload failed', err);
        }
      } else if (this.autosave) {
        // trigger a download fallback (may be blocked)
        try { this.downloadBackup(); } catch (err) { console.warn(err); }
      }
    });

    // expose helper on window
    window.ChatManager = this;
  },

  async showStartupModal() {
    // create a modal asking import previous chat or start new
    const modal = document.createElement('div');
    Object.assign(modal.style, {
      position: 'fixed', zIndex: 2000, left:0,top:0,right:0,bottom:0,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.5)'
    });
    const box = document.createElement('div');
    Object.assign(box.style, {background:'#fff',padding:'18px',borderRadius:'8px',width:'90%',maxWidth:'480px'});
    box.innerHTML = `
      <h3 style="margin-top:0">导入历史聊天或开始新会话</h3>
      <div style="margin-bottom:12px">你可以导入本地 `.trim() + `.txt 文件以恢复历史，或开始新的会话（默认保留 IndexedDB 备份）。</div>
    `;
    const importInput = document.createElement('input');
    importInput.type = 'file';
    importInput.accept = '.txt,.json,text/plain';
    importInput.style.display = 'block';
    importInput.style.marginBottom = '8px';
    const importBtn = document.createElement('button');
    importBtn.textContent = '导入所选文件并恢复';
    importBtn.style.marginRight = '8px';
    const newBtn = document.createElement('button');
    newBtn.textContent = '开始新会话';
    const note = document.createElement('div');
    note.style.marginTop = '12px';
    note.style.fontSize = '13px';
    note.style.color = '#666';
    note.textContent = '提示：导入后旧历史会被读取并可选择是否压缩为 memory chunk。';

    box.appendChild(importInput);
    box.appendChild(importBtn);
    box.appendChild(newBtn);
    box.appendChild(note);
    modal.appendChild(box);
    document.body.appendChild(modal);

    importBtn.addEventListener('click', async () => {
      const file = importInput.files && importInput.files[0];
      if (!file) return alert('请先选择一个 .txt 文件');
      const imported = await this.importChatFromFile(file);
      if (imported) {
        // restore messages to UI
        this.messages = imported.chats.map(c => ({ role: c.role === 'assistant' || c.role === 'boyfriend' ? 'assistant' : 'user', text: c.text, ts: c.ts || Date.now() }));
        this.renderAllMessages();
        // after importing, optionally call summarize for older history (placeholder)
        await this.summarizeOlderHistoryIfAny();
        alert('导入成功');
        document.body.removeChild(modal);
      }
    });

    newBtn.addEventListener('click', () => {
      // start fresh: clear messages and memory
      this.messages = [];
      this.memoryChunks = [];
      this.renderAllMessages();
      document.body.removeChild(modal);
    });
  },

  renderAllMessages() {
    if (!this.chatMessagesEl) return;
    this.chatMessagesEl.innerHTML = '';
    for (const m of this.messages) {
      if (this.addMessageFn) this.addMessageFn(m.text, m.role === 'user' ? 'me' : 'boyfriend', m.role !== 'user');
    }
  },

  async importChatFromFile(file) {
    const text = await file.text();
    const parts = text.split('\n----CHAT-JSON----\n');
    let meta = {};
    let chats = [];
    try {
      if (parts.length === 2) {
        meta = JSON.parse(parts[0]);
        chats = JSON.parse(parts[1]);
      } else {
        // try parse whole
        chats = JSON.parse(text);
      }

      // 如果导入的消息超过 recentN，立即进行批量总结
      if (chats.length > this.recentN) {
        const progress = document.createElement('div');
        progress.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:10000;';
        progress.innerHTML = '<div>正在处理历史消息...</div><div id="import-progress" style="margin-top:10px;color:#666;"></div>';
        document.body.appendChild(progress);
        
        const updateProgress = (text) => {
          const el = document.getElementById('import-progress');
          if (el) el.textContent = text;
        };

        try {
          // 保留最近的消息
          const recentMessages = chats.slice(-this.recentN);
          // 对早期消息分批总结（每30条一组）
          const olderMessages = chats.slice(0, -this.recentN);
          const batchSize = 30;
          const batches = [];
          
          for (let i = 0; i < olderMessages.length; i += batchSize) {
            const batch = olderMessages.slice(i, i + batchSize);
            updateProgress(`正在总结第 ${i+1}-${Math.min(i+batchSize, olderMessages.length)} 条消息，共 ${olderMessages.length} 条`);
            try {
              const resp = await fetch('/api/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: batch, target_token: 300 })
              });
              if (resp.ok) {
                const data = await resp.json();
                const summary = data.summary || `摘要(${batch.length}条): ` + batch.slice(-5).map(m=>m.text).join(' | ');
                batches.push({ id: 'mc_' + Date.now() + '_' + i, summary, createdAt: Date.now() });
              }
            } catch (e) {
              console.warn('batch summarize failed:', e);
              // fallback: simple concat
              const summary = `摘要(${batch.length}条): ` + batch.slice(-5).map(m=>m.text).join(' | ');
              batches.push({ id: 'mc_' + Date.now() + '_' + i, summary, createdAt: Date.now() });
            }
            await new Promise(r => setTimeout(r, 100)); // 避免请求过快
          }

          // 更新状态
          this.memoryChunks.push(...batches);
          chats = recentMessages; // 只保留最近的消息
          updateProgress(`完成！已保留最近 ${this.recentN} 条消息，${batches.length} 个历史摘要可被检索。`);
          
          // 清理进度条
          setTimeout(() => {
            if (progress.parentNode) {
              progress.parentNode.removeChild(progress);
            }
          }, 3000);
          
        } catch (e) {
          console.error('batch summarize failed:', e);
          if (progress.parentNode) {
            progress.parentNode.removeChild(progress);
          }
          alert('历史消息处理过程出错，将只保留最近的消息');
          chats = chats.slice(-this.recentN);
        }
      }
    } catch (e) {
      alert('无法解析文件，确保是由本系统或兼容格式导出的 .txt');
      console.error(e);
      return null;
    }
    return { meta, chats };
  },

  async exportCurrentSession() {
    const filename = `chat-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
    const data = this.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, ts: m.ts }));
    const header = JSON.stringify({ version:1, exportedAt: new Date().toISOString(), length: data.length });
    const content = JSON.stringify(data, null, 2);
    const text = header + '\n----CHAT-JSON----\n' + content;

    // Prefer File System Access API if available and have handle or user agrees to choose
    if ('showSaveFilePicker' in window) {
      try {
        if (!this.savedFileHandle) {
          const opts = { suggestedName: filename, types: [{ description: 'Text', accept: {'text/plain':['.txt'] } }] };
          const handle = await window.showSaveFilePicker(opts);
          this.savedFileHandle = handle;
          // store in IndexedDB (structured clone of handle works in Chromium)
          try { await idbPut(HANDLE_STORE, 'savedFileHandle', handle); } catch(e){console.warn('store handle failed', e);}        
        }
        await this.writeToSavedFile(text);
        alert('会话已保存（覆盖保存）：' + (this.savedFileHandle.name || filename));
        return;
      } catch (err) {
        console.warn('File System Access write failed, fallback to download', err);
        // fallback to download
      }
    }

    // fallback: download blob
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    alert('会话已下载到默认下载目录：' + filename);
  },

  async writeToSavedFile(content) {
    if (!this.savedFileHandle) throw new Error('no savedFileHandle');
    const writable = await this.savedFileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  },

  async triggerImport() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.txt,.json,text/plain';
    input.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const imported = await this.importChatFromFile(f);
      if (imported) {
        this.messages = imported.chats.map(c => ({ role: c.role === 'assistant' || c.role === 'boyfriend' ? 'assistant' : 'user', text: c.text, ts: c.ts || Date.now() }));
        this.renderAllMessages();
        await this.summarizeOlderHistoryIfAny();
        alert('导入并恢复完成');
      }
    };
    input.click();
  },

  async backupToIndexedDB() {
    try {
      await idbPut(BACKUP_STORE, 'latest_session', { messages: this.messages, memoryChunks: this.memoryChunks, ts: Date.now() });
      // console.log('backup saved to indexeddb');
    } catch (e) { console.warn('backup failed', e); }
  },

  downloadBackup() {
    const filename = `chat-backup-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
    const data = this.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, ts: m.ts }));
    const header = JSON.stringify({ version:1, exportedAt: new Date().toISOString(), length: data.length });
    const content = JSON.stringify(data, null, 2);
    const text = header + '\n----CHAT-JSON----\n' + content;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  },

  ensureSaveSchedule() {
    if (this.autosave) {
      // force a save every minute
      if (this._autosaveInterval) clearInterval(this._autosaveInterval);
      this._autosaveInterval = setInterval(() => {
        if (this.savedFileHandle) this.writeToSavedFile(this._buildExportText()); else this.downloadBackup();
      }, 60_000);
    } else {
      if (this._autosaveInterval) clearInterval(this._autosaveInterval);
      this._autosaveInterval = null;
    }
  },

  _buildExportText() {
    const filename = `chat-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.txt`;
    const data = this.messages.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, ts: m.ts }));
    const header = JSON.stringify({ version:1, exportedAt: new Date().toISOString(), length: data.length });
    const content = JSON.stringify(data, null, 2);
    return header + '\n----CHAT-JSON----\n' + content;
  },

  // 更新调试面板信息
  _updateDebugPanel() {
    if (!document) return; // 如果在非浏览器环境，直接返回
    
    // 更新消息统计
    const activeMessages = document.getElementById('debug-active-messages');
    if (activeMessages) activeMessages.textContent = this.messages.length;
    
    const memoryChunks = document.getElementById('debug-memory-chunks');
    if (memoryChunks) memoryChunks.textContent = this.memoryChunks.length;

    // 更新最近一次API调用信息
    const tokens = document.getElementById('debug-tokens');
    const usedChunks = document.getElementById('debug-used-chunks');
    
    if (this._lastPayload) {
      // 估算token数（粗略估算：每个英文单词4个字符，每个中文字符算1个token）
      const text = JSON.stringify(this._lastPayload);
      const tokenEstimate = Math.ceil(text.length / 4);
      if (tokens) tokens.textContent = tokenEstimate;
      if (usedChunks) usedChunks.textContent = (this._lastPayload.memory_chunks || []).length;
    }

    // 自动隐藏开关按钮
    const toggle = document.getElementById('debug-toggle');
    const panel = document.getElementById('debug-panel');
    if (toggle && panel) {
      toggle.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    }
  },

  async maybeSummarizeByTime() {
    const now = Date.now();
    // 条件1：消息数量超过阈值
    const shouldSummarizeByCount = this.messagesSinceLastSummarize >= this.summarizeThreshold;
    // 条件2：距离上次总结超过3分钟且有新消息
    const shouldSummarizeByTime = this.messagesSinceLastSummarize > 0 && 
      (now - this.lastSummarizeTime) > 180_000;

    if (shouldSummarizeByCount || shouldSummarizeByTime) {
      await this.summarizeOlderHistoryIfAny();
      this.messagesSinceLastSummarize = 0;
      this.lastSummarizeTime = now;
    }
  },

  async summarizeOlderHistoryIfAny() {
    // find messages older than recentN
    if (this.messages.length <= this.recentN) return;
    const older = this.messages.slice(0, this.messages.length - this.recentN);
    if (!older.length) return;
    // placeholder: call backend /api/summarize with older messages
    try {
      const resp = await fetch('/api/summarize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: older.map(m => ({role: m.role, text: m.text, ts: m.ts})), target_token: 300 })
      });
      if (resp.ok) {
        const data = await resp.json();
        const summaryText = data.summary || data.result || (`摘要(${older.length}条): ` + older.slice(-10).map(m=>m.text).join(' | '));
        // push memory chunk
        this.memoryChunks.push({ id: 'mc_' + Date.now(), summary: summaryText, createdAt: Date.now() });
        // remove older messages from main timeline (we keep recentN)
        this.messages = this.messages.slice(this.messages.length - this.recentN);
        // cap memory chunks
        await this.capMemoryChunks();
      } else {
        console.warn('summarize endpoint returned', resp.status);
      }
    } catch (e) {
      console.warn('summarize failed (placeholder)', e);
      // fallback: create simple summary from first/last
      const summaryText = `自动摘要(${older.length}条)：` + older.slice(-10).map(m=>m.text).join(' | ');
      this.memoryChunks.push({ id: 'mc_' + Date.now(), summary: summaryText, createdAt: Date.now() });
      this.messages = this.messages.slice(this.messages.length - this.recentN);
    }
    // persist backup
    await this.backupToIndexedDB();
  },

  async capMemoryChunks() {
    while (this.memoryChunks.length > this.maxMemoryChunks) {
      // merge the oldest two into one summary by calling summarize endpoint
      const a = this.memoryChunks.shift();
      const b = this.memoryChunks.shift();
      try {
        const resp = await fetch('/api/summarize', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ messages: [{role:'system', text: a.summary}, {role:'system', text: b.summary}], target_token: 400 })
        });
        if (resp.ok) {
          const data = await resp.json();
          const combined = data.summary || (a.summary + '\n' + b.summary);
          this.memoryChunks.unshift({ id: 'mc_' + Date.now(), summary: combined, createdAt: Date.now() });
        } else {
          this.memoryChunks.unshift({ id: 'mc_' + Date.now(), summary: a.summary + '\n' + b.summary, createdAt: Date.now() });
        }
      } catch (e) {
        this.memoryChunks.unshift({ id: 'mc_' + Date.now(), summary: a.summary + '\n' + b.summary, createdAt: Date.now() });
      }
    }
    await this.backupToIndexedDB();
  },

  // When preparing to send to LLM, attach top-k relevant memory chunks (placeholder using naive text matching)
  async getContextForPrompt(queryText, k=3) {
    // If backend embedding endpoint exists, call it instead. Here we do a naive substring score.
    const scores = this.memoryChunks.map(mc => {
      const q = queryText.toLowerCase();
      const s = mc.summary.toLowerCase();
      let score = 0;
      if (s.includes(q)) score += 10;
      const common = q.split(/\s+/).filter(w => w && s.includes(w));
      score += common.length;
      return {mc, score};
    });
    scores.sort((a,b)=>b.score-a.score);
    return scores.slice(0,k).map(x=>x.mc);
  },

  // to be called when sending a message to backend - increments counters and returns assembled payload
  async preparePayloadForBackend(userMessage) {
    // get recentN messages
    const recent = this.messages.slice(-this.recentN);
    // get relevant memory chunks
    const relevant = await this.getContextForPrompt(userMessage.text, 3);
    // assemble a payload
    const payload = {
      recent_messages: recent,
      memory_chunks: relevant,
      user_message: userMessage,
      meta: {recentN: this.recentN}
    };
    // 保存最后一次payload用于调试显示
    this._lastPayload = payload;
    this._updateDebugPanel();
    return payload;
  },

  // call this when a new user message accepted by UI (so ChatManager updates internal state)
  onUserMessage(text) {
    const m = { role: 'user', text, ts: Date.now() };
    this.messages.push(m);
    this.messagesSinceLastSummarize += 1;
    // backup
    this.backupToIndexedDB();
    // 更新调试面板
    this._updateDebugPanel();
  }
};

// export to window
window.ChatManager = ChatManager;

export default ChatManager;
