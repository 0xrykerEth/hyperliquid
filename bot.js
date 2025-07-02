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
const activeTwapOrders = new Map();
const POSITIONS_PER_PAGE = 10;

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

🔗 *Join Hyperliquid:* [Click here to start trading](https://app.hyperliquid.xyz/join/0XRYKER)
        `;

        await bot.sendMessage(chatId, welcomeMessage, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
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
    const input = match[1].trim();

    try {
        // First try to find wallet by nickname
        const userWallets = await db.getUserTrackedWallets(userId);
        let walletAddress = input;
        
        // If input is not a valid address, try to find by nickname
        if (!hlAPI.isValidAddress(input)) {
            const walletByNickname = userWallets.find(w => 
                w.nickname && w.nickname.toLowerCase() === input.toLowerCase()
            );
            
            if (!walletByNickname) {
                await bot.sendMessage(chatId, '❌ Invalid input. Please provide a valid wallet address or a saved wallet nickname.');
                return;
            }
            
            walletAddress = walletByNickname.wallet_address;
        }

        const loadingMessage = await bot.sendMessage(chatId, '🔄 Loading positions...');

        // Fetch assets with timeout and retry
        const fetchAssetsWithTimeout = async () => {
            const timeout = 15000; // 15 second timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                const assets = await Promise.race([
                    hlAPI.getUserAssets(walletAddress),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Timeout')), timeout)
                    )
                ]);

                clearTimeout(timeoutId);
                return assets;
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        };

        // Try up to 2 times with different timeouts
        let assets;
        let attempt = 0;
        let success = false;

        while (attempt < 2 && !success) {
            try {
                attempt++;
                await bot.editMessageText(`🔄 Loading positions${'.'.repeat(attempt)}`, {
                    chat_id: chatId,
                    message_id: loadingMessage.message_id
                });

                assets = await fetchAssetsWithTimeout();
                success = true;
            } catch (error) {
                console.error(`Attempt ${attempt} failed:`, error);
                if (attempt >= 2) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between attempts
            }
        }

        if (!assets || !assets.assetPositions) {
            throw new Error('Failed to fetch wallet data');
        }

        // Filter only currently open positions with non-zero size
        const openPositions = assets.assetPositions.filter(pos => {
            if (!pos.position) return false;
            
            const size = parseFloat(pos.position.szi || 0);
            
            // Only include positions with non-zero size
            return size !== 0;
        });

        const trackedWallet = userWallets.find(w => w.wallet_address.toLowerCase() === walletAddress.toLowerCase());
        const displayName = trackedWallet?.nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        if (openPositions.length > 0) {
            // Sort positions by absolute PnL value
            const sortedPositions = openPositions.sort((a, b) => {
                const aPnl = Math.abs(parseFloat(a.position.unrealizedPnl || 0));
                const bPnl = Math.abs(parseFloat(b.position.unrealizedPnl || 0));
                return bPnl - aPnl;
            });

            let statusMessage = `📊 *${displayName}'s Positions*\n\n`;
            statusMessage += `💼 *Total Positions:* ${openPositions.length}\n\n`;

            // Add all positions to the message
            for (const pos of sortedPositions) {
                const coin = pos.position.coin;
                const size = pos.position.szi;
                const pnl = parseFloat(pos.position.unrealizedPnl);
                const entryPrice = pos.position.entryPx || '0';
                const direction = parseFloat(size) > 0 ? '📈 Long' : '📉 Short';
                const pnlEmoji = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';

                statusMessage += `━━━━━━━━━━━━━━━━\n`;
                statusMessage += `*${direction} ${coin}*\n`;
                statusMessage += `📊 Size: ${Math.abs(size)} contracts\n`;
                statusMessage += `💵 Entry: $${Number(entryPrice).toLocaleString()}\n`;
                statusMessage += `${pnlEmoji} PnL: $${Number(pnl).toLocaleString()}\n\n`;
            }

            // Add wallet address at the bottom
            statusMessage += `🔗 \`${walletAddress}\``;

            // Delete loading message and send the combined status
            await bot.deleteMessage(chatId, loadingMessage.message_id);
            await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } else {
            const statusMessage = `📊 *${displayName}'s Positions*\n\n` +
                `💼 No open positions\n\n` +
                `🔗 \`${walletAddress}\``;
            
            await bot.deleteMessage(chatId, loadingMessage.message_id);
            await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Error in status command:', error);
        await bot.sendMessage(chatId, '❌ Error fetching positions. Please try again.');
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
    helpMessage += `\`/status 0x1234...5678\`  or  \`/status MyTradingWallet\`\n`;
    helpMessage += `\`/remove 0x1234...5678\`\n\n`;
    helpMessage += `🔗 *Join Hyperliquid:* [Click here to start trading](https://app.hyperliquid.xyz/join/0XRYKER)`;

    await bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true 
    });
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
                    
                    // Group TWAP fills by TWAP ID
                    const twapFills = new Map();
                    const nonTwapActivities = [];

                    for (const activity of recentActivity) {
                        if (activity.type === 'twap_fill') {
                            if (!twapFills.has(activity.twapId)) {
                                twapFills.set(activity.twapId, []);
                            }
                            twapFills.get(activity.twapId).push(activity);
                        } else {
                            nonTwapActivities.push(activity);
                        }
                    }

                    // Process non-TWAP activities normally
                    for (const activity of nonTwapActivities) {
                        const activityId = `${activity.time}_${activity.oid || activity.tid || Math.random()}`;
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

                    // Process TWAP fills
                    for (const [twapId, fills] of twapFills) {
                        // Sort fills by time to process them in order
                        fills.sort((a, b) => a.time - b.time);
                        
                        const firstFill = fills[0];
                        const walletTwapKey = `${walletAddress}_${twapId}`;
                        
                        // Check if this is a new TWAP order
                        if (!activeTwapOrders.has(walletTwapKey)) {
                            activeTwapOrders.set(walletTwapKey, {
                                startTime: firstFill.time,
                                totalFills: 0,
                                coin: firstFill.coin,
                                side: firstFill.side,
                                initialSize: firstFill.sz
                            });

                            // Send TWAP start notification
                            for (const user of usersTracking) {
                                try {
                                    const message = formatTwapStartMessage(firstFill, walletAddress, user.nickname, twapId);
                                    await bot.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
                                } catch (error) {
                                    console.error(`Error sending TWAP start message to user ${user.telegram_id}:`, error);
                                }
                            }
                        }

                        // Update TWAP order status
                        const twapStatus = activeTwapOrders.get(walletTwapKey);
                        twapStatus.totalFills += fills.length;

                        // Check if TWAP order is complete or cancelled
                        const lastFill = fills[fills.length - 1];
                        if (lastFill.isTwapDone || lastFill.isTwapCancelled) {
                            // Send TWAP completion/cancellation notification
                            for (const user of usersTracking) {
                                try {
                                    const message = lastFill.isTwapCancelled 
                                        ? formatTwapCancelMessage(lastFill, walletAddress, user.nickname, twapId, twapStatus)
                                        : formatTwapCompleteMessage(lastFill, walletAddress, user.nickname, twapId, twapStatus);
                                    await bot.sendMessage(user.telegram_id, message, { parse_mode: 'Markdown' });
                                } catch (error) {
                                    console.error(`Error sending TWAP ${lastFill.isTwapCancelled ? 'cancel' : 'complete'} message to user ${user.telegram_id}:`, error);
                                }
                            }
                            
                            // Remove from active TWAP orders
                            activeTwapOrders.delete(walletTwapKey);
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

function formatTwapStartMessage(firstFill, walletAddress, nickname, twapId) {
    const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const timestamp = new Date(firstFill.time).toLocaleString();
    
    // Determine if it's spot or perp and long/short
    const isSpot = firstFill.coin.includes('/') || firstFill.coin.startsWith('@');
    const isBuy = firstFill.side.toLowerCase() === 'buy';
    const orderType = isSpot 
        ? `Spot ${isBuy ? 'Buy' : 'Sell'}` 
        : (isBuy ? 'Long' : 'Short');
    const orderEmoji = isSpot 
        ? (isBuy ? '💵' : '💸')  // 💵 for buy, 💸 for sell in spot
        : (isBuy ? '📈' : '📉'); // 📈 for long, 📉 for short in perp
    
    let message = `🔄 *${orderType} TWAP Order Started*\n\n`;
    message += `${orderEmoji} *Type:* ${orderType} ${isSpot ? 'Market' : 'Perpetual'}\n`;
    message += `👤 *Wallet:* ${walletName}\n`;
    message += `📈 *Pair:* ${firstFill.coin}\n`;
    message += `📊 *Side:* ${firstFill.side.toUpperCase()}\n`;
    message += `💰 *Total Size:* ${firstFill.sz}\n`;
    message += `⏰ *Start Time:* ${timestamp}\n`;
    message += `🆔 *TWAP ID:* ${twapId}\n\n`;
    message += `🔗 *Address:* \`${walletAddress}\``;
    
    return message;
}

function formatTwapCompleteMessage(lastFill, walletAddress, nickname, twapId, twapStatus) {
    const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const startTime = new Date(twapStatus.startTime).toLocaleString();
    const endTime = new Date(lastFill.time).toLocaleString();
    const duration = Math.round((lastFill.time - twapStatus.startTime) / 1000); // in seconds
    
    // Determine if it's spot or perp and long/short
    const isSpot = lastFill.coin.includes('/') || lastFill.coin.startsWith('@');
    const isBuy = lastFill.side.toLowerCase() === 'buy';
    const orderType = isSpot 
        ? `Spot ${isBuy ? 'Buy' : 'Sell'}` 
        : (isBuy ? 'Long' : 'Short');
    const orderEmoji = isSpot 
        ? (isBuy ? '💵' : '💸')  // 💵 for buy, 💸 for sell in spot
        : (isBuy ? '📈' : '📉'); // 📈 for long, 📉 for short in perp
    
    let message = `✅ *${orderType} TWAP Order Completed*\n\n`;
    message += `${orderEmoji} *Type:* ${orderType} ${isSpot ? 'Market' : 'Perpetual'}\n`;
    message += `👤 *Wallet:* ${walletName}\n`;
    message += `📈 *Pair:* ${lastFill.coin}\n`;
    message += `📊 *Side:* ${lastFill.side.toUpperCase()}\n`;
    message += `💰 *Total Size:* ${twapStatus.initialSize}\n`;
    message += `🔢 *Total Fills:* ${twapStatus.totalFills}\n`;
    message += `⏰ *Start Time:* ${startTime}\n`;
    message += `⌛ *End Time:* ${endTime}\n`;
    message += `⏱️ *Duration:* ${formatDuration(duration)}\n`;
    if (lastFill.closedPnl) {
        const pnlValue = parseFloat(lastFill.closedPnl);
        const pnlEmoji = pnlValue > 0 ? '📈' : '📉';
        message += `${pnlEmoji} *Final PnL:* $${lastFill.closedPnl}\n`;
    }
    message += `🆔 *TWAP ID:* ${twapId}\n\n`;
    message += `🔗 *Address:* \`${walletAddress}\``;
    
    return message;
}

function formatTwapCancelMessage(lastFill, walletAddress, nickname, twapId, twapStatus) {
    const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    const startTime = new Date(twapStatus.startTime).toLocaleString();
    const cancelTime = new Date(lastFill.time).toLocaleString();
    const duration = Math.round((lastFill.time - twapStatus.startTime) / 1000); // in seconds
    
    // Determine if it's spot or perp and long/short
    const isSpot = lastFill.coin.includes('/') || lastFill.coin.startsWith('@');
    const isBuy = lastFill.side.toLowerCase() === 'buy';
    const orderType = isSpot 
        ? `Spot ${isBuy ? 'Buy' : 'Sell'}` 
        : (isBuy ? 'Long' : 'Short');
    const orderEmoji = isSpot 
        ? (isBuy ? '💵' : '💸')  // 💵 for buy, 💸 for sell in spot
        : (isBuy ? '📈' : '📉'); // 📈 for long, 📉 for short in perp
    
    let message = `❌ *${orderType} TWAP Order Cancelled*\n\n`;
    message += `${orderEmoji} *Type:* ${orderType} ${isSpot ? 'Market' : 'Perpetual'}\n`;
    message += `👤 *Wallet:* ${walletName}\n`;
    message += `📈 *Pair:* ${lastFill.coin}\n`;
    message += `📊 *Side:* ${lastFill.side.toUpperCase()}\n`;
    message += `💰 *Initial Size:* ${twapStatus.initialSize}\n`;
    message += `📊 *Filled Amount:* ${lastFill.filledSz || '0'}\n`;
    message += `🔢 *Fills Before Cancel:* ${twapStatus.totalFills}\n`;
    message += `⏰ *Start Time:* ${startTime}\n`;
    message += `⌛ *Cancel Time:* ${cancelTime}\n`;
    message += `⏱️ *Duration:* ${formatDuration(duration)}\n`;
    if (lastFill.closedPnl) {
        const pnlValue = parseFloat(lastFill.closedPnl);
        const pnlEmoji = pnlValue > 0 ? '📈' : '📉';
        message += `${pnlEmoji} *PnL:* $${lastFill.closedPnl}\n`;
    }
    message += `🆔 *TWAP ID:* ${twapId}\n\n`;
    message += `🔗 *Address:* \`${walletAddress}\``;
    
    return message;
}

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes > 1 ? 's' : ''}`;
}

const monitoringInterval = `*/${config.POLLING_INTERVAL} * * * * *`;
cron.schedule(monitoringInterval, checkForNewOrders);

async function checkForNewMarkets() {
    try {
        const { newPerps, newSpots } = await hlAPI.getNewMarkets();
        
        if (newPerps.length > 0 || newSpots.length > 0) {
            // Get all users to notify
            const allUsers = await db.getAllUsers();
            
            // Prepare messages
            const perpMessage = hlAPI.formatNewMarketMessage(newPerps, 'perp');
            const spotMessage = hlAPI.formatNewMarketMessage(newSpots, 'spot');
            
            // Send notifications to all users
            for (const user of allUsers) {
                try {
                    if (perpMessage) {
                        await bot.sendMessage(user.telegram_id, perpMessage, { 
                            parse_mode: 'Markdown',
                            disable_web_page_preview: true 
                        });
                    }
                    if (spotMessage) {
                        await bot.sendMessage(user.telegram_id, spotMessage, { 
                            parse_mode: 'Markdown',
                            disable_web_page_preview: true 
                        });
                    }
                } catch (error) {
                    console.error(`Error sending new market notification to user ${user.telegram_id}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error checking for new markets:', error);
    }
}

// Add market monitoring cron job (check every 5 minutes)
cron.schedule('*/5 * * * *', checkForNewMarkets);

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
