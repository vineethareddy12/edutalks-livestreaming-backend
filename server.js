const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const httpServer = createServer(app);

/* -------------------- CORS -------------------- */
const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:5173",
    "https://www.eduwallah.work.gd",
    "https://learnpulse-live.vercel.app"
].filter(Boolean);

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (!allowedOrigins.includes(origin)) {
            return callback(new Error('Not allowed by CORS'), false);
        }
        return callback(null, true);
    },
    credentials: true
};

/* -------------------- SOCKET -------------------- */
const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.locals.io = io;

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* -------------------- DB CONFIG -------------------- */
const dbDetails = {
    host: process.env.DB_HOST || process.env.MYSQLHOST,
    user: process.env.DB_USER || process.env.MYSQLUSER,
    password: process.env.DB_PASSWORD || process.env.MYSQLPASSWORD,
    database: process.env.DB_NAME || process.env.MYSQLDATABASE,
    port: process.env.DB_PORT || process.env.MYSQLPORT || 3306,
    timezone: '+00:00',
    ssl: {
        rejectUnauthorized: false
    },
    connectionLimit: 50,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
};

/* -------------------- ROUTES -------------------- */
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const classRoutes = require('./routes/classRoutes');
const noteRoutes = require('./routes/noteRoutes');
const examRoutes = require('./routes/examRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const batchRoutes = require('./routes/batchRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const adminRoutes = require('./routes/adminRoutes');
const superInstructorRoutes = require('./routes/superInstructorRoutes');
const instructorRoutes = require('./routes/instructorRoutes');
const studentRoutes = require('./routes/studentRoutes');
const doubtRoutes = require('./routes/doubtRoutes');

/* -------------------- DB SETUP -------------------- */
const { setup } = require('./utils/dbSetup');

/* -------------------- ROOM STATE -------------------- */
const roomStates = {};

const getRoomName = (classId, classType) => {
    if (!classId) return null;
    return classType === 'super'
        ? `si_class_${classId}`
        : `reg_class_${classId}`;
};

/* -------------------- SOCKET LOGIC -------------------- */
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_class', async (data) => {
        const { classId, userId, userName = 'Unknown', role = 'Student', classType = 'regular' } = data || {};
        
        // Standardize room names: regular_class_{id} or si_class_{id}
        const roomType = classType === 'super' || classType === 'si' ? 'si' : 'regular';
        const room = `${roomType}_class_${classId}`;
        
        if (!classId) return;

        await socket.join(room);
        
        // Store user data in socket for easy retrieval
        socket.userId = userId;
        socket.classId = classId;
        socket.classType = roomType;
        socket.userName = userName;
        socket.role = role;
        socket.data = { userId, userName, role, classId, classType: roomType, room };
        
        // Attendance logging
        const db = app.locals.db;
        try {
            if (db && userId) {
                const query = roomType === 'si'
                    ? 'INSERT INTO live_class_attendance (super_class_id, user_id, class_type) VALUES (?, ?, ?)'
                    : 'INSERT INTO live_class_attendance (class_id, user_id, class_type) VALUES (?, ?, ?)';
                await db.query(query, [classId, userId, roomType]);
            }
        } catch (err) {
            console.error("Attendance Error:", err);
        }

        console.log(`User ${userName} (${role}) joined room: ${room}`);

        // Notify others
        socket.to(room).emit('user_joined', { userId, userName, role });

        // Broadcast updated member list to everyone in the room
        const sockets = await io.in(room).fetchSockets();
        const members = sockets
            .filter(s => s.data && s.data.userId)
            .map(s => s.data);

        io.to(room).emit('current_users', members);

        // Sync room state (whiteboard, locks, etc.)
        if (roomStates[room]) {
            Object.entries(roomStates[room]).forEach(([key, value]) => {
                socket.emit(key, value);
            });
        }
    });

    socket.on('disconnect', async () => {
        const { userId, classId, classType, userName } = socket;
        if (!classId || !userId) return;

        const room = `${classType}_class_${classId}`;
        console.log(`User ${userName} disconnected from room: ${room}`);

        socket.to(room).emit('user_left', { userId });

        const sockets = await io.in(room).fetchSockets();
        const members = sockets
            .filter(s => s.data && s.data.userId)
            .map(s => s.data);

        io.to(room).emit('current_users', members);

        try {
            const db = app.locals.db;
            if (db) {
                const query = classType === 'si'
                    ? 'UPDATE live_class_attendance SET left_at = CURRENT_TIMESTAMP WHERE super_class_id = ? AND user_id = ? AND left_at IS NULL'
                    : 'UPDATE live_class_attendance SET left_at = CURRENT_TIMESTAMP WHERE class_id = ? AND user_id = ? AND left_at IS NULL';

                await db.query(query, [classId, userId]);
            }
        } catch (err) {
            console.error("Disconnect Update Error:", err);
        }
    });

    socket.on('send_message', (data) => {
        const room = `${socket.classType}_class_${socket.classId}`;
        if (room) io.to(room).emit('receive_message', data);
    });
});

/* -------------------- START SERVER -------------------- */
async function startServer() {
    try {
        const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;

        // Only run heavy database setup/seeding in development or if explicitly requested
        if (!isProduction || process.env.RUN_SETUP === 'true') {
            await setup();
            console.log('✓ Database setup complete');
        } else {
            console.log('✓ Production mode: Skipping heavy database setup');
        }

        const pool = mysql.createPool(dbDetails);
        app.locals.db = pool;

        const uploadDirs = ['uploads', 'uploads/notes', 'uploads/exams', 'uploads/doubts'];
        uploadDirs.forEach(dir => {
            const fullPath = path.join(__dirname, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        });

        app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

        app.use('/api/auth', authRoutes);
        app.use('/api/users', userRoutes);
        app.use('/api/classes', classRoutes);
        app.use('/api/notes', noteRoutes);
        app.use('/api/exams', examRoutes);
        app.use('/api/tournaments', tournamentRoutes);
        app.use('/api/payments', paymentRoutes);
        app.use('/api/batches', batchRoutes);
        app.use('/api/super-admin', superAdminRoutes);
        app.use('/api/admin', adminRoutes);
        app.use('/api/super-instructor', superInstructorRoutes);
        app.use('/api/instructor', instructorRoutes);
        app.use('/api/student', studentRoutes);
        app.use('/api/doubts', doubtRoutes);

        app.get('/', (req, res) => {
            res.send('LearnPulse API is running');
        });

        app.use((err, req, res, next) => {
            console.error(err.message);
            res.status(500).json({ error: err.message });
        });

        if (process.env.NODE_ENV !== 'production') {
            const PORT = process.env.PORT || 5000;
            httpServer.listen(PORT, () => {
                console.log(`🚀 Server running on port ${PORT}`);
            });
        }

    } catch (err) {
        console.error('❌ Server failed:', err);
        // Only exit in dev environment
        if (process.env.NODE_ENV !== 'production' || process.env.VERCEL) {
            console.log("Skipping process.exit in serverless environment");
        } else {
            process.exit(1);
        }
    }
}

startServer();

module.exports = app;
