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
    { command: 'perpstatus', description: 'Check perpetual positions (format: /perpStatus <address>)' },
    { command: 'spotstatus', description: 'Check spot balances & HYPE staking (format: /spotStatus <address>)' },
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

This bot helps you track orders, trades, and HYPE staking activities for specific Hyperliquid wallet addresses.

*Available Commands:*
/add <address> [nickname] - Add a wallet to track
/remove <address> - Remove a wallet from tracking
/list - Show your tracked wallets
/perpStatus <address> - Check perpetual positions
/spotStatus <address> - Check spot balances & HYPE staking
/help - Show help message

*What You'll Get Notified About:*
• 📈 Trading orders (perp & spot)
• 💰 HYPE staking & unstaking
• 🔄 TWAP order activities
• 🚨 Global alerts for large HYPE staking (>10,000 HYPE)

*Example:*
\`/add 0x1234567890abcdef1234567890abcdef12345678 MyWallet\`
\`/perpStatus MyWallet\` (perpetual positions)
\`/spotStatus MyWallet\` (spot balances & staking)

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
        await bot.sendMessage(chatId, `✅ Successfully added wallet "${displayName}" to your tracking list!\n\n🔔 You'll now receive notifications for:\n• Trading orders & fills\n• HYPE staking/unstaking\n• TWAP activities`);

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

