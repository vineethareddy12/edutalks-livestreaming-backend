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

exports.createSuperInstructorClass = async (req, res) => {
    const { title, description, start_time, duration, subject_id } = req.body;
    const super_instructor_id = req.user.id;
    const db = req.app.locals.db;

    try {
        // Get Super Instructor's grade
        const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [super_instructor_id]);
        if (users.length === 0) return res.status(404).json({ message: 'Super Instructor not found' });
        const grade = users[0].grade;

        // Generate unique channel name for Agora
        const agora_channel = `si_class_${super_instructor_id}_${Date.now()}`;

        // Convert ISO datetime to MySQL format
        const mysqlStartTime = formatDateForMySQL(start_time);

        const [result] = await db.query(
            'INSERT INTO super_instructor_classes (title, description, start_time, duration, super_instructor_id, subject_id, grade, agora_channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [title, description, mysqlStartTime, duration, super_instructor_id, subject_id || null, grade, agora_channel]
        );

        // Notify Students in the same grade
        if (subject_id) {
            try {
                const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [subject_id]);
                const [instructors] = await db.query('SELECT name, email FROM users WHERE id = ?', [super_instructor_id]);

                if (subjects.length > 0 && instructors.length > 0) {
                    const subjectName = subjects[0].name;
                    const instructor = instructors[0];

                    // Get all students in the same grade
                    const [students] = await db.query(`
                        SELECT name, email 
                        FROM users 
                        WHERE role_id = (SELECT id FROM roles WHERE name = 'student') 
                        AND grade = ?
                    `, [grade]);

                    // Send emails to students
                    for (const student of students) {
                        emailService.sendClassScheduledEmail(student.email, student.name, subjectName, start_time, instructor.name);
                    }

                    // Send confirmation to Super Instructor
                    const instructorSubject = `Class Scheduled: ${subjectName} for Grade ${grade}`;
                    const instructorHtml = `
                        <h3>Class Scheduled Successfully!</h3>
                        <p>Your session for <b>${subjectName}</b> (Grade ${grade}) has been scheduled.</p>
                        <p><b>Time:</b> ${new Date(start_time).toLocaleString()}</p>
                        <p>All students in Grade ${grade} will be notified.</p>
                    `;
                    emailService.sendEmail(instructor.email, instructorSubject, instructorHtml);
                }
            } catch (notifyErr) {
                console.error("Failed to notify students during scheduling:", notifyErr);
            }
        }

        // Emit global sync event
        if (req.app.locals.io) {
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'create' });
        }

        res.status(201).json({ message: 'Class scheduled successfully', agora_channel });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getSuperInstructorClasses = async (req, res) => {
    const super_instructor_id = req.user.id;
    const db = req.app.locals.db;

    try {
        const [classes] = await db.query(
            `SELECT sic.*, s.name as subject_name 
             FROM super_instructor_classes sic
             LEFT JOIN subjects s ON sic.subject_id = s.id
             WHERE sic.super_instructor_id = ? 
             ORDER BY sic.start_time DESC`,
            [super_instructor_id]
        );
        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getStudentSuperInstructorClasses = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const studentId = req.user.id;

        // Get Student's Grade & Selected Subject
        const [users] = await db.query('SELECT grade, selected_subject_id FROM users WHERE id = ?', [studentId]);
        if (users.length === 0) return res.status(404).json({ message: 'Student not found' });

        const { grade, selected_subject_id } = users[0];

        // Query Builder
        let query = `
            SELECT sic.*, s.name as subject_name, u.name as instructor_name
            FROM super_instructor_classes sic
            LEFT JOIN subjects s ON sic.subject_id = s.id
            JOIN users u ON sic.super_instructor_id = u.id
            WHERE sic.grade = ?
        `;

        const params = [grade];

        // Specific filtering for UG/PG or if a subject is selected
        if (selected_subject_id) {
            query += ` AND (sic.subject_id IS NULL OR sic.subject_id = ?)`;
            params.push(selected_subject_id);
        }

        query += ` ORDER BY sic.start_time DESC`;

        const [classes] = await db.query(query, params);

        res.json(classes);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getClassById = async (req, res) => {
    const { id } = req.params;
    try {
        const [classes] = await req.app.locals.db.query(
            'SELECT * FROM super_instructor_classes WHERE id = ?',
            [id]
        );
        if (classes.length === 0) return res.status(404).json({ message: 'Class not found' });
        res.json(classes[0]);
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getJoinToken = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const userId = req.user.id;
        const roleName = req.user.role;
        const { id } = req.params; // super_instructor_class id

        // Get Class Info
        const [classes] = await db.query('SELECT * FROM super_instructor_classes WHERE id = ?', [id]);
        if (classes.length === 0) return res.status(404).json({ message: 'Class not found' });
        const liveClass = classes[0];

        let role = 'subscriber';

        // Authorization Check
        if (liveClass.status === 'completed') {
            return res.status(403).json({ message: 'This class has already ended.' });
        }

        if (roleName === 'super_instructor') {
            if (liveClass.super_instructor_id !== userId) {
                return res.status(403).json({ message: 'Unauthorized: You are not the instructor of this class' });
            }
            role = 'publisher';
        } else if (roleName === 'student') {
            // Check if student is in the same grade
            const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [userId]);
            if (users.length === 0 || users[0].grade !== liveClass.grade) {
                return res.status(403).json({ message: 'Unauthorized: This class is not for your grade' });
            }
        } else if (roleName === 'admin' || roleName === 'super_admin') {
            // Admins can join as subscribers to monitor
            role = 'subscriber';
        } else {
            return res.status(403).json({ message: 'Unauthorized' });
        }

        // Generate Token
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
        const superInstructorId = req.user.id;

        // Verify super instructor owns the class
        const [classes] = await db.query(
            'SELECT * FROM super_instructor_classes WHERE id = ? AND super_instructor_id = ?',
            [id, superInstructorId]
        );
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });

        await db.query('UPDATE super_instructor_classes SET status = "live" WHERE id = ?', [id]);

        // Notify Students that class is starting
        const [liveClass] = await db.query(
            'SELECT subject_id, title, grade FROM super_instructor_classes WHERE id = ?',
            [id]
        );

        if (liveClass.length > 0) {
            const grade = liveClass[0].grade;
            const [instructors] = await db.query('SELECT name FROM users WHERE id = ?', [superInstructorId]);

            let subjectName = liveClass[0].title;
            if (liveClass[0].subject_id) {
                const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [liveClass[0].subject_id]);
                if (subjects.length > 0) subjectName = subjects[0].name;
            }

            // Get all students in the same grade
            const [students] = await db.query(`
                SELECT name, email 
                FROM users 
                WHERE role_id = (SELECT id FROM roles WHERE name = 'student') 
                AND grade = ?
            `, [grade]);

            for (const student of students) {
                emailService.sendClassStartedEmail(
                    student.email,
                    student.name,
                    subjectName,
                    instructors[0].name,
                    id
                );
            }
        }

        // Emit Socket Event for real-time dashboard updates
        if (req.app.locals.io) {
            req.app.locals.io.emit('si_class_live', { classId: id, status: 'live' });
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'start', id });
        }

        res.json({ message: 'Class started' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.endClass = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { id } = req.params;
        const superInstructorId = req.user.id;

        // Verify super instructor owns the class
        const [classes] = await db.query(
            'SELECT * FROM super_instructor_classes WHERE id = ? AND super_instructor_id = ?',
            [id, superInstructorId]
        );
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });

        await db.query('UPDATE super_instructor_classes SET status = "completed" WHERE id = ?', [id]);

        // Emit Socket Event for real-time updates
        if (req.app.locals.io) {
            // Notify students in the room to redirect
            req.app.locals.io.to(`si_class_${id}`).emit('si_class_ended', { classId: id });
            // Notify dashboards to refresh
            req.app.locals.io.emit('si_class_ended', { classId: id });
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'end', id });
        }

        res.json({ message: 'Class ended' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.startImmediateClass = async (req, res) => {
    const { title, subject_id } = req.body;
    const super_instructor_id = req.user.id;
    const db = req.app.locals.db;

    try {
        // Get Super Instructor's grade
        const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [super_instructor_id]);
        if (users.length === 0) return res.status(404).json({ message: 'Super Instructor not found' });
        const grade = users[0].grade;

        // Generate unique channel name for Agora
        const agora_channel = `si_class_${super_instructor_id}_${Date.now()}`;

        const [result] = await db.query(
            'INSERT INTO super_instructor_classes (title, description, start_time, duration, super_instructor_id, subject_id, grade, agora_channel, status) VALUES (?, ?, NOW(), 60, ?, ?, ?, ?, "live")',
            [title || 'Immediate Live Session', 'Quick session started from dashboard', super_instructor_id, subject_id || null, grade, agora_channel]
        );

        const classId = result.insertId;

        // Notify Students
        if (subject_id) {
            try {
                const [subjects] = await db.query('SELECT name FROM subjects WHERE id = ?', [subject_id]);
                const [instructors] = await db.query('SELECT name FROM users WHERE id = ?', [super_instructor_id]);

                if (subjects.length > 0 && instructors.length > 0) {
                    const subjectName = subjects[0].name;
                    const instructorName = instructors[0].name;

                    const [students] = await db.query(`
                        SELECT name, email 
                        FROM users 
                        WHERE role_id = (SELECT id FROM roles WHERE name = 'student') 
                        AND grade = ?
                    `, [grade]);

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
            req.app.locals.io.emit('si_class_live', { classId, status: 'live' });
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

exports.updateClass = async (req, res) => {
    const { id } = req.params;
    const { title, description, start_time, duration, subject_id } = req.body;
    const super_instructor_id = req.user.id;
    const db = req.app.locals.db;

    try {
        // Verify ownership
        const [classes] = await db.query(
            'SELECT * FROM super_instructor_classes WHERE id = ? AND super_instructor_id = ?',
            [id, super_instructor_id]
        );
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });

        // Convert ISO datetime to MySQL format
        const mysqlStartTime = formatDateForMySQL(start_time);

        await db.query(
            'UPDATE super_instructor_classes SET title = ?, description = ?, start_time = ?, duration = ?, subject_id = ? WHERE id = ?',
            [title, description, mysqlStartTime, duration, subject_id || null, id]
        );

        if (req.app.locals.io) {
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'update', id: id });
        }

        res.json({ message: 'Class updated successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.deleteClass = async (req, res) => {
    const { id } = req.params;
    const super_instructor_id = req.user.id;
    const db = req.app.locals.db;

    try {
        // Verify ownership and that class is not live
        const [classes] = await db.query(
            'SELECT * FROM super_instructor_classes WHERE id = ? AND super_instructor_id = ?',
            [id, super_instructor_id]
        );
        if (classes.length === 0) return res.status(403).json({ message: 'Unauthorized' });
        if (classes[0].status === 'live') return res.status(400).json({ message: 'Cannot delete a live class' });

        await db.query('DELETE FROM super_instructor_classes WHERE id = ?', [id]);

        if (req.app.locals.io) {
            req.app.locals.io.emit('global_sync', { type: 'classes', action: 'delete', id: id });
        }

        res.json({ message: 'Class deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};
