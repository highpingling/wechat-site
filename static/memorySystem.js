// memorySystem.js
// 分层记忆系统实现

export class MemoryLayer {
    constructor(name, maxAge, compressionRate) {
        this.name = name;
        this.maxAge = maxAge;
        this.compressionRate = compressionRate;
        this.memories = [];
    }
}

export class MemorySystem {
    constructor() {
        // 初始化三层记忆
        this.layers = {
            shortTerm: new MemoryLayer('short', 7 * 24 * 60 * 60 * 1000, 1.0),    // 7天，不压缩
            mediumTerm: new MemoryLayer('medium', 30 * 24 * 60 * 60 * 1000, 0.5), // 30天，压缩50%
            longTerm: new MemoryLayer('long', Infinity, 0.2)                       // 永久，压缩80%
        };
        
        // 设置自动压缩的时间间隔
        this.lastCompressionTime = Date.now();
        this.compressionInterval = 24 * 60 * 60 * 1000; // 每24小时压缩一次
    }

    // 添加新记忆
    async addMemory(memory) {
        memory.createdAt = memory.createdAt || Date.now();
        memory.lastAccessed = Date.now();
        memory.accessCount = 0;
        
        // 默认加入短期记忆
        this.layers.shortTerm.memories.push(memory);
        
        // 检查是否需要压缩
        await this.checkCompression();
        
        return memory;
    }

    // 检查并执行记忆压缩
    async checkCompression() {
        const now = Date.now();
        
        // 每24小时执行一次压缩
        if (now - this.lastCompressionTime >= this.compressionInterval) {
            console.log('执行定期记忆压缩...');
            await this.compressMemories();
            this.lastCompressionTime = now;
        }
    }

    // 压缩记忆
    async compressMemories() {
        const now = Date.now();
        
        // 处理短期到中期的转移
        const expiredShortTerm = this.layers.shortTerm.memories.filter(
            m => now - m.createdAt > this.layers.shortTerm.maxAge
        );
        
        if (expiredShortTerm.length > 0) {
            const compressed = await this._compressMemoryGroup(expiredShortTerm, this.layers.mediumTerm.compressionRate);
            this.layers.mediumTerm.memories.push(...compressed);
            
            // 移除已压缩的短期记忆
            this.layers.shortTerm.memories = this.layers.shortTerm.memories.filter(
                m => now - m.createdAt <= this.layers.shortTerm.maxAge
            );
        }
        
        // 处理中期到长期的转移
        const expiredMediumTerm = this.layers.mediumTerm.memories.filter(
            m => now - m.createdAt > this.layers.mediumTerm.maxAge
        );
        
        if (expiredMediumTerm.length > 0) {
            const compressed = await this._compressMemoryGroup(expiredMediumTerm, this.layers.longTerm.compressionRate);
            this.layers.longTerm.memories.push(...compressed);
            
            // 移除已压缩的中期记忆
            this.layers.mediumTerm.memories = this.layers.mediumTerm.memories.filter(
                m => now - m.createdAt <= this.layers.mediumTerm.maxAge
            );
        }
    }

