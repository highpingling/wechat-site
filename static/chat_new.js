// chat.js
import { MemorySystem } from './memorySystem.js';

const ChatManager = {
    messages: [],
    memorySystem: null,
    recentN: 25,
    
    async init() {
        // 初始化记忆系统
        this.memorySystem = new MemorySystem();
        console.log('记忆系统初始化完成');
        
        // 恢复之前的记忆（如果有）
        const backup = await this._loadBackup();
        if (backup) {
            await this.memorySystem.importMemories(backup);
        }
    },
    
    // 添加新消息
    async addMessage(text, isUser = true) {
        const message = {
            role: isUser ? 'user' : 'assistant',
            text,
            timestamp: Date.now()
        };
        
        this.messages.push(message);
        
        // 添加到记忆系统
        await this.memorySystem.addMemory({
            type: 'message',
            content: message,
            summary: text
        });
        
        // 更新显示
        this._updateDisplay();
        return message;
    },
    
    // 获取记忆统计
    getStats() {
        if (!this.memorySystem) {
            return { error: '记忆系统未初始化' };
        }
        return this.memorySystem.getStats();
    },
    
    // 搜索相关记忆
    async searchMemories(query) {
        if (!this.memorySystem) {
            return [];
        }
        return await this.memorySystem.searchMemories(query);
    },
    
    // 私有方法：更新显示
    _updateDisplay() {
        const stats = this.getStats();
        console.log('当前状态:', stats);
    },
    
    // 私有方法：加载备份
    async _loadBackup() {
        try {
            const backup = localStorage.getItem('chatMemoryBackup');
            return backup ? JSON.parse(backup) : null;
        } catch (e) {
            console.warn('加载备份失败:', e);
            return null;
        }
    }
};

// 初始化并导出
ChatManager.init().catch(console.error);
window.ChatManager = ChatManager;

export default ChatManager;