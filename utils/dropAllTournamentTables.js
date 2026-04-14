// Script to drop all tournament-related tables to force recreation with correct schema
require('dotenv').config();
const mysql = require('mysql2/promise');

async function dropTables() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: process.env.DB_NAME || 'learnpulse',
        waitForConnections: true,
        connectionLimit: 10
    });

    try {
        console.log('Dropping tournament tables...');
        await pool.query('SET FOREIGN_KEY_CHECKS = 0');

        const tables = [
            'tournament_notifications',
            'tournament_attempts',
            'tournament_registrations',
            'tournaments'
        ];

        for (const table of tables) {
            await pool.query(`DROP TABLE IF EXISTS ${table}`);
            console.log(`✅ Table ${table} dropped.`);
        }

        await pool.query('SET FOREIGN_KEY_CHECKS = 1');
        console.log('✅ All tournament tables dropped successfully!');
    } catch (err) {
        console.error('❌ Error dropping tables:', err);
    } finally {
        await pool.end();
    }
}

dropTables();
