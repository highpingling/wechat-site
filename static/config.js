// config.js
// 聊天系统配置

export const DB_CONFIG = {
    name: 'wechat_chat_db_v2',
    stores: {
        handles: 'file_handles',
        backups: 'backups',
        memories: 'memories'
    },
    version: 2
};

export const MEMORY_CONFIG = {
    layers: {
        shortTerm: {
            maxAge: 7 * 24 * 60 * 60 * 1000,  // 7天
            compressionRate: 1.0               // 不压缩
        },
        mediumTerm: {
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30天
            compressionRate: 0.5               // 压缩50%
        },
        longTerm: {
            maxAge: Infinity,                  // 永久保存
            compressionRate: 0.2               // 压缩80%
        }
    },
    compressionSchedule: {
        dailyTime: '23:50',                   // 每天压缩时间
        weeklyTime: 'Sun-23:50'               // 每周压缩时间
    },
    summarization: {
        minMessages: 30,                      // 触发总结的最小消息数
        maxTokens: 300                        // 摘要最大token数
    }
};