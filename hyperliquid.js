const axios = require('axios');
const config = require('./config');

class HyperliquidAPI {
    constructor() {
        this.baseURL = config.HYPERLIQUID_API_URL;
        this.infoEndpoint = `${this.baseURL}/info`;
        this.metaEndpoint = `${this.baseURL}/meta`;
        this.exchangeEndpoint = 'https://api.hyperliquid.xyz/exchange';
        
        this._cachedMarkets = null;
        this._lastMarketUpdate = 0;
        
        // Cache for spot metadata
        this._spotMetaCache = null;
        this._spotMetaCacheTime = null;
        
        // Cache for perp metadata
        this._perpMetaCache = null;
        this._perpMetaCacheTime = null;
        
        this._CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
    }

    async getUserFills(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'userFills',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching fills for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserTwapSliceFills(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'userTwapSliceFills',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching TWAP slice fills for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserOpenOrders(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'openOrders',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching open orders for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserOrderHistory(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'orderHistory',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching order history for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserAssets(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'clearinghouseState',
                user: user
            });
            return response.data || null;
        } catch (error) {
            console.error(`Error fetching assets for user ${user}:`, error.message);
            return null;
        }
    }

    async getUserSpotBalances(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'spotClearinghouseState',
                user: user
            });
            return response.data || null;
        } catch (error) {
            console.error(`Error fetching spot balances for user ${user}:`, error.message);
            return null;
        }
    }

    async getMeta() {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'meta'
            });
            return response.data || null;
        } catch (error) {
            console.error('Error fetching meta data:', error.message);
            return null;
        }
    }

    async getSpotMeta() {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'spotMeta'
            });
            return response.data || null;
        } catch (error) {
            console.error('Error fetching spot meta data:', error.message);
            return null;
        }
    }

    async getCachedSpotMeta() {
        const now = Date.now();
        if (this._spotMetaCache && this._spotMetaCacheTime && (now - this._spotMetaCacheTime < this._CACHE_DURATION)) {
            return this._spotMetaCache;
        }
        
        const spotMeta = await this.getSpotMeta();
        if (spotMeta) {
            this._spotMetaCache = spotMeta;
            this._spotMetaCacheTime = now;
        }
        return spotMeta;
    }

    async getCachedPerpMeta() {
        const now = Date.now();
        if (this._perpMetaCache && this._perpMetaCacheTime && (now - this._perpMetaCacheTime < this._CACHE_DURATION)) {
            return this._perpMetaCache;
        }
        
        const perpMeta = await this.getMeta();
        if (perpMeta) {
            this._perpMetaCache = perpMeta;
            this._perpMetaCacheTime = now;
        }
        return perpMeta;
    }

    async resolveCoinName(coin) {
        if (!coin) return 'Unknown';
        
        // If coin starts with @, it's a spot market ID that needs resolution
        if (coin.startsWith('@')) {
            try {
                const spotMeta = await this.getCachedSpotMeta();
                
                if (spotMeta && spotMeta.universe && spotMeta.tokens) {
                    const spotId = parseInt(coin.substring(1)); // Remove @ and convert to number
                    
                    const spotAsset = spotMeta.universe.find(asset => asset.index === spotId);
                    
                    if (spotAsset) {
                        // If the asset name doesn't start with @, return it as-is (e.g., "PURR/USDC")
                        if (!spotAsset.name.startsWith('@')) {
                            return spotAsset.name;
                        }
                        
                        // If the asset name starts with @, resolve token names from tokens array
                        if (spotAsset.tokens && spotAsset.tokens.length >= 2) {
                            const token1Index = spotAsset.tokens[0];
                            const token2Index = spotAsset.tokens[1];
                            
                            const token1 = spotMeta.tokens[token1Index];
                            const token2 = spotMeta.tokens[token2Index];
                            
                            if (token1 && token2 && token1.name && token2.name) {
                                return `${token1.name}/${token2.name}`;
                            } else {
                                console.warn(`Could not resolve tokens for ${coin}. Token1: ${token1?.name}, Token2: ${token2?.name}`);
                                return `Spot Asset #${spotId}`;
                            }
                        } else {
                            console.warn(`Spot asset ${coin} missing tokens array:`, spotAsset.tokens);
                            return `Spot Asset #${spotId}`;
                        }
                    } else {
                        console.warn(`Spot asset with index ${spotId} not found. Available assets:`, 
                            spotMeta.universe.slice(0, 5).map(a => ({ index: a.index, name: a.name })));
                        return `Spot Asset #${spotId}`;
                    }
                } else {
                    console.error('Spot metadata is missing universe, tokens, or both properties');
                    return `Spot Asset ${coin}`;
                }
            } catch (error) {
                console.error('Error resolving spot coin name:', error.message);
                return `Spot Asset ${coin}`;
            }
        }
        
        // If coin is a number (string), it's likely a perp market ID that needs resolution
        else if (/^\d+$/.test(coin)) {
            try {
                const perpMeta = await this.getCachedPerpMeta();
                if (perpMeta && perpMeta.universe) {
                    const perpId = parseInt(coin);
                    const perpAsset = perpMeta.universe.find(asset => asset.index === perpId);
                    if (perpAsset && perpAsset.name) {
                        return perpAsset.name;
                    } else {
                        console.warn(`Perp asset with index ${perpId} not found or missing name`);
                        return `Perp Asset #${perpId}`;
                    }
                } else {
                    console.error('Perp metadata is missing or has no universe property');
                    return `Perp Asset ${coin}`;
                }
            } catch (error) {
                console.error('Error resolving perp coin name:', error.message);
                return `Perp Asset ${coin}`;
            }
        }
        
        return coin; // Return original if resolution failed or not a numeric/@ ID
    }

    async getAllMids() {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'allMids'
            });
            return response.data || {};
        } catch (error) {
            console.error('Error fetching current prices:', error.message);
            return {};
        }
    }

    async getSpotPrices() {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'spotMids'  
            });
            return response.data || {};
        } catch (error) {
            console.error('Error fetching spot prices:', error.message);
            return {};
        }
    }

    async getCurrentPrice(symbol) {
        try {
            const [perpMids, spotMids] = await Promise.all([
                this.getAllMids(),
                this.getSpotPrices()
            ]);
            
            // Check perp markets first
            if (perpMids[symbol]) {
                return {
                    price: parseFloat(perpMids[symbol]),
                    type: 'perp',
                    symbol: symbol
                };
            }
            
            // Check spot markets
            if (spotMids[symbol]) {
                return {
                    price: parseFloat(spotMids[symbol]),
                    type: 'spot',
                    symbol: symbol
                };
            }
            
            return null;
        } catch (error) {
            console.error(`Error fetching price for ${symbol}:`, error.message);
            return null;
        }
    }

    async getUserTradeHistory(user, limit = 100) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'userFills',
                user: user
            });
            
            const fills = response.data || [];
            return fills
                .sort((a, b) => b.time - a.time)
                .slice(0, limit);
        } catch (error) {
            console.error(`Error fetching trade history for user ${user}:`, error.message);
            return [];
        }
    }

    async getRecentActivity(user, sinceTime = null) {
        try {
            const [fills, orders, twapFills, stakingHistory] = await Promise.all([
                this.getUserFills(user),
                this.getUserOrderHistory(user),
                this.getUserTwapSliceFills(user),
                this.getRecentStakingActivity(user, sinceTime)
            ]);

            let activities = [
                ...fills.map(fill => ({ ...fill, type: 'fill' })),
                ...orders.map(order => ({ ...order, type: 'order' })),
                ...twapFills.map(twapData => ({ 
                    ...twapData.fill, 
                    type: 'twap_fill', 
                    twapId: twapData.twapId 
                })),
                ...stakingHistory
            ];

            if (sinceTime) {
                activities = activities.filter(activity => activity.time > sinceTime);
            }

            return activities.sort((a, b) => b.time - a.time);
        } catch (error) {
            console.error(`Error fetching recent activity for user ${user}:`, error.message);
            return [];
        }
    }

    async formatOrderMessage(order, walletAddress, nickname = null) {
        const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        const rawSide = order.side || 'Unknown';
        const size = order.sz || order.size || 'Unknown';
        const price = order.px || order.price || 'Market';
        const rawCoin = order.coin || 'Unknown';
        const coin = await this.resolveCoinName(rawCoin);
        const timestamp = order.time ? new Date(order.time).toLocaleString() : 'Unknown';
        
        let status = 'Unknown';
        let orderTypeIcon = '🔔';
        let orderTypeText = 'Order Activity';
        
        if (order.type === 'fill') {
            status = 'Filled';
        } else if (order.type === 'twap_fill') {
            status = 'TWAP Slice Filled';
            orderTypeIcon = '🔄';
            orderTypeText = 'TWAP Order Activity';
        } else if (order.orderStatus) {
            status = order.orderStatus;
        }

        const isSpotMarket = rawCoin.includes('/') || rawCoin.startsWith('@');
        const marketType = isSpotMarket ? 'Spot' : 'Perp';
        
        // Convert side to user-friendly format
        let displaySide;
        if (rawSide === 'B') {
            displaySide = isSpotMarket ? 'Buy' : 'Long';
        } else if (rawSide === 'A') {
            displaySide = isSpotMarket ? 'Sell' : 'Short';
        } else {
            displaySide = rawSide.toUpperCase();
        }

        let message = `${orderTypeIcon} *New ${orderTypeText}*\n\n` +
                     `👤 *Wallet:* ${walletName}\n` +
                     `📈 *Pair:* ${coin}\n` +
                     `🏪 *Market:* ${marketType}\n` +
                     `📊 *Side:* ${displaySide}\n` +
                     `💰 *Size:* ${size}\n` +
                     `💲 *Price:* ${price === 'Market' ? 'Market Order' : price}\n` +
                     `📝 *Status:* ${status}\n`;

        if (order.type === 'twap_fill' && order.twapId) {
            message += `🆔 *TWAP ID:* ${order.twapId}\n`;
        }

        if (order.closedPnl && parseFloat(order.closedPnl) !== 0) {
            const pnlValue = parseFloat(order.closedPnl);
            const pnlEmoji = pnlValue > 0 ? '📈' : '📉';
            message += `${pnlEmoji} *PnL:* $${order.closedPnl}\n`;
        }

        message += `⏰ *Time:* ${timestamp}\n\n` +
                  `🔗 *Address:* \`${walletAddress}\``;

        return message;
    }

    async formatAssetMessage(assetData, walletAddress, nickname = null) {
        if (!assetData || !assetData.assetPositions) {
            return null;
        }

        const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        const positions = assetData.assetPositions;
        
        let message = `💼 *Portfolio Update*\n\n👤 *Wallet:* ${walletName}\n\n`;
        
        if (positions.length === 0) {
            message += '📊 *Positions:* No open positions\n';
        } else {
            message += '📊 *Open Positions:*\n';
            for (const pos of positions) {
                const size = pos.position?.szi || '0';
                const rawCoin = pos.position?.coin || 'Unknown';
                const coin = await this.resolveCoinName(rawCoin);
                const pnl = pos.position?.unrealizedPnl || '0';
                const entryPrice = pos.position?.entryPx || '0';
                
                if (parseFloat(size) !== 0) {
                    message += `   • ${coin}: ${size} (Entry: $${entryPrice}, PnL: $${pnl})\n`;
                }
            }
        }
        
        message += `\n🔗 *Address:* \`${walletAddress}\``;
        return message;
    }

    isValidAddress(address) {
        return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    async getAllMarkets() {
        try {
            const response = await axios.post(this.metaEndpoint, {
                type: 'meta'
            });
            return response.data || { universe: [] };
        } catch (error) {
            console.error('Error fetching markets:', error.message);
            return { universe: [] };
        }
    }

    async getNewMarkets() {
        const currentTime = Date.now();
        
        if (this._lastMarketUpdate && currentTime - this._lastMarketUpdate < 300000) { // 5 minutes cache
            return { newPerps: [], newSpots: [] };
        }

        try {
            const currentMeta = await this.getMeta();
            const currentSpotMeta = await this.getSpotMeta();
            
            const newPerps = [];
            const newSpots = [];

            if (this._cachedMarkets) {
                // Check for new perp markets
                const oldPerpAssets = new Set(this._cachedMarkets.perps.map(asset => asset.name));
                const newPerpAssets = currentMeta.universe.filter(asset => !oldPerpAssets.has(asset.name));
                newPerps.push(...newPerpAssets);

                // Check for new spot markets
                const oldSpotAssets = new Set(this._cachedMarkets.spots.map(asset => asset.name));
                const newSpotAssets = currentSpotMeta.universe.filter(asset => !oldSpotAssets.has(asset.name));
                newSpots.push(...newSpotAssets);
            }

            this._cachedMarkets = {
                perps: currentMeta.universe,
                spots: currentSpotMeta.universe
            };
            this._lastMarketUpdate = currentTime;

            return { newPerps, newSpots };
        } catch (error) {
            console.error('Error checking for new markets:', error.message);
            return { newPerps: [], newSpots: [] };
        }
    }

    async getUserStakingDelegations(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'delegations',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching staking delegations for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserStakingSummary(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'delegatorSummary', 
                user: user
            });
            return response.data || null;
        } catch (error) {
            console.error(`Error fetching staking summary for user ${user}:`, error.message);
            return null;
        }
    }

    async getUserStakingHistory(user, startTime = null, endTime = null) {
        try {
            const requestBody = {
                type: 'delegatorHistory',
                user: user
            };
            
            if (startTime) requestBody.startTime = startTime;
            if (endTime) requestBody.endTime = endTime;

            const response = await axios.post(this.infoEndpoint, requestBody);
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching staking history for user ${user}:`, error.message);
            return [];
        }
    }

    async getUserStakingRewards(user) {
        try {
            const response = await axios.post(this.infoEndpoint, {
                type: 'delegatorRewards',
                user: user
            });
            return response.data || [];
        } catch (error) {
            console.error(`Error fetching staking rewards for user ${user}:`, error.message);
            return [];
        }
    }

    async getRecentStakingActivity(user, sinceTime = null) {
        try {
            const stakingHistory = await this.getUserStakingHistory(user, sinceTime);
            
            // Filter and format staking activities
            let activities = stakingHistory.map(activity => ({
                ...activity,
                type: 'staking_activity'
            }));

            if (sinceTime) {
                activities = activities.filter(activity => activity.time > sinceTime);
            }

            return activities.sort((a, b) => b.time - a.time);
        } catch (error) {
            console.error(`Error fetching recent staking activity for user ${user}:`, error.message);
            return [];
        }
    }

    formatStakingMessage(activity, walletAddress, nickname = null) {
        const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        const timestamp = activity.time ? new Date(activity.time).toLocaleString() : 'Unknown';
        
        let message = '';
        let icon = '🔶';
        let activityType = 'Staking Activity';
        
        if (activity.delta) {
            if (activity.delta.delegate) {
                const delegate = activity.delta.delegate;
                const amount = parseFloat(delegate.amount);
                const validator = delegate.validator;
                const isUndelegate = delegate.isUndelegate;
                
                if (isUndelegate) {
                    icon = '📤';
                    activityType = 'HYPE Unstaking';
                } else {
                    icon = '📥';
                    activityType = 'HYPE Staking';
                }
                
                message = `${icon} *${activityType}*\n\n` +
                         `👤 *Wallet:* ${walletName}\n` +
                         `🏪 *Action:* ${isUndelegate ? 'Undelegate' : 'Delegate'}\n` +
                         `💰 *Amount:* ${amount.toLocaleString()} HYPE\n` +
                         `🔐 *Validator:* \`${validator.slice(0, 8)}...${validator.slice(-6)}\`\n`;
                
                if (!isUndelegate) {
                    message += `⏱️ *Lock Period:* 1 day\n`;
                } else {
                    message += `⏱️ *Unstaking Queue:* 7 days\n`;
                }
                
            } else if (activity.delta.cDeposit) {
                icon = '💰';
                activityType = 'Spot to Staking Transfer';
                const amount = parseFloat(activity.delta.cDeposit.wei) / 1e18; // Convert wei to HYPE
                
                message = `${icon} *${activityType}*\n\n` +
                         `👤 *Wallet:* ${walletName}\n` +
                         `🏪 *Action:* Deposit to Staking\n` +
                         `💰 *Amount:* ${amount.toLocaleString()} HYPE\n`;
                         
            } else if (activity.delta.cWithdraw) {
                icon = '💸';
                activityType = 'Staking to Spot Transfer';
                const amount = parseFloat(activity.delta.cWithdraw.wei) / 1e18; // Convert wei to HYPE
                
                message = `${icon} *${activityType}*\n\n` +
                         `👤 *Wallet:* ${walletName}\n` +
                         `🏪 *Action:* Withdraw from Staking\n` +
                         `💰 *Amount:* ${amount.toLocaleString()} HYPE\n` +
                         `⏱️ *Processing Time:* 7 days\n`;
            }
        }
        
        if (activity.hash) {
            message += `🔗 *TX Hash:* \`${activity.hash.slice(0, 10)}...${activity.hash.slice(-8)}\`\n`;
        }
        
        message += `⏰ *Time:* ${timestamp}\n\n` +
                  `🔗 *Address:* \`${walletAddress}\``;

        return message;
    }

    formatNewMarketMessage(markets, type = 'perp') {
        if (markets.length === 0) return null;

        const marketType = type === 'perp' ? 'Perpetual' : 'Spot';
        const icon = type === 'perp' ? '⚡' : '💱';
        
        let message = `${icon} *New ${marketType} Market${markets.length > 1 ? 's' : ''} Listed!*\n\n`;
        
        markets.forEach((market, index) => {
            message += `${index + 1}. *${market.name}*\n`;
            if (market.szDecimals !== undefined) {
                message += `   Size Decimals: ${market.szDecimals}\n`;
            }
        });
        
        message += `\n🚀 Start trading now on Hyperliquid!\n`;
        message += `🔗 *Join Hyperliquid:* [Click here to start trading](https://app.hyperliquid.xyz/join/0XRYKER)`;
        
        return message;
    }
}

module.exports = HyperliquidAPI; 