bot.onText(/\/perpStatus (.+)/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const input = match[1].trim();
    
    // Parse input for optional parameters (e.g., "wallet top10" or "wallet summary")
    const inputParts = input.split(' ');
    const walletInput = inputParts[0];
    const mode = inputParts[1]?.toLowerCase() || 'full';
    const limitMatch = mode.match(/top(\d+)/);
    const topLimit = limitMatch ? parseInt(limitMatch[1]) : null;
    


    try {
        // First try to find wallet by nickname
        const userWallets = await db.getUserTrackedWallets(userId);
        let walletAddress = walletInput;
        
        // If input is not a valid address, try to find by nickname
        if (!hlAPI.isValidAddress(walletInput)) {
            const walletByNickname = userWallets.find(w => 
                w.nickname && w.nickname.toLowerCase() === walletInput.toLowerCase()
            );
            
            if (!walletByNickname) {
                await bot.sendMessage(chatId, '❌ Invalid input. Please provide a valid wallet address or a saved wallet nickname.\n\n💡 Usage examples:\n`/perpStatus wallet`\n`/perpStatus wallet top10`\n`/perpStatus wallet summary`');
                return;
            }
            
            walletAddress = walletByNickname.wallet_address;
        }

        const loadingMessage = await bot.sendMessage(chatId, '🔄 Loading positions...');

        // Fetch trading assets only
        const fetchAssetsWithTimeout = async () => {
            const timeout = 30000; // 30 second timeout
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

        // Try up to 3 times with different timeouts
        let assets;
        let attempt = 0;
        let success = false;

        while (attempt < 3 && !success) {
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
                if (attempt >= 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between attempts
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

        // Get current prices for all assets
        let allMids = {};
        try {
            allMids = await hlAPI.getAllMids();
        } catch (error) {
            console.log('Could not fetch current prices:', error.message);
        }

        const trackedWallet = userWallets.find(w => w.wallet_address.toLowerCase() === walletAddress.toLowerCase());
        const displayName = trackedWallet?.nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        // Delete loading message first
        await bot.deleteMessage(chatId, loadingMessage.message_id);

        if (openPositions.length === 0) {
            await bot.sendMessage(chatId, `🔍 *Perpetual Positions for:* \`${walletAddress}\`\n\n📊 No open perpetual positions found.`);
            return;
        }

        // Sort positions by absolute PnL value
        const sortedPositions = openPositions.sort((a, b) => {
            const aPnl = Math.abs(parseFloat(a.position.unrealizedPnl || 0));
            const bPnl = Math.abs(parseFloat(b.position.unrealizedPnl || 0));
            return bPnl - aPnl;
        });

        // Calculate total PnL for header
        const totalPnl = sortedPositions.reduce((sum, pos) => sum + parseFloat(pos.position.unrealizedPnl || 0), 0);
        const totalPnlEmoji = totalPnl > 0 ? '🟢' : totalPnl < 0 ? '🔴' : '⚪';

        // Determine what to show based on mode
        let positionsToShow = sortedPositions;
        
        if (mode === 'summary') {
            positionsToShow = sortedPositions.slice(0, 5);
        } else if (topLimit) {
            positionsToShow = sortedPositions.slice(0, topLimit);
        }

        // Calculate how many positions we can fit in one message
        const maxMessageLength = 4090; // Use almost all of Telegram's 4096 character limit
        let baseMessage = `📊 *${displayName}'s Perpetual Positions*\n\n`;
        baseMessage += `💼 *Total Positions:* ${openPositions.length}\n`;
        baseMessage += `${totalPnlEmoji} *Total PnL:* $${totalPnl.toLocaleString()}\n\n`;
        
        // Add mode-specific text that will be in final message
        if (mode === 'summary') {
            baseMessage += `📋 *Summary View* (Top 5 by PnL)\n\n`;
        } else if (topLimit) {
            baseMessage += `📋 *Top ${topLimit} Positions* (by PnL)\n\n`;
        }
        
        // Test how many positions we can fit
        let positionsPerPage = 1;
        for (let i = 1; i <= positionsToShow.length; i++) {
            const testPositions = positionsToShow.slice(0, i);
            const testPositionContent = createPositionMessage(testPositions, allMids);
            
            // Build complete test message including potential "Showing X of Y" text
            let fullTestMessage = baseMessage + testPositionContent;
            if (i < positionsToShow.length) {
                fullTestMessage += `\n📝 *Showing ${i} of ${positionsToShow.length} positions*`;
            }
            fullTestMessage += `\n🔗 \`${walletAddress}\``;
            
            if (fullTestMessage.length <= maxMessageLength) {
                positionsPerPage = i;
            } else {
                break;
            }
        }

        // Send single message with as many positions as possible
        let message = `📊 *${displayName}'s Perpetual Positions*\n\n`;
        message += `💼 *Total Positions:* ${openPositions.length}\n`;
        message += `${totalPnlEmoji} *Total PnL:* $${totalPnl.toLocaleString()}\n\n`;
        
        if (mode === 'summary') {
            message += `📋 *Summary View* (Top 5 by PnL)\n\n`;
        } else if (topLimit) {
            message += `📋 *Top ${topLimit} Positions* (by PnL)\n\n`;
        }
        
        // Add as many positions as can fit in message limit
        const finalPositions = positionsToShow.slice(0, positionsPerPage);
        message += createPositionMessage(finalPositions, allMids);
        
        if (positionsPerPage < positionsToShow.length) {
            message += `\n📝 *Showing ${positionsPerPage} of ${positionsToShow.length} positions*`;
        }
        
        message += `\n🔗 \`${walletAddress}\``;
        
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in status command:', error);
        await bot.sendMessage(chatId, '❌ Error fetching positions. Please try again.');
    }
});

bot.onText(/\/spotStatus (.+)/i, async (msg, match) => {
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

        const loadingMessage = await bot.sendMessage(chatId, '🔄 Loading spot balances & staking...');

        // Fetch spot balances and staking data with fallbacks
        const fetchSpotDataWithTimeout = async () => {
            const timeout = 30000; // 30 second timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try {
                // First get spot balances, then try staking data with fallbacks
                const spotBalances = await Promise.race([
                    hlAPI.getUserSpotBalances(walletAddress),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Spot balances timeout')), timeout)
                    )
                ]);

                let stakingSummary = null;
                let stakingDelegations = null;

                // Try to get staking data, but don't fail if it doesn't work
                try {
                    stakingSummary = await Promise.race([
                        hlAPI.getUserStakingSummary(walletAddress),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Staking timeout')), 15000)
                        )
                    ]);
                } catch (error) {
                    console.log('Staking summary not available:', error.message);
                }

                try {
                    stakingDelegations = await Promise.race([
                        hlAPI.getUserStakingDelegations(walletAddress),
                        new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Delegations timeout')), 15000)
                        )
                    ]);
                } catch (error) {
                    console.log('Staking delegations not available:', error.message);
                }

                clearTimeout(timeoutId);
                return { spotBalances, stakingSummary, stakingDelegations };
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }
        };

        // Try up to 3 times with different timeouts
        let spotData;
        let attempt = 0;
        let success = false;

        while (attempt < 3 && !success) {
            try {
                attempt++;
                await bot.editMessageText(`🔄 Loading spot balances & staking${'.'.repeat(attempt)}`, {
                    chat_id: chatId,
                    message_id: loadingMessage.message_id
                });

                spotData = await fetchSpotDataWithTimeout();
                success = true;
            } catch (error) {
                console.error(`Attempt ${attempt} failed:`, error);
                if (attempt >= 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between attempts
            }
        }

        const { spotBalances, stakingSummary, stakingDelegations } = spotData;

        if (!spotBalances) {
            throw new Error('Failed to fetch spot balances');
        }

        // Get current spot prices
        let spotMids = {};
        try {
            spotMids = await hlAPI.getSpotPrices();
        } catch (error) {
            console.log('Could not fetch spot prices:', error.message);
        }

        const trackedWallet = userWallets.find(w => w.wallet_address.toLowerCase() === walletAddress.toLowerCase());
        const displayName = trackedWallet?.nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;

        let statusMessage = `💰 *${displayName}'s Spot Balances & Staking*\n\n`;

        // === SPOT BALANCES SECTION ===
        statusMessage += `🪙 *Spot Token Balances:*\n`;
        
        // Get spot balances from HyperCore spot endpoint
        try {
            if (spotBalances && spotBalances.balances && Array.isArray(spotBalances.balances) && spotBalances.balances.length > 0) {
                const significantBalances = spotBalances.balances.filter(balance => {
                    const total = parseFloat(balance.total || 0);
                    return total > 0.001; // Only show balances > 0.001
                });

                if (significantBalances.length > 0) {
                    // Sort balances by USD value (estimated) for better display
                    significantBalances.sort((a, b) => {
                        const aValue = parseFloat(a.total || 0);
                        const bValue = parseFloat(b.total || 0);
                        
                        // Prioritize USDC and HYPE, then by amount
                        if (a.coin === 'USDC') return -1;
                        if (b.coin === 'USDC') return 1;
                        if (a.coin === 'HYPE') return -1;
                        if (b.coin === 'HYPE') return 1;
                        
                        return bValue - aValue;
                    });

                    significantBalances.forEach(balance => {
                        const total = parseFloat(balance.total || 0);
                        const hold = parseFloat(balance.hold || 0);
                        const available = total - hold;
                        const coin = balance.coin || 'Unknown';
                        
                        statusMessage += `• *${coin}:* ${total.toLocaleString()}`;
                        
                        // Add current price if available (for non-USDC tokens)
                        if (coin !== 'USDC') {
                            let priceKey = coin;
                            // Try different price key formats for spot markets
                            if (!spotMids[priceKey]) {
                                priceKey = `@${coin}`;  // Some spot tokens use @ prefix
                            }
                            if (!spotMids[priceKey]) {
                                priceKey = `${coin}/USDC`;  // Some use pair format
                            }
                            
                            const currentPrice = spotMids[priceKey] ? parseFloat(spotMids[priceKey]) : null;
                            if (currentPrice) {
                                const usdValue = total * currentPrice;
                                statusMessage += ` (~$${usdValue.toLocaleString()})`;
                                statusMessage += `\n    💲 Price: $${currentPrice.toLocaleString()}`;
                            }
                        }
                        
                        if (hold > 0) {
                            statusMessage += `\n    💳 Available: ${available.toLocaleString()}`;
                        }
                        statusMessage += `\n`;
                    });
                    statusMessage += `\n`;
                } else {
                    statusMessage += `No significant spot balances\n\n`;
                }
            } else {
                statusMessage += `No HyperCore spot balances\n\n`;
            }
        } catch (error) {
            console.error('Error processing spot balances:', error);
            statusMessage += `Error loading spot balances\n\n`;
        }

        // === STAKING SECTION ===
        statusMessage += `🔶 *HYPE Staking:*\n`;
        
        try {
            if (stakingSummary && (parseFloat(stakingSummary.delegated || 0) > 0 || parseFloat(stakingSummary.totalPendingWithdrawal || 0) > 0)) {
                const delegated = parseFloat(stakingSummary.delegated || 0);
                const pendingWithdrawal = parseFloat(stakingSummary.totalPendingWithdrawal || 0);
                const undelegated = parseFloat(stakingSummary.undelegated || 0);
                
                // Get HYPE price for USD calculations
                let hypePrice = null;
                let hypePriceKey = 'HYPE';
                if (!spotMids[hypePriceKey]) {
                    hypePriceKey = '@HYPE';
                }
                if (!spotMids[hypePriceKey]) {
                    hypePriceKey = 'HYPE/USDC';
                }
                hypePrice = spotMids[hypePriceKey] ? parseFloat(spotMids[hypePriceKey]) : null;
                
                statusMessage += `💰 *Total Staked:* ${delegated.toLocaleString()} HYPE`;
                if (hypePrice && delegated > 0) {
                    const stakedValue = delegated * hypePrice;
                    statusMessage += ` (~$${stakedValue.toLocaleString()})`;
                }
                statusMessage += `\n`;
                
                if (undelegated > 0) {
                    statusMessage += `💳 *Available to Stake:* ${undelegated.toLocaleString()} HYPE`;
                    if (hypePrice) {
                        const availableValue = undelegated * hypePrice;
                        statusMessage += ` (~$${availableValue.toLocaleString()})`;
                    }
                    statusMessage += `\n`;
                }
                
                if (hypePrice) {
                    statusMessage += `💲 *HYPE Price:* $${hypePrice.toLocaleString()}\n`;
                }
                
                if (pendingWithdrawal > 0) {
                    statusMessage += `⏳ *Unstaking Queue:* ${pendingWithdrawal.toLocaleString()} HYPE`;
                    if (hypePrice) {
                        const pendingValue = pendingWithdrawal * hypePrice;
                        statusMessage += ` (~$${pendingValue.toLocaleString()})`;
                    }
                    statusMessage += `\n`;
                    const nWithdrawals = stakingSummary.nPendingWithdrawals || 0;
                    statusMessage += `   (${nWithdrawals} withdrawal${nWithdrawals > 1 ? 's' : ''})\n`;
                }
                
                // Show individual delegations
                if (stakingDelegations && Array.isArray(stakingDelegations) && stakingDelegations.length > 0) {
                    statusMessage += `\n🔐 *Active Delegations:*\n`;
                    
                    stakingDelegations.forEach((delegation, index) => {
                        const amount = parseFloat(delegation.amount || 0);
                        const validator = delegation.validator || 'Unknown';
                        
                        statusMessage += `${index + 1}. ${amount.toLocaleString()} HYPE\n`;
                        statusMessage += `   Validator: \`${validator.slice(0, 8)}...${validator.slice(-6)}\`\n`;
                        
                        if (delegation.lockedUntilTimestamp) {
                            const lockUntil = new Date(delegation.lockedUntilTimestamp);
                            const isLocked = lockUntil > new Date();
                            
                            if (isLocked) {
                                const timeLeft = Math.ceil((lockUntil - new Date()) / (1000 * 60 * 60)); // hours
                                if (timeLeft > 24) {
                                    statusMessage += `   🔒 Locked for ${Math.ceil(timeLeft / 24)} more day${Math.ceil(timeLeft / 24) > 1 ? 's' : ''}\n`;
                                } else {
                                    statusMessage += `   🔒 Locked for ${timeLeft} more hour${timeLeft > 1 ? 's' : ''}\n`;
                                }
                            } else {
                                statusMessage += `   ✅ Available to undelegate\n`;
                            }
                        }
                        statusMessage += `\n`;
                    });
                }
            } else {
                statusMessage += `No HYPE staked${stakingSummary ? '' : ' (staking data unavailable)'}\n\n`;
            }
        } catch (error) {
            console.error('Error processing staking data:', error);
            statusMessage += `Error loading staking data\n\n`;
        }

        // Add wallet address at the bottom
        statusMessage += `🔗 \`${walletAddress}\``;

        // Check message length and split if necessary
        const maxTelegramLength = 4000; // Safe limit
        
        // Delete loading message first
        await bot.deleteMessage(chatId, loadingMessage.message_id);
        
        if (statusMessage.length <= maxTelegramLength) {
            // Send as single message
            await bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
        } else {
            // Split into multiple messages
            const lines = statusMessage.split('\n');
            let currentMessage = '';
            let messageCount = 1;
            
            for (const line of lines) {
                if (currentMessage.length + line.length + 1 > maxTelegramLength - 100) { // Leave room for part number
                    // Send current message
                    const partMessage = currentMessage + `\n\n📱 *Part ${messageCount}*`;
                    await bot.sendMessage(chatId, partMessage, { parse_mode: 'Markdown' });
                    
                    // Reset for next message
                    currentMessage = line + '\n';
                    messageCount++;
                    
                    // Add small delay
                    await new Promise(resolve => setTimeout(resolve, 500));
                } else {
                    currentMessage += line + '\n';
                }
            }
            
            // Send final message
            if (currentMessage.trim().length > 0) {
                let finalMessage = currentMessage;
                if (messageCount > 1) {
                    finalMessage += `\n📱 *Part ${messageCount} (Final)*`;
                }
                await bot.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });
            }
        }

    } catch (error) {
        console.error('Error in spotStatus command:', error);
        await bot.sendMessage(chatId, '❌ Error fetching spot balances and staking data. Please try again.');
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
    helpMessage += `• HYPE staking & unstaking alerts\n`;
    helpMessage += `• TWAP order tracking\n`;
    helpMessage += `• 🚨 Global alerts for large HYPE staking/unstaking (>10,000 HYPE)\n`;
    helpMessage += `• Track up to ${config.MAX_TRACKED_WALLETS_PER_USER} wallets per user\n`;
    helpMessage += `• Personalized tracking (only your wallets)\n`;
    helpMessage += `• Separate perp & spot monitoring\n`;
    helpMessage += `• Portfolio monitoring\n\n`;
    helpMessage += `*Command Types:*\n`;
    helpMessage += `• \`/perpStatus\` - Shows perpetual positions\n`;
    helpMessage += `• \`/spotStatus\` - Shows spot balances & HYPE staking\n\n`;
    helpMessage += `*Example Usage:*\n`;
    helpMessage += `\`/add 0x1234...5678 MyTradingWallet\`\n`;
    helpMessage += `\`/perpStatus MyTradingWallet\` (all positions)\n`;
    helpMessage += `\`/perpStatus MyTradingWallet top5\` (top 5 positions)\n`;
    helpMessage += `\`/perpStatus MyTradingWallet summary\` (quick overview)\n`;
    helpMessage += `\`/spotStatus MyTradingWallet\` (spot & staking)\n`;
    helpMessage += `\`/remove 0x1234...5678\`\n\n`;
    helpMessage += `📱 *Navigation:*\n`;
    helpMessage += `• Use ⬅️ ➡️ buttons to navigate pages\n`;
    helpMessage += `• Tap 🔄 Refresh to update live data\n`;
    helpMessage += `• Page indicator shows current position\n\n`;
    helpMessage += `🔗 *Join Hyperliquid:* [Click here to start trading](https://app.hyperliquid.xyz/join/0XRYKER)`;

    await bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true 
    });
});

