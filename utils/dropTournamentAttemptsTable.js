// Script to drop tournament_attempts table to force recreation with correct schema
require('dotenv').config();
const mysql = require('mysql2/promise');

async function dropTable() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || 'root',
        database: process.env.DB_NAME || 'learnpulse',
        waitForConnections: true,
        connectionLimit: 10
    });

    try {
        console.log('Dropping tournament_attempts table...');
        await pool.query('DROP TABLE IF EXISTS tournament_attempts');
        console.log('✅ Table dropped successfully!');
        console.log('The table will be recreated with the correct schema when you restart the server.');
    } catch (err) {
        console.error('❌ Error dropping table:', err);
    } finally {
        await pool.end();
    }
}

dropTable();
