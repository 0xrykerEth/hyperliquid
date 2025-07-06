require('dotenv').config();

const config = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
    BOT_OWNER_TELEGRAM_ID: process.env.BOT_OWNER_TELEGRAM_ID || null,
    
    DATABASE_PATH: process.env.DATABASE_PATH || './hyperliquid_tracker.db',
    
    HYPERLIQUID_API_URL: process.env.HYPERLIQUID_API_URL || 'https://api.hyperliquid.xyz',
    
    POLLING_INTERVAL: parseInt(process.env.POLLING_INTERVAL) || 10,
    MAX_TRACKED_WALLETS_PER_USER: parseInt(process.env.MAX_TRACKED_WALLETS_PER_USER) || 5,
    
    validate() {
        if (!this.TELEGRAM_BOT_TOKEN) {
            throw new Error('TELEGRAM_BOT_TOKEN is required. Please set it in your .env file or environment.');
        }
        return true;
    }
};

module.exports = config; 