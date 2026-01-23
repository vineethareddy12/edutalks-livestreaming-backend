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
const allowedOrigins = [
    process.env.FRONTEND_URL,
    "http://localhost:5173", "https://www.eduwallah.work.gd"

].filter(Boolean);

const corsOptions = {
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
};

const io = new Server(httpServer, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Make socket.io available globally
app.locals.io = io;

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database Connection Pool
// Database Connection Pool
const dbDetails = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: '+00:00'
};

// Route Imports
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

// Auto-setup database and tables on startup
const { setup } = require('./utils/dbSetup');

async function startServer() {
    try {
        // 1. Initialize Database
        await setup();
        console.log('✓ Database and tables ready');

        // 2. Create Pool
        const pool = mysql.createPool(dbDetails);
        app.locals.db = pool;

        // 3. Initialize Services
        const { startReminderService } = require('./services/reminderService');
        startReminderService(pool);

        const { startNotificationService } = require('./services/notificationService');
        startNotificationService(pool);

        const { startStatusService } = require('./services/statusService');
        startStatusService(pool, io);

        const { initScheduledJobs } = require('./services/schedulerService');
        initScheduledJobs(pool);

        // 4. Configure Routes
        // Ensure upload directories exist
        const uploadDirs = ['uploads', 'uploads/notes', 'uploads/exams', 'uploads/doubts'];
        uploadDirs.forEach(dir => {
            const fullPath = path.join(__dirname, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
                console.log(`✓ Created directory: ${dir}`);
            }
        });

        // Serve uploaded files with absolute path for reliability
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

        // Default Route
        app.get('/', (req, res) => {
            res.send('EduTalks API is running');
        });

        // 5. Start Server
        const PORT = process.env.PORT || 5000;
        httpServer.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

// In-memory store for room-specific states (recording protection, etc.)
// In a production environment, this should ideally be in Redis or a DB
const roomStates = {};

// Helper to normalize room name based on class type
const getRoomName = (classId, classType) => {
    if (!classId) return null;
    return classType === 'super' ? `si_class_${classId}` : `reg_class_${classId}`;
};

// Socket.IO Logic
io.on('connection', (socket) => {
    // Accesses app.locals.db set in startServer
    console.log('User connected:', socket.id);

    socket.on('join_class', async (data) => {
        const classId = typeof data === 'object' ? data.classId : data;
        const userId = typeof data === 'object' ? data.userId : null;
        const classType = typeof data === 'object' ? data.classType : 'regular';
        const room = getRoomName(classId, classType);
        if (!room) return;

        socket.join(room);
        console.log(`[Socket] User ${socket.id} joined room: ${room} (${classType})`);

        if (userId) {
            try {
                const userName = typeof data === 'object' ? data.userName : 'Unknown';
                const role = typeof data === 'object' ? data.role : 'Student';
                const db = app.locals.db;
                if (db) {
                    if (classType === 'super') {
                        await db.query('INSERT INTO live_class_attendance (super_class_id, user_id, class_type) VALUES (?, ?, ?)', [classId, userId, 'super']);
                    } else {
                        await db.query('INSERT INTO live_class_attendance (class_id, user_id, class_type) VALUES (?, ?, ?)', [classId, userId, 'regular']);
                    }
                }
                socket.userId = userId;
                socket.classId = classId;
                socket.classType = classType;
                socket.userName = userName;
                socket.role = role;
                socket.to(room).emit('user_joined', { userId, userName, role });

                const socketsInRoom = await io.in(room).fetchSockets();
                const rawMembers = socketsInRoom.map(s => ({
                    userId: s.userId,
                    userName: s.userName,
                    role: s.role
                })).filter(u => u.userId);

                // Deduplicate by userId
                const members = Array.from(new Map(rawMembers.map(m => [m.userId, m])).values());

                io.to(room).emit('current_users', members);

                // Sync current states for the room to the new joiner
                if (roomStates[room]) {
                    const state = roomStates[room];
                    if (state.recordingProtected !== undefined) {
                        socket.emit('recording_protection_status', { active: state.recordingProtected });
                    }
                    if (state.whiteboardVisible !== undefined) {
                        socket.emit('whiteboard_visibility', { show: state.whiteboardVisible });
                    }
                    if (state.chatLocked !== undefined) {
                        socket.emit('chat_status', { locked: state.chatLocked });
                    }
                    if (state.audioLocked !== undefined) {
                        socket.emit('audio_status', { locked: state.audioLocked });
                    }
                    if (state.videoLocked !== undefined) {
                        socket.emit('video_status', { locked: state.videoLocked });
                    }
                    if (state.screenLocked !== undefined) {
                        socket.emit('screen_status', { locked: state.screenLocked });
                    }
                    if (state.screenSharing) {
                        // Sync active screen share to new user
                        socket.emit('screen_share_status', {
                            allowed: true,
                            studentId: state.screenSharerId
                        });
                    }
                }
            } catch (err) {
                console.error("Attendance Log Error:", err);
            }
        }
    });

    socket.on('disconnect', async () => {
        console.log('User disconnected:', socket.id);
        if (socket.userId && socket.classId) {
            const room = getRoomName(socket.classId, socket.classType);
            if (room) socket.to(room).emit('user_left', {
                userId: socket.userId,
                username: socket.userName,
                role: socket.role
            });

            // Refresh participant count for everyone remaining
            if (room) {
                const socketsInRoom = await io.in(room).fetchSockets();
                const rawMembers = socketsInRoom.map(s => ({
                    userId: s.userId,
                    userName: s.userName,
                    role: s.role
                })).filter(u => u.userId);

                // Deduplicate by userId
                const members = Array.from(new Map(rawMembers.map(m => [m.userId, m])).values());

                io.to(room).emit('current_users', members);
            }

            try {
                const db = app.locals.db;
                if (db) {
                    if (socket.classType === 'super') {
                        await db.query('UPDATE live_class_attendance SET left_at = CURRENT_TIMESTAMP WHERE super_class_id = ? AND user_id = ? AND left_at IS NULL', [socket.classId, socket.userId]);
                    } else {
                        await db.query('UPDATE live_class_attendance SET left_at = CURRENT_TIMESTAMP WHERE class_id = ? AND user_id = ? AND left_at IS NULL', [socket.classId, socket.userId]);
                    }
                }
            } catch (err) {
                console.error("Attendance Update Error on Disconnect:", err);
            }
        }
    });

    socket.on('send_message', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('receive_message', data);
    });

    socket.on('toggle_chat', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].chatLocked = data.locked;
        io.to(room).emit('chat_status', { locked: data.locked });
    });
    socket.on('toggle_audio', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].audioLocked = data.locked;
        io.to(room).emit('audio_status', { locked: data.locked });
    });
    socket.on('toggle_video', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].videoLocked = data.locked;
        io.to(room).emit('video_status', { locked: data.locked });
    });
    socket.on('raise_hand', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('hand_raised', data);
    });
    socket.on('lower_hand', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('hand_lowered', data);
    });
    socket.on('approve_hand', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('hand_approved', data);
    });
    socket.on('toggle_screen', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].screenLocked = data.locked;
        io.to(room).emit('screen_status', { locked: data.locked });
    });
    socket.on('toggle_whiteboard', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('whiteboard_status', { locked: data.locked });
    });
    socket.on('toggle_whiteboard_visibility', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].whiteboardVisible = data.show;
        io.to(room).emit('whiteboard_visibility', { show: data.show });
    });
    socket.on('toggle_recording_protection', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].recordingProtected = data.active;
        io.to(room).emit('recording_protection_status', { active: data.active });
    });
    socket.on('whiteboard_draw', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) socket.to(room).emit('whiteboard_draw', data);
    });
    socket.on('whiteboard_clear', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) socket.to(room).emit('whiteboard_clear');
    });
    socket.on('send_reaction', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('receive_reaction', data);
    });
    socket.on('share_screen', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) {
            if (!roomStates[room]) roomStates[room] = {};
            roomStates[room].screenSharing = data.allowed; // true or false
            roomStates[room].screenSharerId = data.allowed ? data.studentId : null;
            io.to(room).emit('screen_share_status', data);
        }
    });
    socket.on('request_screen_share', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('receive_screen_share_request', data);
    });
    socket.on('approve_screen_share', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('screen_share_approved', data);
    });
    socket.on('lower_all_hands', (classId) => {
        const room = getRoomName(classId, socket.classType);
        if (room) io.to(room).emit('all_hands_lowered');
    });
    socket.on('violation_report', (data) => {
        console.warn(`[Security] Violation detected: User ${data.studentName} (${data.studentId}) in Class ${data.classId} - Type: ${data.type}`);
        const room = getRoomName(data.classId, socket.classType);
        if (room) socket.to(room).emit('student_violation', data);
    });

    // --- Mute/Unmute Logic with Permission Tracking ---
    socket.on('admin_mute_student', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('force_mute_student', { studentId: data.studentId });
    });

    socket.on('admin_mute_all', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        io.to(room).emit('audio_status', { locked: true });
        socket.to(room).emit('force_mute_all');
    });

    socket.on('admin_grant_unmute', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('grant_unmute_permission', { studentId: data.studentId });
    });

    socket.on('admin_request_unmute', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('request_unmute_student', { studentId: data.studentId });
    });

    socket.on('admin_unlock_all', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        io.to(room).emit('audio_status', { locked: false });
        io.to(room).emit('unlock_all_mics');
    });

    // --- Screen Share Permission Logic ---
    socket.on('admin_stop_screen_share', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('force_stop_screen_share', { studentId: data.studentId });
    });

    socket.on('admin_stop_all_screen_shares', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        // Lock screen share globally
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].screenLocked = true;
        io.to(room).emit('screen_status', { locked: true });

        // Force stop for everyone
        socket.to(room).emit('force_stop_all_screen_share');
    });

    socket.on('admin_grant_screen_share', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (room) io.to(room).emit('grant_screen_share_permission', { studentId: data.studentId });
    });

    socket.on('admin_unlock_all_screen_shares', (data) => {
        const room = getRoomName(data.classId, socket.classType);
        if (!room) return;
        // Unlock screen share globally
        if (!roomStates[room]) roomStates[room] = {};
        roomStates[room].screenLocked = false;
        io.to(room).emit('screen_status', { locked: false });

        io.to(room).emit('unlock_all_screen_shares');
    });

});

startServer();