// Debug command to get user ID
bot.onText(/\/myid/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || 'No username';
    const firstName = msg.from.first_name || 'No name';
    
    await bot.sendMessage(chatId, 
        `🆔 *Your Telegram Info:*\n\n` +
        `• User ID: \`${userId}\`\n` +
        `• Username: @${username}\n` +
        `• Name: ${firstName}\n` +
        `• Chat ID: \`${chatId}\`\n\n` +
        `Copy your User ID and add it to your .env file as:\n` +
        `\`BOT_OWNER_TELEGRAM_ID=${userId}\``,
        { parse_mode: 'Markdown' }
    );
});

// Admin command for bot owner to get stats on demand
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    // Check if user is the bot owner
    if (config.BOT_OWNER_TELEGRAM_ID && userId.toString() === config.BOT_OWNER_TELEGRAM_ID.toString()) {
        try {
            await bot.sendMessage(chatId, '🔄 Generating bot statistics...');
            
            const stats = await db.getUserStatistics();
            const currentDate = new Date().toLocaleString();
            
            let statsMessage = `📊 *Bot Statistics - ${currentDate}*\n\n`;
            
            statsMessage += `👥 *User Statistics:*\n`;
            statsMessage += `• Total Users: ${stats.totalUsers.toLocaleString()}\n`;
            statsMessage += `• New Users Today: ${stats.newUsersToday}\n`;
            statsMessage += `• New Users This Week: ${stats.newUsersThisWeek}\n\n`;
            
            statsMessage += `💼 *Wallet Tracking:*\n`;
            statsMessage += `• Total Tracked Wallets: ${stats.totalTrackedWallets.toLocaleString()}\n`;
            statsMessage += `• Unique Wallets: ${stats.uniqueTrackedWallets.toLocaleString()}\n`;
            statsMessage += `• Avg Wallets per User: ${stats.avgWalletsPerUser}\n\n`;
            
            statsMessage += `📈 *Activity (Last 24h):*\n`;
            statsMessage += `• Orders/Notifications Sent: ${stats.ordersProcessedToday.toLocaleString()}\n\n`;
            
            if (stats.totalUsers > 0) {
                const growthToday = stats.newUsersToday;
                const growthWeek = stats.newUsersThisWeek;
                
                statsMessage += `📊 *Growth Metrics:*\n`;
                if (growthToday > 0) {
                    const dailyGrowthPercent = ((growthToday / (stats.totalUsers - growthToday)) * 100).toFixed(2);
                    statsMessage += `• Daily Growth: +${dailyGrowthPercent}%\n`;
                } else {
                    statsMessage += `• Daily Growth: 0%\n`;
                }
                if (growthWeek > 0) {
                    const weeklyGrowthPercent = ((growthWeek / (stats.totalUsers - growthWeek)) * 100).toFixed(2);
                    statsMessage += `• Weekly Growth: +${weeklyGrowthPercent}%\n`;
                } else {
                    statsMessage += `• Weekly Growth: 0%\n`;
                }
                statsMessage += `\n`;
            }
            
            statsMessage += `🤖 *Bot Health:*\n`;
            statsMessage += `• Status: ✅ Running\n`;
            statsMessage += `• Monitoring: ${config.POLLING_INTERVAL}s intervals\n`;
            statsMessage += `• Max Wallets/User: ${config.MAX_TRACKED_WALLETS_PER_USER}\n\n`;
            
            statsMessage += `⚡ *Manual stats request*`;
            
            await bot.sendMessage(chatId, statsMessage, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true 
            });
            
        } catch (error) {
            console.error('Error generating manual stats:', error);
            await bot.sendMessage(chatId, `❌ Error generating statistics:\n\n\`${error.message}\``, { parse_mode: 'Markdown' });
        }
    } else {
        // Not the bot owner
        await bot.sendMessage(chatId, '❌ This command is only available to the bot administrator.');
    }
});