    // 压缩记忆组
    async _compressMemoryGroup(memories, targetRatio) {
        if (memories.length === 0) return [];
        if (memories.length === 1) return memories;
        
        // 将记忆按主题分组
        const groups = this._groupByTopic(memories);
        const results = [];
        
        for (const group of Object.values(groups)) {
            if (group.length === 1) {
                results.push(group[0]);
                continue;
            }
            
            // 合并相似记忆
            try {
                const mergedSummary = await this._mergeSummaries(group);
                results.push({
                    id: `memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                    summary: mergedSummary,
                    createdAt: Math.min(...group.map(m => m.createdAt)),
                    lastAccessed: Date.now(),
                    accessCount: Math.max(...group.map(m => m.accessCount || 0)),
                    sourceCount: group.length
                });
            } catch (e) {
                console.warn('记忆压缩失败:', e);
                results.push(group[0]);
            }
        }
        
        return results;
    }

    // 按主题分组
    _groupByTopic(memories) {
        const groups = {};
        for (const memory of memories) {
            const keywords = this._extractKeywords(memory.summary);
            const topic = keywords.sort().join('_');
            if (!groups[topic]) groups[topic] = [];
            groups[topic].push(memory);
        }
        return groups;
    }

    // 提取关键词
    _extractKeywords(text) {
        // 提取中文词组和重要英文词
        const zhWords = (text.match(/[\u4e00-\u9fa5]{2,}/g) || []);
        const enWords = (text.match(/\b[A-Za-z]{4,}\b/g) || []).map(w => w.toLowerCase());
        return Array.from(new Set([...zhWords, ...enWords]));
    }

    // 合并摘要
    async _mergeSummaries(memories) {
        try {
            const combinedText = memories.map(m => m.summary).join('\n---\n');
            const resp = await fetch('/api/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'system', text: combinedText }],
                    target_token: Math.floor(300 * this.layers.longTerm.compressionRate)
                })
            });
            
            if (resp.ok) {
                const data = await resp.json();
                if (data.summary) return data.summary;
            }
        } catch (e) {
            console.warn('调用摘要API失败:', e);
        }
        
        // 失败时返回简单合并
        return memories.map(m => m.summary).join('\n---\n');
    }

    // 搜索相关记忆
    async searchMemories(query, limit = 5) {
        const now = Date.now();
        const allMemories = [
            ...this.layers.shortTerm.memories,
            ...this.layers.mediumTerm.memories,
            ...this.layers.longTerm.memories
        ];
        
        // 计算相关性分数
        const scored = allMemories.map(memory => {
            let score = 0;
            
            // 内容相关性
            const keywords = this._extractKeywords(query);
            for (const keyword of keywords) {
                if (memory.summary.includes(keyword)) {
                    score += 1;
                }
            }
            
            // 时间衰减（30天半衰期）
            const age = (now - memory.createdAt) / (24 * 60 * 60 * 1000);
            const timeScore = Math.exp(-age / 30);
            
            // 访问频率加成
            const accessScore = (memory.accessCount || 0) * 0.1;
            
            // 最终分数
            const finalScore = score * (0.7 * timeScore + 0.3) + accessScore;
            
            return { memory, score: finalScore };
        });
        
        // 排序并返回最相关的记忆
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, limit).map(item => {
            item.memory.accessCount = (item.memory.accessCount || 0) + 1;
            item.memory.lastAccessed = now;
            return item.memory;
        });
        
        return results;
    }

    // 获取记忆统计信息
    getStats() {
        return {
            shortTerm: this.layers.shortTerm.memories.length,
            mediumTerm: this.layers.mediumTerm.memories.length,
            longTerm: this.layers.longTerm.memories.length,
            totalMemories: this.layers.shortTerm.memories.length + 
                          this.layers.mediumTerm.memories.length + 
                          this.layers.longTerm.memories.length
        };
    }

    // 导出所有记忆
    exportMemories() {
        return {
            version: '1.0',
            exportedAt: new Date().toISOString(),
            layers: {
                shortTerm: this.layers.shortTerm.memories,
                mediumTerm: this.layers.mediumTerm.memories,
                longTerm: this.layers.longTerm.memories
            }
        };
    }

    // 导入记忆
    async importMemories(data) {
        if (!data.layers) return false;
        
        try {
            // 清空现有记忆
            this.layers.shortTerm.memories = [];
            this.layers.mediumTerm.memories = [];
            this.layers.longTerm.memories = [];
            
            // 导入各层记忆
            this.layers.shortTerm.memories = data.layers.shortTerm || [];
            this.layers.mediumTerm.memories = data.layers.mediumTerm || [];
            this.layers.longTerm.memories = data.layers.longTerm || [];
            
            // 立即执行一次压缩以整理记忆
            await this.compressMemories();
            
            return true;
        } catch (e) {
            console.error('导入记忆失败:', e);
            return false;
        }
    }
}