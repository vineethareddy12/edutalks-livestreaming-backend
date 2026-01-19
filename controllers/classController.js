const { v4: uuidv4 } = require('uuid');
const emailService = require('../services/emailService');
const agoraService = require('../services/agoraService');

// Helper to convert ISO string to MySQL DATETIME format
const formatDateForMySQL = (dateStr) => {
    if (!dateStr) return null;
    try {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return null;
        // Format: YYYY-MM-DD HH:MM:SS
        return date.toISOString().slice(0, 19).replace('T', ' ');
    } catch (e) {
        return null;
    }
};

exports.createClass = async (req, res) => {
    const { title, description, start_time, duration, instructor_id, subject_id } = req.body;
    const db = req.app.locals.db;

    // Generate unique channel name for Agora
    const agora_channel = `class_${instructor_id}_${Date.now()}`;

    // Convert ISO datetime to MySQL format
    const mysqlStartTime = formatDateForMySQL(start_time);

    try {
        const [result] = await db.query(
            'INSERT INTO live_classes (title, description, start_time, duration, instructor_id, subject_id, agora_channel) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [title, description, mysqlStartTime, duration, instructor_id, subject_id || null, agora_channel]
        );

        // Notify Students and Instructor (Strictly Targeted)
        if (subject_id) {
            try {
                // 1. Get Subject and Instructor Info
                const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [subject_id]);
                const [instructors] = await db.query('SELECT name, email FROM users WHERE id = ?', [instructor_id]);

                if (subjects.length > 0 && instructors.length > 0) {
                    const subjectName = subjects[0].name;
                    const instructor = instructors[0];

                    // 2. Get Students assigned to this instructor's batch for this subject
                    const [students] = await db.query(`
                        SELECT u.name, u.email 
                        FROM users u
                        JOIN student_batches sb ON u.id = sb.student_id
                        JOIN batches b ON sb.batch_id = b.id
                        WHERE b.instructor_id = ? AND b.subject_id = ?
                    `, [instructor_id, subject_id]);

                    // 3. Send Emails to Students
                    for (const student of students) {
                        emailService.sendClassScheduledEmail(student.email, student.name, subjectName, start_time, instructor.name);
                    }

                    // 4. Send Confirmation to Instructor
                    const instructorSubject = `Class Scheduled: ${subjectName}`;
                    const instructorHtml = `
                        <h3>Class Scheduled Successfully!</h3>
                        <p>Your session for <b>${subjectName}</b> has been scheduled.</p>
                        <p><b>Time:</b> ${new Date(start_time).toLocaleString()}</p>
                        <p>Make sure to start the class on time from your dashboard.</p>
                    `;
                    emailService.sendEmail(instructor.email, instructorSubject, instructorHtml);
                }
            } catch (notifyErr) {
                console.error("Failed to notify students during scheduling:", notifyErr);
            }
        }

        if (req.app.locals.io) {
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'create' });
        }

        res.status(201).json({ message: 'Class scheduled successfully', agora_channel });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getCurriculumClasses = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const [classes] = await db.query('SELECT id, name FROM classes ORDER BY id');
        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error fetching curriculum' });
    }
};

exports.getSubjectsByClass = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { className } = req.params;

        // Handle URL encoding just in case, though express usually handles it
        const gradeName = decodeURIComponent(className);

        const [subjects] = await db.query(`
            SELECT s.id, s.name 
            FROM subjects s
            JOIN classes c ON s.class_id = c.id
            WHERE c.name = ?
            ORDER BY s.name ASC
        `, [gradeName]);

        res.json(subjects);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error fetching subjects' });
    }
};

