const mysql = require('mysql2/promise');
require('dotenv').config();
const { SchemaManager } = require('../services/schemaManager');
const { AdminSeeder } = require('./adminSeeder');

const dbConfig = {
    host: process.env.DB_HOST || process.env.MYSQLHOST,
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
    multipleStatements: true,
    ssl: {
        rejectUnauthorized: false
    }
};

async function setup() {
    let connection;
    try {
        // 1. Connectivity Check & Database Creation (if needed)
        // Note: Ideally SchemaManager uses a pool, but for initial setup we might need a raw connection
        // to create the DB if it doesn't exist.

        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
        });

        await connection.query(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME}`);
        await connection.end();

        // 2. Initialize Pool for Schema Manager
        const pool = mysql.createPool({
            ...dbConfig,
            database: process.env.DB_NAME
        });

        // 3. Sync Schemas
        const schemaManager = new SchemaManager(pool);
        await schemaManager.sync();

        // 3.5 Seed Roles (Crucial)
        const roles = ['super_admin', 'admin', 'super_instructor', 'instructor', 'student'];
        for (const role of roles) {
            await pool.query("INSERT IGNORE INTO roles (name) VALUES (?)", [role]);
        }
        console.log('✅ Roles verified/seeded.');

        // 4. Seed Super Admin
        const adminSeeder = new AdminSeeder(pool);
        await adminSeeder.seed();

        // 5. Seed Comprehensive Curriculum (Existing logic)
        // We create a temporary connection or pass the pool if seedCurriculum supports it.
        // Looking at seedCurriculum usage in previous file, it expected a connection.
        // Let's create a fresh connection for it or refactor it.
        // For minimal breakage, let's create a connection.
        const dbConnection = await mysql.createConnection({
            ...dbConfig,
            database: process.env.DB_NAME
        });

        try {
            const { seedCurriculum } = require('./seedCurriculum');
            await seedCurriculum(dbConnection);
        } catch (err) {
            console.error("Curriculum Seeding Error:", err);
        } finally {
            await dbConnection.end();
        }

        // 6. Seed Tournament Levels
        try {
            const { seedTournamentLevels } = require('./seedTournamentLevels');
            await seedTournamentLevels(pool);
        } catch (err) {
            console.error("Tournament Levels Seeding Error:", err);
        }

        console.log('🚀 Database initialization complete.');
        // We don't close the pool here because this script might be required by server.js which uses its own pool.
        // But if this is run as standalone script, we should exit.
        await pool.end();

    } catch (error) {
        console.error('❌ Error in database setup:', error);
        if (process.env.NODE_ENV !== 'production') {
            process.exit(1);
        }
    }
}

module.exports = { setup };

if (require.main === module) {
    setup();
}
