# Hyperliquid Telegram Order Tracker

A Telegram bot that tracks Hyperliquid orders for specific wallet addresses with user authentication. Each user can track their own set of wallets and receive personalized notifications.

## Features

🔔 **Real-time Order Notifications** - Get instant alerts when tracked wallets place orders or execute trades

🔄 **TWAP Order Tracking** - Monitor Time-Weighted Average Price orders on both spot and perpetual markets

👤 **User Authentication** - Each user has their own private tracking list

📱 **Easy Commands** - Simple Telegram commands to manage your tracked wallets

💼 **Portfolio Monitoring** - Check wallet status and open positions

🏪 **Multi-Market Support** - Track both spot and perpetual market activities

🔒 **Privacy** - Only you receive notifications for wallets you're tracking

⚡ **High Performance** - Efficient polling with configurable intervals

## Bot Commands

- `/start` - Start the bot and see welcome message
- `/add <address> [nickname]` - Add a wallet to track
- `/remove <address>` - Remove a wallet from tracking
- `/list` - List all your tracked wallets
- `/perpStatus <address>` - Check perpetual positions with current prices
- `/spotStatus <address>` - Check spot balances & HYPE staking with current prices
- `/help` - Show help message

## Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather))

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd hyperliquid-telegram-tracker
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Create a `.env` file in the project root:
   ```env
   # Telegram Bot Configuration
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
   
   # Database Configuration (optional)
   DATABASE_PATH=./hyperliquid_tracker.db
   
   # Hyperliquid API Configuration (optional)
   HYPERLIQUID_API_URL=https://api.hyperliquid.xyz
   
   # Monitoring Configuration (optional)
   POLLING_INTERVAL=10
   MAX_TRACKED_WALLETS_PER_USER=5
   ```

4. **Get a Telegram Bot Token**
   - Message [@BotFather](https://t.me/BotFather) on Telegram
   - Use `/newbot` command and follow instructions
   - Copy the bot token and add it to your `.env` file

5. **Start the bot**
   ```bash
   npm start
   ```
   
   For development with auto-restart:
   ```bash
   npm run dev
   ```

## Usage Examples

### Adding a wallet to track
```
/add 0x1234567890abcdef1234567890abcdef12345678 MyTradingWallet
```

### Checking wallet status
```
/perpStatus 0x1234567890abcdef1234567890abcdef12345678
/spotStatus 0x1234567890abcdef1234567890abcdef12345678
```

### Removing a wallet
```
/remove 0x1234567890abcdef1234567890abcdef12345678
```

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Required | Your Telegram bot token from BotFather |
| `DATABASE_PATH` | `./hyperliquid_tracker.db` | SQLite database file path |
| `HYPERLIQUID_API_URL` | `https://api.hyperliquid.xyz` | Hyperliquid API endpoint |
| `POLLING_INTERVAL` | `10` | Seconds between order checks |
| `MAX_TRACKED_WALLETS_PER_USER` | `5` | Maximum wallets per user |

## How It Works

1. **User Registration**: When users start the bot, they're automatically registered in the database
2. **Wallet Tracking**: Users can add wallet addresses they want to monitor
3. **Order Monitoring**: The bot polls Hyperliquid API every X seconds for new activity
4. **Notifications**: When new orders/fills are detected, only users tracking that wallet get notified
5. **Deduplication**: The bot ensures the same order isn't notified multiple times

## Database Schema

The bot uses SQLite with three main tables:

- `users` - Stores Telegram user information
- `tracked_wallets` - Maps users to their tracked wallet addresses
- `processed_orders` - Prevents duplicate notifications

## API Integration

The bot integrates with Hyperliquid's API endpoints:

- `/info` with `type: 'userFills'` - Get user's filled orders
- `/info` with `type: 'openOrders'` - Get user's open orders
- `/info` with `type: 'orderHistory'` - Get user's order history
- `/info` with `type: 'userTwapSliceFills'` - Get user's TWAP slice fills
- `/info` with `type: 'clearinghouseState'` - Get user's portfolio

## Error Handling

- Graceful API error handling with retries
- Database connection management
- User-friendly error messages
- Comprehensive logging

## Security Considerations

- Each user can only see their own tracked wallets
- Database queries are parameterized to prevent SQL injection
- Rate limiting through configurable polling intervals
- Input validation for wallet addresses

## Deployment

### Using PM2 (Recommended for production)

1. Install PM2:
   ```bash
   npm install -g pm2
   ```

2. Start the bot:
   ```bash
   pm2 start bot.js --name "hyperliquid-tracker"
   ```

3. Save PM2 configuration:
   ```bash
   pm2 save
   pm2 startup
   ```

### Using Docker

Create a `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["npm", "start"]
```

Build and run:
```bash
docker build -t hyperliquid-tracker .
docker run -d --env-file .env hyperliquid-tracker
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

If you encounter any issues:

1. Check the console logs for error messages
2. Verify your `.env` configuration
3. Ensure your bot token is valid
4. Check that the Hyperliquid API is accessible

## Roadmap

- [ ] WebSocket integration for real-time updates
- [ ] Advanced filtering options
- [ ] Price alerts
- [ ] Portfolio analytics
- [ ] Multi-exchange support 