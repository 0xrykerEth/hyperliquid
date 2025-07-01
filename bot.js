const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const config = require('./config');
const Database = require('./database');
const HyperliquidAPI = require('./hyperliquid');

config.validate();

const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
const db = new Database();
const hlAPI = new HyperliquidAPI();

const lastCheckTimes = new Map();

const commands = [
    { command: 'start', description: 'Start the bot and see welcome message' },
    { command: 'add', description: 'Add a wallet to track (format: /add <address> [nickname])' },
    { command: 'remove', description: 'Remove a wallet from tracking (format: /remove <address>)' },
    { command: 'list', description: 'List all your tracked wallets' },
    { command: 'status', description: 'Check status of a specific wallet (format: /status <address>)' },
    { command: 'help', description: 'Show this help message' }
];

bot.setMyCommands(commands);

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;

    try {
        await db.addUser(userId, username);
        
        const welcomeMessage = `
🚀 *Welcome to Hyperliquid Order Tracker!*

This bot helps you track orders and trades for specific Hyperliquid wallet addresses.

*Available Commands:*
/add <address> [nickname] - Add a wallet to track
/remove <address> - Remove a wallet from tracking
/list - Show your tracked wallets
/status <address> - Check wallet status
/help - Show help message

*Example:*
\`/add 0x1234567890abcdef1234567890abcdef12345678 MyWallet\`

⚡ Start by adding a wallet address to track!
        `;

        await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in start command:', error);
        await bot.sendMessage(chatId, '❌ Error initializing user. Please try again.');
    }
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username;
    const input = match[1].trim().split(' ');
    const walletAddress = input[0];
    const nickname = input.slice(1).join(' ') || null;

    try {
        if (!hlAPI.isValidAddress(walletAddress)) {
            await bot.sendMessage(chatId, '❌ Invalid wallet address format. Please provide a valid Ethereum address.');
            return;
        }

        await db.addUser(userId, username);

        await db.addTrackedWallet(userId, walletAddress, nickname);

        const displayName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        await bot.sendMessage(chatId, `✅ Successfully added wallet "${displayName}" to your tracking list!`);

        lastCheckTimes.set(walletAddress, Date.now());

    } catch (error) {
        console.error('Error adding wallet:', error);
        if (error.message.includes('Maximum')) {
            await bot.sendMessage(chatId, `❌ ${error.message}`);
        } else {
            await bot.sendMessage(chatId, '❌ Error adding wallet. Please try again.');
        }
    }
});

bot.onText(/\/remove (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const walletAddress = match[1].trim();

    try {
        const removed = await db.removeTrackedWallet(userId, walletAddress);
        
        if (removed) {
            await bot.sendMessage(chatId, '✅ Wallet removed from tracking successfully!');
            lastCheckTimes.delete(walletAddress);
        } else {
            await bot.sendMessage(chatId, '❌ Wallet not found in your tracking list.');
        }
    } catch (error) {
        console.error('Error removing wallet:', error);
        await bot.sendMessage(chatId, '❌ Error removing wallet. Please try again.');
    }
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    try {
        const wallets = await db.getUserTrackedWallets(userId);
        
        if (wallets.length === 0) {
            await bot.sendMessage(chatId, '📝 You are not tracking any wallets yet.\n\nUse /add <address> to start tracking a wallet.');
            return;
        }

        let message = `📋 *Your Tracked Wallets (${wallets.length}/${config.MAX_TRACKED_WALLETS_PER_USER}):*\n\n`;
        
        wallets.forEach((wallet, index) => {
            const displayName = wallet.nickname || `${wallet.wallet_address.slice(0, 6)}...${wallet.wallet_address.slice(-4)}`;
            const addedDate = new Date(wallet.created_at).toLocaleDateString();
            message += `${index + 1}. *${displayName}*\n`;
            message += `   Address: \`${wallet.wallet_address}\`\n`;
            message += `   Added: ${addedDate}\n\n`;
        });

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error listing wallets:', error);
        await bot.sendMessage(chatId, '❌ Error retrieving wallet list. Please try again.');
    }
});