// Function to create position message display
function createPositionMessage(positions, allMids) {
    let message = '';
    for (const pos of positions) {
        const coin = pos.position.coin;
        const size = pos.position.szi;
        const pnl = parseFloat(pos.position.unrealizedPnl);
        const entryPrice = parseFloat(pos.position.entryPx || '0');
        const direction = parseFloat(size) > 0 ? '📈 Long' : '📉 Short';
        const pnlEmoji = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';

        message += `┌ *${direction} ${coin}*\n`;
        message += `├ Size: ${Math.abs(size)} | Entry: $${entryPrice.toLocaleString()}\n`;
        
        // Add current price if available
        const currentPrice = allMids[coin] ? parseFloat(allMids[coin]) : null;
        if (currentPrice && entryPrice > 0) {
            const priceChange = ((currentPrice - entryPrice) / entryPrice * 100);
            const changeColor = priceChange >= 0 ? '🟢' : '🔴';
            message += `├ Current: $${currentPrice.toLocaleString()} ${changeColor} ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%\n`;
        }
        
        message += `└ ${pnlEmoji} PnL: $${Number(pnl).toLocaleString()}\n\n`;
    }
    return message;
}





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
                        const activityId = `${activity.time}_${activity.oid || activity.tid || activity.hash || Math.random()}`;
                        const alreadyProcessed = await db.isOrderProcessed(walletAddress, activityId);
                        
                        if (!alreadyProcessed) {
                            await db.markOrderProcessed(walletAddress, activityId);
                            
                            // Check for large HYPE staking/unstaking events (>10,000 HYPE)
                            if (activity.type === 'staking_activity') {
                                const amount = parseFloat(activity.amount || 0);
                                if (amount > 10000) {
                                    await sendLargeStakingNotificationToAll(activity, walletAddress);
                                }
                            }
                            
                            for (const user of usersTracking) {
                                try {
                                    let message;
                                    if (activity.type === 'staking_activity') {
                                        message = hlAPI.formatStakingMessage(activity, walletAddress, user.nickname);
                                    } else {
                                        message = hlAPI.formatOrderMessage(activity, walletAddress, user.nickname);
                                    }
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

async function sendLargeStakingNotificationToAll(activity, walletAddress) {
    try {
        const amount = parseFloat(activity.amount || 0);
        const actionType = activity.actionType || 'staking';
        const timestamp = new Date(activity.time).toLocaleString();
        
        // Format the global notification message
        let message = `🚨 *Large HYPE ${actionType.toUpperCase()} Alert* 🚨\n\n`;
        
        if (actionType === 'delegate' || actionType === 'staking') {
            message += `📈 *${amount.toLocaleString()} HYPE* has been staked!\n`;
            message += `🔗 *Wallet:* \`${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}\`\n`;
            if (activity.validator) {
                message += `🏛️ *Validator:* \`${activity.validator.slice(0, 8)}...${activity.validator.slice(-6)}\`\n`;
            }
        } else if (actionType === 'undelegate' || actionType === 'unstaking') {
            message += `📉 *${amount.toLocaleString()} HYPE* is being unstaked!\n`;
            message += `🔗 *Wallet:* \`${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}\`\n`;
            message += `⏰ *Note:* Will be available after 7-day unstaking period\n`;
            if (activity.validator) {
                message += `🏛️ *From Validator:* \`${activity.validator.slice(0, 8)}...${activity.validator.slice(-6)}\`\n`;
            }
        } else if (actionType === 'cDeposit') {
            message += `💰 *${amount.toLocaleString()} HYPE* deposited to staking!\n`;
            message += `🔗 *Wallet:* \`${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}\`\n`;
        } else if (actionType === 'cWithdraw') {
            message += `💸 *${amount.toLocaleString()} HYPE* withdrawn from staking!\n`;
            message += `🔗 *Wallet:* \`${walletAddress.slice(0, 8)}...${walletAddress.slice(-6)}\`\n`;
        }
        
        message += `⏰ *Time:* ${timestamp}\n\n`;
        message += `💡 Large staking activities can impact network security and HYPE price dynamics.`;
        
        // Get all bot users
        const allUsers = await db.getAllUsers();
        
        console.log(`🚨 Sending large staking alert to ${allUsers.length} users: ${amount.toLocaleString()} HYPE ${actionType}`);
        
        // Send to all users with rate limiting
        const batchSize = 30; // Telegram rate limit protection
        for (let i = 0; i < allUsers.length; i += batchSize) {
            const batch = allUsers.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (user) => {
                try {
                    await bot.sendMessage(user.telegram_id, message, { 
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true 
                    });
                } catch (error) {
                    console.error(`Error sending large staking alert to user ${user.telegram_id}:`, error);
                }
            }));
            
            // Wait between batches to avoid rate limits
            if (i + batchSize < allUsers.length) {
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between batches
            }
        }
        
    } catch (error) {
        console.error('Error sending large staking notifications:', error);
    }
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

async function sendDailyStatsToOwner() {
    if (!config.BOT_OWNER_TELEGRAM_ID) {
        console.log('Bot owner Telegram ID not configured, skipping daily stats');
        return;
    }

    try {
        const stats = await db.getUserStatistics();
        const currentDate = new Date().toLocaleDateString();
        
        let statsMessage = `📊 *Daily Bot Statistics - ${currentDate}*\n\n`;
        
        statsMessage += `👥 *User Statistics:*\n`;
        statsMessage += `• Total Users: ${stats.totalUsers.toLocaleString()}\n`;
        statsMessage += `• New Users Today: ${stats.newUsersToday}\n`;
        statsMessage += `• New Users This Week: ${stats.newUsersThisWeek}\n\n`;
        
        statsMessage += `💼 *Wallet Tracking:*\n`;
        statsMessage += `• Total Tracked Wallets: ${stats.totalTrackedWallets.toLocaleString()}\n`;
        statsMessage += `• Unique Wallets: ${stats.uniqueTrackedWallets.toLocaleString()}\n`;
        statsMessage += `• Avg Wallets per User: ${stats.avgWalletsPerUser}\n\n`;
        
        statsMessage += `📈 *Activity (Last 24h):*\n`;
        statsMessage += `• Orders/Notifications Sent: ${stats.ordersProcessedToday.toLocaleString()}\n\n`;
        
        // Calculate growth metrics if we have data
        if (stats.totalUsers > 0) {
            const growthToday = stats.newUsersToday;
            const growthWeek = stats.newUsersThisWeek;
            
            statsMessage += `📊 *Growth Metrics:*\n`;
            if (growthToday > 0) {
                const dailyGrowthPercent = ((growthToday / (stats.totalUsers - growthToday)) * 100).toFixed(2);
                statsMessage += `• Daily Growth: +${dailyGrowthPercent}%\n`;
            }
            if (growthWeek > 0) {
                const weeklyGrowthPercent = ((growthWeek / (stats.totalUsers - growthWeek)) * 100).toFixed(2);
                statsMessage += `• Weekly Growth: +${weeklyGrowthPercent}%\n`;
            }
            statsMessage += `\n`;
        }
        
        statsMessage += `🤖 *Bot Health:*\n`;
        statsMessage += `• Status: ✅ Running\n`;
        statsMessage += `• Monitoring Interval: ${config.POLLING_INTERVAL} seconds\n`;
        statsMessage += `• Max Wallets per User: ${config.MAX_TRACKED_WALLETS_PER_USER}\n\n`;
        
        statsMessage += `🔗 *Hyperliquid Order Tracker*\n`;
        statsMessage += `_Daily stats report sent automatically_`;
        
        await bot.sendMessage(config.BOT_OWNER_TELEGRAM_ID, statsMessage, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true 
        });
        
        console.log(`📊 Daily stats sent to bot owner: ${stats.totalUsers} users, ${stats.ordersProcessedToday} notifications today`);
        
    } catch (error) {
        console.error('Error sending daily stats to owner:', error);
        
        // Send error notification to owner
        try {
            await bot.sendMessage(config.BOT_OWNER_TELEGRAM_ID, 
                `❌ Error generating daily stats report:\n\n\`${error.message}\``, 
                { parse_mode: 'Markdown' }
            );
        } catch (notifyError) {
            console.error('Error sending error notification to owner:', notifyError);
        }
    }
}

// Send daily stats to bot owner at 9:00 AM every day
cron.schedule('0 9 * * *', sendDailyStatsToOwner);

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