exports.getInstructorClasses = async (req, res) => {
    const { instructorId } = req.params;
    const db = req.app.locals.db;
    try {
        const [classes] = await db.query(
            'SELECT * FROM live_classes WHERE instructor_id = ? ORDER BY start_time DESC',
            [instructorId]
        );
        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getAllClasses = async (req, res) => {
    try {
        const [classes] = await req.app.locals.db.query('SELECT * FROM live_classes ORDER BY start_time DESC');
        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getClassById = async (req, res) => {
    const { id } = req.params;
    try {
        const [classes] = await req.app.locals.db.query('SELECT * FROM live_classes WHERE id = ?', [id]);
        if (classes.length === 0) return res.status(404).json({ message: 'Class not found' });
        res.json(classes[0]);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
}

exports.getStudentClasses = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const studentId = req.user.id;

        // 1. Get Student's Grade
        const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [studentId]);
        if (users.length === 0) return res.status(404).json({ message: 'Student not found' });
        const grade = users[0].grade;

        // 2. Get Classes (Strictly Batch-Specific)
        const [classes] = await db.query(`
            SELECT DISTINCT lc.*, s.name as subject_name, u.name as instructor_name
            FROM live_classes lc
            JOIN batches b ON lc.instructor_id = b.instructor_id 
                AND (lc.subject_id = b.subject_id OR lc.subject_id IS NULL)
            JOIN student_batches sb ON b.id = sb.batch_id
            LEFT JOIN subjects s ON lc.subject_id = s.id
            JOIN users u ON lc.instructor_id = u.id
            WHERE sb.student_id = ?
            ORDER BY lc.start_time DESC
        `, [studentId]);

        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getJoinToken = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.user.id;
        const roleName = req.user.role; // Assuming role is in req.user
        const { id } = req.params; // live_class id

        // 1. Get Class Info
        const [classes] = await db.query('SELECT * FROM live_classes WHERE id = ?', [id]);
        if (classes.length === 0) return res.status(404).json({ message: 'Class not found' });
        const liveClass = classes[0];

        let role = 'subscriber';

        // 2. Authorization Check
        if (liveClass.status === 'completed') {
            return res.status(403).json({ message: 'This class has already ended.' });
        }

        if (roleName === 'instructor' || roleName === 'super_instructor') {
            if (liveClass.instructor_id !== userId) {
                return res.status(403).json({ message: 'Unauthorized: You are not the instructor of this class' });
            }
            role = 'publisher';
        } else if (roleName === 'student') {
            // Check if student is assigned to this instructor via batches
            const [assignment] = await db.query(`
                SELECT sb.student_id 
                FROM student_batches sb
                JOIN batches b ON sb.batch_id = b.id
                WHERE sb.student_id = ? AND b.instructor_id = ?
            `, [userId, liveClass.instructor_id]);

            if (assignment.length === 0) {
                // If not in a batch, maybe they are in the same grade (fallback or specific rule?)
                // User said "assigned students of that instructor", so the batch check is correct.
                return res.status(403).json({ message: 'Unauthorized: You are not assigned to this instructor' });
            }
        } else if (roleName === 'admin' || roleName === 'super_admin') {
            // Admins can join as subscribers to monitor
            role = 'subscriber';
        } else {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        // 3. Generate Token
        // uid should be a number for Agora buildTokenWithUid. 
        // If our IDs are strings/uuids, we might need a numeric mapping or use buildTokenWithUserAccount.
        // Let's check if IDs are numeric.
        const token = agoraService.generateToken(liveClass.agora_channel, userId, role);

        res.json({
            token,
            channelName: liveClass.agora_channel,
            uid: userId,
            role
        });

    } catch (err) {
        console.error("Error generating token:", err);
        res.status(500).json({ message: 'Server error generating token' });
    }
};

exports.startClass = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        const instructorId = req.user.id;

        // Verify instructor owns the class
        const [classes] = await db.query('SELECT * FROM live_classes WHERE id = ? AND instructor_id = ?', [id, instructorId]);
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });

        await db.query('UPDATE live_classes SET status = "live" WHERE id = ?', [id]);

        // Notify Students that class is starting
        const [liveClass] = await db.query('SELECT subject_id, title FROM live_classes WHERE id = ?', [id]);
        if (liveClass.length > 0 && liveClass[0].subject_id) {
            const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [liveClass[0].subject_id]);
            const [instructors] = await db.query('SELECT name FROM users WHERE id = ?', [instructorId]);

            const [students] = await db.query(`
                SELECT u.name, u.email 
                FROM users u
                JOIN student_batches sb ON u.id = sb.student_id
                JOIN batches b ON sb.batch_id = b.id
                WHERE b.instructor_id = ? AND b.subject_id = ?
            `, [instructorId, liveClass[0].subject_id]);

            for (const student of students) {
                emailService.sendClassStartedEmail(student.email, student.name, subjects[0]?.name || liveClass[0].title, instructors[0].name, id);
            }
        }

        // Emit Socket Event for real-time dashboard updates
        if (req.app.locals.io) {
            req.app.locals.io.emit('class_live', { classId: id, status: 'live' });
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'start', id });
        }

        res.json({ message: 'Class started' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
};

exports.endClass = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        const instructorId = req.user.id;

        // Verify instructor owns the class
        const [classes] = await db.query('SELECT * FROM live_classes WHERE id = ? AND instructor_id = ?', [id, instructorId]);
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });

        await db.query('UPDATE live_classes SET status = "completed" WHERE id = ?', [id]);

        // Emit Socket Event for real-time updates
        if (req.app.locals.io) {
            // Notify students in the room to redirect (using standardized room name)
            req.app.locals.io.to(`reg_class_${id}`).emit('class_ended', { classId: id });

            // Notify dashboards to refresh
            req.app.locals.io.emit('class_ended', { classId: id });
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'end', id });
        }

        res.json({ message: 'Class ended' });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
};


exports.startImmediateClass = async (req, res) => {
    const { title, subject_id } = req.body;
    const instructor_id = req.user.id;
    const db = req.app.locals.db;

    // Generate unique channel name for Agora
    const agora_channel = `class_${instructor_id}_${Date.now()}`;

    try {
        const [result] = await db.query(
            'INSERT INTO live_classes (title, description, start_time, duration, instructor_id, subject_id, agora_channel, status) VALUES (?, ?, NOW(), 60, ?, ?, ?, "live")',
            [title || 'Immediate Live Session', 'Quick session started from dashboard', instructor_id, subject_id || null, agora_channel]
        );

        const classId = result.insertId;

        // Notify Students logic (Strictly Targeted)
        if (subject_id) {
            try {
                const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [subject_id]);
                const [instructors] = await db.query('SELECT name FROM users WHERE id = ?', [instructor_id]);

                if (subjects.length > 0 && instructors.length > 0) {
                    const subjectName = subjects[0].name;
                    const instructorName = instructors[0].name;

                    const [students] = await db.query(`
                        SELECT u.name, u.email 
                        FROM users u
                        JOIN student_batches sb ON u.id = sb.student_id
                        JOIN batches b ON sb.batch_id = b.id
                        WHERE b.instructor_id = ? AND b.subject_id = ?
                    `, [instructor_id, subject_id]);

                    for (const student of students) {
                        emailService.sendClassStartedEmail(student.email, student.name, subjectName, instructorName, classId);
                    }
                }
            } catch (notifyErr) {
                console.error("Failed to notify students:", notifyErr);
            }
        }

        // Emit Socket Event for real-time dashboard updates
        if (req.app.locals.io) {
            req.app.locals.io.emit('class_live', { classId, status: 'live' });
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'start', id: classId });
        }

        res.status(201).json({
            message: 'Class started successfully',
            id: classId,
            agora_channel
        });
    } catch (err) {
        console.error("Error starting immediate class:", err);
        res.status(500).json({ message: 'Server error' });
    }
};