bot.onText(/\/status (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const walletAddress = match[1].trim();

    try {
        const userWallets = await db.getUserTrackedWallets(userId);
        const isTracking = userWallets.some(w => w.wallet_address.toLowerCase() === walletAddress.toLowerCase());

        if (!isTracking) {
            await bot.sendMessage(chatId, '❌ You are not tracking this wallet address.');
            return;
        }

        await bot.sendMessage(chatId, '🔍 Fetching wallet status...');

        const [recentActivity, assets] = await Promise.all([
            hlAPI.getRecentActivity(walletAddress, Date.now() - (24 * 60 * 60 * 1000)), // Last 24 hours
            hlAPI.getUserAssets(walletAddress)
        ]);

        const wallet = userWallets.find(w => w.wallet_address.toLowerCase() === walletAddress.toLowerCase());
        const displayName = wallet.nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        let statusMessage = `📊 *Status for ${displayName}*\n\n`;

        if (recentActivity.length > 0) {
            statusMessage += `📈 *Recent Activity (24h):* ${recentActivity.length} orders/fills\n`;
            statusMessage += `⏰ *Last Activity:* ${new Date(recentActivity[0].time).toLocaleString()}\n\n`;
        } else {
            statusMessage += `📈 *Recent Activity:* No activity in last 24 hours\n\n`;
        }

        if (assets && assets.assetPositions) {
            const openPositions = assets.assetPositions.filter(pos => 
                pos.position && parseFloat(pos.position.szi || 0) !== 0
            );
            
            if (openPositions.length > 0) {
                statusMessage += `💼 *Open Positions:* ${openPositions.length}\n`;
                openPositions.slice(0, 5).forEach(pos => {
                    const coin = pos.position.coin;
                    const size = pos.position.szi;
                    const pnl = pos.position.unrealizedPnl;
                    statusMessage += `   • ${coin}: ${size} (PnL: $${pnl})\n`;
                });
                if (openPositions.length > 5) {
                    statusMessage += `   ... and ${openPositions.length - 5} more\n`;
                }
            } else {
                statusMessage += `💼 *Open Positions:* None\n`;
            }
        }

        statusMessage += `\n🔗 *Address:* \`${walletAddress}\``;

        await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error fetching status:', error);
        await bot.sendMessage(chatId, '❌ Error fetching wallet status. Please try again.');
    }
});

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    let helpMessage = `🤖 *Hyperliquid Order Tracker Help*\n\n`;
    helpMessage += `*Available Commands:*\n\n`;
    
    commands.forEach(cmd => {
        helpMessage += `/${cmd.command} - ${cmd.description}\n`;
    });
    
    helpMessage += `\n*Features:*\n`;
    helpMessage += `• Real-time order notifications\n`;
    helpMessage += `• Track up to ${config.MAX_TRACKED_WALLETS_PER_USER} wallets per user\n`;
    helpMessage += `• Personalized tracking (only your wallets)\n`;
    helpMessage += `• Order history and status\n`;
    helpMessage += `• Portfolio monitoring\n\n`;
    helpMessage += `*Example Usage:*\n`;
    helpMessage += `\`/add 0x1234...5678 MyTradingWallet\`\n`;
    helpMessage += `\`/status 0x1234...5678\`\n`;
    helpMessage += `\`/remove 0x1234...5678\``;

    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

async function checkForNewOrders() {
    try {
        const trackedWallets = await db.getAllTrackedWallets();
        
        for (const walletAddress of trackedWallets) {
            try {
                const lastCheckTime = lastCheckTimes.get(walletAddress) || (Date.now() - (60 * 1000)); // Default to 1 minute ago
                const recentActivity = await hlAPI.getRecentActivity(walletAddress, lastCheckTime);
                
                if (recentActivity.length > 0) {

                    const usersTracking = await db.getUsersTrackingWallet(walletAddress);
                    
                    for (const activity of recentActivity) {

                        let activityId;
                        if (activity.type === 'twap_fill') {
                            activityId = `${activity.time}_twap_${activity.twapId}_${activity.oid || activity.tid || Math.random()}`;
                        } else {
                            activityId = `${activity.time}_${activity.oid || activity.tid || Math.random()}`;
                        }
                        
                        const alreadyProcessed = await db.isOrderProcessed(walletAddress, activityId);
                        
                        if (!alreadyProcessed) {
                            await db.markOrderProcessed(walletAddress, activityId);
                            
                            for (const user of usersTracking) {
                                try {
                                    const message = hlAPI.formatOrderMessage(activity, walletAddress, user.nickname);
                                    await bot.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
                                } catch (error) {
                                    console.error(`Error sending message to user ${user.telegram_id}:`, error);
                                }
                            }
                        }
                    }
                }
                
                lastCheckTimes.set(walletAddress, Date.now());
                
            } catch (error) {
                console.error(`Error checking wallet ${walletAddress}:`, error);
            }
        }
    } catch (error) {
        console.error('Error in order monitoring:', error);
    }
}

const monitoringInterval = `*/${config.POLLING_INTERVAL} * * * * *`;
cron.schedule(monitoringInterval, checkForNewOrders);

bot.on('error', (error) => {
    console.error('Telegram bot error:', error);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error);
});

process.on('SIGINT', () => {
    console.log('Shutting down bot...');
    bot.stopPolling();
    db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('Shutting down bot...');
    bot.stopPolling();
    db.close();
    process.exit(0);
});

console.log('🚀 Hyperliquid Telegram Bot started successfully!');
console.log(`📊 Monitoring orders every ${config.POLLING_INTERVAL} seconds`);
console.log(`👥 Max wallets per user: ${config.MAX_TRACKED_WALLETS_PER_USER}`); 