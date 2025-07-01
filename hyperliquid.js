const axios = require('axios');
const config = require('./config');

class HyperliquidAPI {
    constructor() {
        this.baseURL = config.HYPERLIQUID_API_URL;
        this.infoEndpoint = `${this.baseURL}/info`;
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
}

module.exports = HyperliquidAPI; 