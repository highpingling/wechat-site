// memory_system.js
// 分层记忆系统：短期、中期、长期记忆管理

class MemorySystem {
  constructor() {
    this.layers = {
      shortTerm: [],  // 最近7天
      mediumTerm: [], // 7-30天
      longTerm: []    // 30天以上
    };
    
    this.compressionRates = {
      shortTerm: 1.0,    // 不压缩
      mediumTerm: 0.5,   // 压缩50%
      longTerm: 0.2      // 压缩80%
    };
    
    // 各层记忆的时间阈值（毫秒）
    this.timeThresholds = {
      shortTerm: 7 * 24 * 60 * 60 * 1000,    // 7天
      mediumTerm: 30 * 24 * 60 * 60 * 1000,  // 30天
    };
  }

  // 添加新记忆
  async addMemory(memory) {
    const now = Date.now();
    memory.createdAt = memory.createdAt || now;
    memory.lastAccessed = now;
    memory.accessCount = 0;
    
    // 默认放入短期记忆
    this.layers.shortTerm.push(memory);
    
    // 如果短期记忆过多，触发压缩
    if (this.layers.shortTerm.length > 50) {
      await this.compress();
    }
  }

  // 压缩较老的记忆
  async compress() {
    const now = Date.now();
    
    // 处理短期到中期的转换
    const shortTermOld = this.layers.shortTerm.filter(
      m => (now - m.createdAt) > this.timeThresholds.shortTerm
    );
    
    if (shortTermOld.length > 0) {
      const compressed = await this._compressMemories(shortTermOld, this.compressionRates.mediumTerm);
      this.layers.mediumTerm.push(...compressed);
      this.layers.shortTerm = this.layers.shortTerm.filter(
        m => (now - m.createdAt) <= this.timeThresholds.shortTerm
      );
    }
    
    // 处理中期到长期的转换
    const mediumTermOld = this.layers.mediumTerm.filter(
      m => (now - m.createdAt) > this.timeThresholds.mediumTerm
    );
    
    if (mediumTermOld.length > 0) {
      const compressed = await this._compressMemories(mediumTermOld, this.compressionRates.longTerm);
      this.layers.longTerm.push(...compressed);
      this.layers.mediumTerm = this.layers.mediumTerm.filter(
        m => (now - m.createdAt) <= this.timeThresholds.mediumTerm
      );
    }
  }

  // 智能压缩记忆
  async _compressMemories(memories, targetRatio) {
    // 按相似度分组
    const groups = this._groupSimilarMemories(memories);
    
    const compressed = [];
    for (const group of groups) {
      if (group.length === 1) {
        compressed.push(group[0]);
        continue;
      }
      
      // 合并相似记忆
      try {
        const mergedSummary = await this._mergeSummaries(group);
        compressed.push({
          id: 'mc_' + Date.now(),
          summary: mergedSummary,
          createdAt: Math.min(...group.map(m => m.createdAt)),
          lastAccessed: Math.max(...group.map(m => m.lastAccessed)),
          accessCount: Math.max(...group.map(m => m.accessCount || 0)),
          sourceCount: group.length
        });
      } catch (e) {
        console.warn('合并记忆失败:', e);
        compressed.push(group[0]); // 保留第一条记忆
      }
    }
    
    return compressed;
  }

  // 根据相似度分组
  _groupSimilarMemories(memories) {
    // 简单实现：按主题关键词分组
    const groups = {};
    for (const memory of memories) {
      const keywords = this._extractKeywords(memory.summary);
      const key = keywords.sort().join('_');
      if (!groups[key]) groups[key] = [];
      groups[key].push(memory);
    }
    return Object.values(groups);
  }

  // 提取关键词
  _extractKeywords(text) {
    // 简单实现：提取重要名词
    const keywords = text.match(/[一-龥]{2,}/g) || [];
    return [...new Set(keywords)];
  }

  // 合并摘要
  async _mergeSummaries(memories) {
    try {
      const combinedText = memories.map(m => m.summary).join('\n');
      const resp = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'system', text: combinedText }],
          target_token: 300
        })
      });
      
      if (resp.ok) {
        const data = await resp.json();
        return data.summary || combinedText;
      }
    } catch (e) {
      console.warn('调用摘要API失败:', e);
    }
    
    // 失败时返回简单合并
    return memories.map(m => m.summary).join('\n');
  }

  // 搜索相关记忆
  async searchMemories(query, limit = 5) {
    const now = Date.now();
    const allMemories = [
      ...this.layers.shortTerm,
      ...this.layers.mediumTerm,
      ...this.layers.longTerm
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
      
      // 时间衰减
      const age = (now - memory.createdAt) / (24 * 60 * 60 * 1000); // 天数
      const timeScore = Math.exp(-age / 30); // 30天半衰期
      
      // 访问频率提升
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
}

export default MemorySystem;