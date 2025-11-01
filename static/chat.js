// chat.js
// 前端聊天管理：支持长期记忆系统、多层记忆存储、自动压缩与智能检索
// 设计目标：稳定可靠的长期对话记忆系统

import { MemorySystem } from './memorySystem.js';

const DB_NAME = 'wechat_chat_db_v2'; // 升级数据库版本以支持新的记忆系统
const HANDLE_STORE = 'file_handles';
const BACKUP_STORE = 'backups';
const MEMORY_STORE = 'memories'; // 新增记忆存储

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
import MemorySystem from './memory_system.js';

const ChatManager = {
  messages: [], // {role:'me'|'assistant', text, ts}
  memorySystem: null, // 分层记忆系统实例
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
    // 初始化记忆系统
    this.memorySystem = new MemorySystem();
    // bind UI
    this.chatMessagesEl = opts.chatMessagesEl;
    this.addMessageFn = opts.addMessageFn; // function to render message to UI
    // 初始化调试面板更新
    this._initDebugPanel();
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

      // 如果导入的消息超过 recentN，使用本地压缩（不调用API，节省token）
      if (chats.length > this.recentN) {
        const progress = document.createElement('div');
        progress.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:10000;';
        progress.innerHTML = '<div>正在处理历史消息（本地压缩，不消耗token）...</div><div id="import-progress" style="margin-top:10px;color:#666;"></div>';
        document.body.appendChild(progress);
        
        const updateProgress = (text) => {
          const el = document.getElementById('import-progress');
          if (el) el.textContent = text;
        };

        try {
          // 保留最近的消息
          const recentMessages = chats.slice(-this.recentN);
          // 对早期消息分批压缩（每30条一组）- 使用本地方法
          const olderMessages = chats.slice(0, -this.recentN);
          const batchSize = 30;
          const batches = [];
          
          for (let i = 0; i < olderMessages.length; i += batchSize) {
            const batch = olderMessages.slice(i, i + batchSize);
            updateProgress(`正在本地压缩第 ${i+1}-${Math.min(i+batchSize, olderMessages.length)} 条消息，共 ${olderMessages.length} 条`);
            
            // 本地压缩逻辑：提取关键信息，不调用API
            const summary = this._createLocalSummary(batch, i);
            batches.push({ 
              id: 'mc_local_' + Date.now() + '_' + i, 
              summary, 
              createdAt: Date.now(),
              isLocalCompressed: true // 标记为本地压缩
            });
            
            await new Promise(r => setTimeout(r, 50)); // 短暂延迟，避免阻塞UI
          }

          // 更新状态
          this.memoryChunks.push(...batches);
          chats = recentMessages; // 只保留最近的消息
          updateProgress(`完成！已保留最近 ${this.recentN} 条消息，${batches.length} 个历史摘要（本地压缩）。`);
          
          // 清理进度条
          setTimeout(() => {
            if (progress.parentNode) {
              progress.parentNode.removeChild(progress);
            }
          }, 3000);
          
        } catch (e) {
          console.error('batch compress failed:', e);
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

  // 本地压缩方法：提取关键信息，不调用API
  _createLocalSummary(messages, batchIndex) {
    const startIdx = batchIndex + 1;
    const endIdx = batchIndex + messages.length;
    
    // 提取关键信息
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.text);
    const assistantMessages = messages.filter(m => (m.role === 'assistant' || m.role === 'boyfriend')).map(m => m.text);
    
    // 提取关键词（去重）
    const extractKeywords = (texts) => {
      const allText = texts.join(' ');
      const zhWords = (allText.match(/[\u4e00-\u9fa5]{2,}/g) || []);
      const enWords = (allText.match(/\b[A-Za-z]{3,}\b/g) || []);
      return [...new Set([...zhWords, ...enWords])].slice(0, 20); // 最多20个关键词
    };
    
    const keywords = extractKeywords([...userMessages, ...assistantMessages]);
    
    // 构建摘要
    let summary = `[历史对话 ${startIdx}-${endIdx}]\n`;
    summary += `消息数：${messages.length}条\n`;
    summary += `关键词：${keywords.join('、')}\n`;
    summary += `\n对话片段：\n`;
    
    // 保留前3条和后3条消息作为上下文
    const sampleMessages = [
      ...messages.slice(0, 3),
      ...messages.slice(-3)
    ];
    
    summary += sampleMessages.map(m => {
      const role = m.role === 'user' ? '我' : '男友';
      const text = m.text.length > 50 ? m.text.slice(0, 50) + '...' : m.text;
      return `${role}: ${text}`;
    }).join('\n');
    
    return summary;
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

  // 初始化调试面板
  _initDebugPanel() {
    // 确保调试面板元素存在
    const panel = document.getElementById('debug-panel');
    const toggle = document.getElementById('debug-toggle');
    if (!panel || !toggle) {
      console.warn('调试面板元素未找到');
      return;
    }

    // 设置自动更新（每秒）
    setInterval(() => this._updateDebugPanel(), 1000);
    
    // 初次更新
    this._updateDebugPanel();
  },

  // 更新调试面板信息
  _updateDebugPanel() {
    // 更新消息统计
    try {
      const activeMessages = document.getElementById('debug-active-messages');
      const memoryChunks = document.getElementById('debug-memory-chunks');
      const tokens = document.getElementById('debug-tokens');
      const usedChunks = document.getElementById('debug-used-chunks');
      
      if (activeMessages) activeMessages.textContent = this.messages?.length || 0;
      if (memoryChunks) memoryChunks.textContent = this.memoryChunks?.length || 0;
      
      // 更新最近一次API调用信息
      if (this._lastPayload) {
        const tokenEstimate = Math.ceil(JSON.stringify(this._lastPayload).length / 4);
        if (tokens) tokens.textContent = tokenEstimate;
        if (usedChunks) usedChunks.textContent = this._lastPayload.memory_chunks?.length || 0;
      }
      
      // 在Console中也输出当前状态
      console.log(`调试面板更新 - 活跃消息: ${this.messages?.length || 0}, 记忆块: ${this.memoryChunks?.length || 0}`);

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
    console.log('开始检查是否需要生成记忆块...');
    console.log(`当前消息数: ${this.messages.length}`);
    console.log(`保留最新消息数: ${this.recentN}`);
    
    // 检查是否有需要总结的旧消息
    if (this.messages.length <= this.recentN) {
      console.log(`消息数(${this.messages.length})未超过${this.recentN}条，无需生成记忆块`);
      return;
    }
    const older = this.messages.slice(0, this.messages.length - this.recentN);
    if (!older.length) return;

    console.log(`将处理${older.length}条旧消息，生成记忆块`);

    // 每30条消息生成一个记忆块
    const batchSize = 30;
    for (let i = 0; i < older.length; i += batchSize) {
      const batch = older.slice(i, Math.min(i + batchSize, older.length));
      const summaryText = `历史对话 ${i + 1}-${i + batch.length}:\n` +
        batch.map(m => `${m.role === 'user' ? '我' : '男友'}: ${m.text}`).join('\n');
      
      this.memoryChunks.push({
        id: 'mc_' + Date.now() + '_' + i,
        summary: summaryText,
        createdAt: Date.now()
      });
      
      console.log(`已生成第 ${Math.floor(i/batchSize) + 1} 个记忆块，包含消息 ${i + 1} 至 ${i + batch.length}`);
    }
    
    // 只保留最近的消息
    this.messages = this.messages.slice(this.messages.length - this.recentN);
    
    // 保存到 IndexedDB
    await this.backupToIndexedDB();
    
    if (typeof this._updateDebugPanel === 'function') {
      this._updateDebugPanel();
    }

    console.log('完成！');
    console.log(`现在有 ${this.messages.length} 条活跃消息`);
    console.log(`生成了 ${this.memoryChunks.length} 个记忆块`);
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

    // 如果记忆系统存在，添加到记忆
    if (this.memorySystem) {
      this.memorySystem.addMemory({
        type: 'message',
        content: m,
        summary: text,
        ts: Date.now()
      });
    }

    // backup
    this.backupToIndexedDB();
    // 更新调试面板
    this._updateDebugPanel();
  },

  // 查看记忆状态
  getMemoryStats() {
    if (!this.memorySystem) {
      return { 
        shortTerm: 0,
        mediumTerm: 0,
        longTerm: 0,
        error: '记忆系统未初始化'
      };
    }
    return this.memorySystem.getStats();
  },

  // 搜索相关记忆
  async searchMemories(query) {
    if (!this.memorySystem) {
      console.warn('记忆系统未初始化');
      return [];
    }
    return await this.memorySystem.searchMemories(query);
  }
};

// export to window
window.ChatManager = ChatManager;

export default ChatManager;
