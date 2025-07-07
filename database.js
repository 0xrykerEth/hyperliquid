const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

class Database {
    constructor() {
        this.db = new sqlite3.Database(config.DATABASE_PATH);
        this.init();
    }

    init() {

        this.db.serialize(() => {

            this.db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telegram_id INTEGER UNIQUE NOT NULL,
                    username TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT 1
                )
            `);

            this.db.run(`
                CREATE TABLE IF NOT EXISTS tracked_wallets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    wallet_address TEXT NOT NULL,
                    nickname TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT 1,
                    FOREIGN KEY (user_id) REFERENCES users (id),
                    UNIQUE(user_id, wallet_address)
                )
            `);

            this.db.run(`
                CREATE TABLE IF NOT EXISTS processed_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wallet_address TEXT NOT NULL,
                    order_id TEXT NOT NULL,
                    order_hash TEXT,
                    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(wallet_address, order_id)
                )
            `);

            // HyperEVM wallet tracking tables
            this.db.run(`
                CREATE TABLE IF NOT EXISTS tracked_evm_wallets (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    wallet_address TEXT NOT NULL,
                    nickname TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT 1,
                    FOREIGN KEY (user_id) REFERENCES users (id),
                    UNIQUE(user_id, wallet_address)
                )
            `);

            this.db.run(`
                CREATE TABLE IF NOT EXISTS processed_evm_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wallet_address TEXT NOT NULL,
                    transaction_hash TEXT NOT NULL,
                    block_number INTEGER,
                    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(wallet_address, transaction_hash)
                )
            `);
        });
    }

    async addUser(telegramId, username = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO users (telegram_id, username) VALUES (?, ?)`,
                [telegramId, username],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async getUser(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM users WHERE telegram_id = ?`,
                [telegramId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async addTrackedWallet(telegramId, walletAddress, nickname = null) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT id FROM users WHERE telegram_id = ?`,
                [telegramId],
                (err, user) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (!user) {
                        reject(new Error('User not found'));
                        return;
                    }

                    this.db.get(
                        `SELECT COUNT(*) as count FROM tracked_wallets WHERE user_id = ? AND is_active = 1`,
                        [user.id],
                        (err, result) => {
                            if (err) {
                                reject(err);
                                return;
                            }

                            if (result.count >= config.MAX_TRACKED_WALLETS_PER_USER) {
                                reject(new Error(`Maximum ${config.MAX_TRACKED_WALLETS_PER_USER} wallets allowed per user`));
                                return;
                            }

                            this.db.run(
                                `INSERT OR REPLACE INTO tracked_wallets (user_id, wallet_address, nickname) VALUES (?, ?, ?)`,
                                [user.id, walletAddress, nickname],
                                function(err) {
                                    if (err) reject(err);
                                    else resolve(this.lastID);
                                }
                            );
                        }
                    );
                }
            );
        });
    }

    async removeTrackedWallet(telegramId, walletAddress) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE tracked_wallets 
                 SET is_active = 0 
                 WHERE user_id = (SELECT id FROM users WHERE telegram_id = ?) 
                 AND wallet_address = ?`,
                [telegramId, walletAddress],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    async getUserTrackedWallets(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT tw.wallet_address, tw.nickname, tw.created_at
                 FROM tracked_wallets tw
                 JOIN users u ON tw.user_id = u.id
                 WHERE u.telegram_id = ? AND tw.is_active = 1`,
                [telegramId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async getAllTrackedWallets() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT DISTINCT wallet_address FROM tracked_wallets WHERE is_active = 1`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(row => row.wallet_address));
                }
            );
        });
    }

    async getUsersTrackingWallet(walletAddress) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT u.telegram_id, tw.nickname
                 FROM users u
                 JOIN tracked_wallets tw ON u.id = tw.user_id
                 WHERE tw.wallet_address = ? AND tw.is_active = 1 AND u.is_active = 1`,
                [walletAddress],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async markOrderProcessed(walletAddress, orderId, orderHash = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO processed_orders (wallet_address, order_id, order_hash) VALUES (?, ?, ?)`,
                [walletAddress, orderId, orderHash],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async isOrderProcessed(walletAddress, orderId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT id FROM processed_orders WHERE wallet_address = ? AND order_id = ?`,
                [walletAddress, orderId],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    }

    async getAllUsers() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT telegram_id FROM users WHERE is_active = 1`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async getUserStatistics() {
        return new Promise((resolve, reject) => {
            const stats = {};
            
            // Get total user count
            this.db.get(
                `SELECT COUNT(*) as total_users FROM users WHERE is_active = 1`,
                (err, row) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    stats.totalUsers = row.total_users;
                    
                    // Get users who joined in last 24 hours
                    this.db.get(
                        `SELECT COUNT(*) as new_users FROM users 
                         WHERE is_active = 1 AND created_at >= datetime('now', '-1 day')`,
                        (err, row) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            stats.newUsersToday = row.new_users;
                            
                            // Get users who joined in last 7 days
                            this.db.get(
                                `SELECT COUNT(*) as new_users_week FROM users 
                                 WHERE is_active = 1 AND created_at >= datetime('now', '-7 days')`,
                                (err, row) => {
                                    if (err) {
                                        reject(err);
                                        return;
                                    }
                                    stats.newUsersThisWeek = row.new_users_week;
                                    
                                    // Get total tracked wallets
                                    this.db.get(
                                        `SELECT COUNT(*) as total_wallets FROM tracked_wallets WHERE is_active = 1`,
                                        (err, row) => {
                                            if (err) {
                                                reject(err);
                                                return;
                                            }
                                            stats.totalTrackedWallets = row.total_wallets;
                                            
                                            // Get unique tracked wallets
                                            this.db.get(
                                                `SELECT COUNT(DISTINCT wallet_address) as unique_wallets 
                                                 FROM tracked_wallets WHERE is_active = 1`,
                                                (err, row) => {
                                                    if (err) {
                                                        reject(err);
                                                        return;
                                                    }
                                                    stats.uniqueTrackedWallets = row.unique_wallets;
                                                    
                                                    // Get average wallets per user
                                                    this.db.get(
                                                        `SELECT 
                                                            ROUND(CAST(COUNT(*) AS FLOAT) / COUNT(DISTINCT user_id), 2) as avg_wallets_per_user
                                                         FROM tracked_wallets WHERE is_active = 1`,
                                                        (err, row) => {
                                                            if (err) {
                                                                reject(err);
                                                                return;
                                                            }
                                                            stats.avgWalletsPerUser = row.avg_wallets_per_user || 0;
                                                            
                                                            // Get processed orders count (activity indicator)
                                                            this.db.get(
                                                                `SELECT COUNT(*) as total_orders_processed 
                                                                 FROM processed_orders 
                                                                 WHERE processed_at >= datetime('now', '-1 day')`,
                                                                (err, row) => {
                                                                    if (err) {
                                                                        reject(err);
                                                                        return;
                                                                    }
                                                                    stats.ordersProcessedToday = row.total_orders_processed;
                                                                    resolve(stats);
                                                                }
                                                            );
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        });
    }

    // HyperEVM wallet tracking methods
    async addTrackedEvmWallet(telegramId, walletAddress, nickname = null) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT id FROM users WHERE telegram_id = ?`,
                [telegramId],
                (err, user) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    if (!user) {
                        reject(new Error('User not found'));
                        return;
                    }

                    this.db.get(
                        `SELECT COUNT(*) as count FROM tracked_evm_wallets WHERE user_id = ? AND is_active = 1`,
                        [user.id],
                        (err, result) => {
                            if (err) {
                                reject(err);
                                return;
                            }

                            if (result.count >= config.MAX_TRACKED_WALLETS_PER_USER) {
                                reject(new Error(`Maximum ${config.MAX_TRACKED_WALLETS_PER_USER} EVM wallets allowed per user`));
                                return;
                            }

                            this.db.run(
                                `INSERT OR REPLACE INTO tracked_evm_wallets (user_id, wallet_address, nickname) VALUES (?, ?, ?)`,
                                [user.id, walletAddress, nickname],
                                function(err) {
                                    if (err) reject(err);
                                    else resolve(this.lastID);
                                }
                            );
                        }
                    );
                }
            );
        });
    }

    async removeTrackedEvmWallet(telegramId, walletAddress) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE tracked_evm_wallets 
                 SET is_active = 0 
                 WHERE user_id = (SELECT id FROM users WHERE telegram_id = ?) 
                 AND wallet_address = ?`,
                [telegramId, walletAddress],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes > 0);
                }
            );
        });
    }

    async getUserTrackedEvmWallets(telegramId) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT tew.wallet_address, tew.nickname, tew.created_at
                 FROM tracked_evm_wallets tew
                 JOIN users u ON tew.user_id = u.id
                 WHERE u.telegram_id = ? AND tew.is_active = 1`,
                [telegramId],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async getAllTrackedEvmWallets() {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT DISTINCT wallet_address FROM tracked_evm_wallets WHERE is_active = 1`,
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows.map(row => row.wallet_address));
                }
            );
        });
    }

    async getUsersTrackingEvmWallet(walletAddress) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT u.telegram_id, tew.nickname
                 FROM users u
                 JOIN tracked_evm_wallets tew ON u.id = tew.user_id
                 WHERE tew.wallet_address = ? AND tew.is_active = 1 AND u.is_active = 1`,
                [walletAddress],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                }
            );
        });
    }

    async markEvmTransactionProcessed(walletAddress, transactionHash, blockNumber = null) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT OR IGNORE INTO processed_evm_transactions (wallet_address, transaction_hash, block_number) VALUES (?, ?, ?)`,
                [walletAddress, transactionHash, blockNumber],
                function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                }
            );
        });
    }

    async isEvmTransactionProcessed(walletAddress, transactionHash) {
        return new Promise((resolve, reject) => {
            this.db.get(
                `SELECT * FROM processed_evm_transactions WHERE wallet_address = ? AND transaction_hash = ?`,
                [walletAddress, transactionHash],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(!!row);
                }
            );
        });
    }

    close() {
        this.db.close();
    }
}

module.exports = Database; 