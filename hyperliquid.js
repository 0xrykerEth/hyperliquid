const axios = require('axios');
const config = require('./config');

class HyperliquidAPI {
    constructor() {
        this.baseURL = config.HYPERLIQUID_API_URL;
        this.infoEndpoint = `${this.baseURL}/info`;
        this.metaEndpoint = `${this.baseURL}/meta`;
        this._cachedMarkets = null;
        this._lastMarketUpdate = 0;
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
            const [fills, orders, twapFills] = await Promise.all([
                this.getUserFills(user),
                this.getUserOrderHistory(user),
                this.getUserTwapSliceFills(user)
            ]);

            let activities = [
                ...fills.map(fill => ({ ...fill, type: 'fill' })),
                ...orders.map(order => ({ ...order, type: 'order' })),
                ...twapFills.map(twapData => ({ 
                    ...twapData.fill, 
                    type: 'twap_fill', 
                    twapId: twapData.twapId 
                }))
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

    formatOrderMessage(order, walletAddress, nickname = null) {
        const walletName = nickname || `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
        const side = order.side || 'Unknown';
        const size = order.sz || order.size || 'Unknown';
        const price = order.px || order.price || 'Market';
        const coin = order.coin || 'Unknown';
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

        const isSpotMarket = coin.includes('/') || coin.startsWith('@');
        const marketType = isSpotMarket ? 'Spot' : 'Perp';

        let message = `${orderTypeIcon} *New ${orderTypeText}*\n\n` +
                     `👤 *Wallet:* ${walletName}\n` +
                     `📈 *Pair:* ${coin}\n` +
                     `🏪 *Market:* ${marketType}\n` +
                     `📊 *Side:* ${side.toUpperCase()}\n` +
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

    formatAssetMessage(assetData, walletAddress, nickname = null) {
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
            positions.forEach(pos => {
                const size = pos.position?.szi || '0';
                const coin = pos.position?.coin || 'Unknown';
                const pnl = pos.position?.unrealizedPnl || '0';
                const entryPrice = pos.position?.entryPx || '0';
                
                if (parseFloat(size) !== 0) {
                    message += `   • ${coin}: ${size} (Entry: $${entryPrice}, PnL: $${pnl})\n`;
                }
            });
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
        try {
            const currentTime = Date.now();
            const currentMarkets = await this.getAllMarkets();
            
            // Initialize cache if needed
            if (!this._cachedMarkets) {
                this._cachedMarkets = currentMarkets;
                this._lastMarketUpdate = currentTime;
                return { newPerps: [], newSpots: [] };
            }

            const oldMarkets = this._cachedMarkets;
            
            // Find new markets
            const newPerps = [];
            const newSpots = [];

            currentMarkets.universe.forEach(market => {
                const isSpot = market.name.includes('/') || market.name.startsWith('@');
                const existingMarket = oldMarkets.universe.find(m => m.name === market.name);
                
                if (!existingMarket) {
                    if (isSpot) {
                        newSpots.push(market);
                    } else {
                        newPerps.push(market);
                    }
                }
            });

            // Update cache
            this._cachedMarkets = currentMarkets;
            this._lastMarketUpdate = currentTime;

            return { newPerps, newSpots };
        } catch (error) {
            console.error('Error checking for new markets:', error.message);
            return { newPerps: [], newSpots: [] };
        }
    }

    formatNewMarketMessage(markets, type = 'perp') {
        if (!markets || markets.length === 0) return null;

        const icon = type === 'perp' ? '⚡' : '💱';
        const marketType = type === 'perp' ? 'Perpetual' : 'Spot';
        
        let message = `${icon} *New ${marketType} Markets Added!*\n\n`;
        
        markets.forEach((market, index) => {
            message += `${index + 1}. *${market.name}*\n`;
            if (market.szDecimals) {
                message += `   • Size Decimals: ${market.szDecimals}\n`;
            }
            if (market.tickSize) {
                message += `   • Tick Size: ${market.tickSize}\n`;
            }
            if (market.minSize) {
                message += `   • Min Size: ${market.minSize}\n`;
            }
            if (market.maxLeverage) {
                message += `   • Max Leverage: ${market.maxLeverage}x\n`;
            }
            message += '\n';
        });

        message += `\n🔗 *Trade now:* [Hyperliquid Exchange](https://app.hyperliquid.xyz/join/0XRYKER)`;
        return message;
    }
}

module.exports = HyperliquidAPI; 