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

    close() {
        this.db.close();
    }
}

module.exports = Database; 