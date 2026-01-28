
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

exports.login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const [users] = await req.app.locals.db.query(
            'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE email = ?',
            [email]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: 'Email address not found. Please register or check your email.' });
        }

        const user = users[0];
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect password. Please try again.' });
        }

        // Check Active Status
        if (!user.is_active) {
            return res.status(403).json({ message: 'Account is pending approval. Please wait for an Admin to approve your request.' });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role_name },
            process.env.JWT_SECRET,
            { expiresIn: '1d' }
        );

        let assignedClass = null;
        if (user.role_name === 'super_instructor') {
            const [classRecord] = await req.app.locals.db.query(
                'SELECT c.id, c.name FROM class_super_instructors csi JOIN classes c ON csi.class_id = c.id WHERE csi.super_instructor_id = ?',
                [user.id]
            );

            if (classRecord.length > 0) {
                assignedClass = classRecord[0];
            } else if (user.grade) {
                // Fallback: Auto-assign if grade is set but link is missing
                try {
                    // Try exact, then fuzzy
                    let [classes] = await req.app.locals.db.query('SELECT id, name FROM classes WHERE name = ?', [user.grade]);
                    if (classes.length === 0) {
                        const cleanGrade = user.grade.replace(/Academic Ecosystem/gi, '').replace(/[^a-zA-Z0-9\s]/g, '').trim();
                        [classes] = await req.app.locals.db.query('SELECT id, name FROM classes WHERE name LIKE ? OR ? LIKE CONCAT(name, "%") LIMIT 1', [`%${cleanGrade}%`, user.grade]);
                    }

                    if (classes.length > 0) {
                        const classId = classes[0].id;
                        const finalClassName = classes[0].name;
                        await req.app.locals.db.query(
                            'INSERT INTO class_super_instructors (class_id, super_instructor_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE super_instructor_id = VALUES(super_instructor_id)',
                            [classId, user.id]
                        );
                        console.log(`Auto-assigned Super Instructor ${user.name} to class ${finalClassName} during login fallback (Grade: ${user.grade}).`);
                        assignedClass = { id: classId, name: finalClassName };
                    }
                } catch (assignErr) {
                    console.error("Failed to auto-assign Super Instructor during login fallback:", assignErr);
                }
            }
        }

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role_name,
                role_id: user.role_id,
                grade: user.grade,
                plan_name: user.plan_name,
                subscription_expires_at: user.subscription_expires_at,
                phone: user.phone,
                assignedClass
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

const BatchAllocationService = require('../services/batchAllocationService');
const emailService = require('../services/emailService');

exports.register = async (req, res) => {
    const { name, email, password, grade, phone, role } = req.body;
    try {
        // Check if user exists
        const [existing] = await req.app.locals.db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ message: 'An account with this email already exists. Please login instead.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Determine Role
        const roleMap = {
            'student': 'student',
            'instructor': 'instructor',
            'super_instructor': 'super_instructor',
            'admin': 'admin'
        };
        const requestedRole = roleMap[role] || 'student';

        // Get Role ID
        const [roles] = await req.app.locals.db.query('SELECT id FROM roles WHERE name = ?', [requestedRole]);
        if (roles.length === 0) return res.status(400).json({ message: 'The selected account role is invalid.' });
        const roleId = roles[0].id;

        // Determine Active Status
        const isActive = (requestedRole === 'student');

        // Auto-resolve selected_subject_id for UG/PG granular classes
        let resolvedSubjectId = null;
        if (grade && (grade.startsWith('UG -') || grade.startsWith('PG -'))) {
            const [subjectRows] = await req.app.locals.db.query('SELECT id FROM subjects WHERE grade = ? LIMIT 1', [grade]);
            if (subjectRows.length > 0) {
                resolvedSubjectId = subjectRows[0].id;
            }
        }

        const [userResult] = await req.app.locals.db.query(
            'INSERT INTO users (name, email, password, role_id, grade, phone, is_active, selected_subject_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, email, hashedPassword, roleId, grade || null, phone, isActive, resolvedSubjectId]
        );

        const newUserId = userResult.insertId;

        if (requestedRole === 'student') {
            // Send success response IMMEDIATELY
            res.status(201).json({ message: 'Student registered successfully' });

            // Run background tasks (Fire-and-Forget)
            // NOTE: Batch allocation is now handled ONLY after payment verification
            // See paymentController.verifyPayment for auto-allocation logic
            (async () => {
                try {
                    await emailService.sendStudentWelcomeEmail(email, name);
                } catch (emailErr) {
                    console.error("Student email sending failed (Background):", emailErr);
                }
            })();

        } else {
            // Send success response IMMEDIATELY
            res.status(201).json({ message: 'Account request submitted. Please wait for Admin approval. You can check your status by logging in.' });

            // Run background tasks (Fire-and-Forget)
            (async () => {
                try {
                    await emailService.sendRegistrationEmail(email, name, requestedRole);
                } catch (emailErr) {
                    console.error("Email sending failed (Background):", emailErr);
                }
            })();
        }

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error: ' + err.message });
    }
};

exports.getProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const [users] = await req.app.locals.db.query(
            'SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?',
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const user = users[0];

        let assignedClass = null;
        if (user.role_name === 'super_instructor') {
            const [classRecord] = await req.app.locals.db.query(
                'SELECT c.id, c.name FROM class_super_instructors csi JOIN classes c ON csi.class_id = c.id WHERE csi.super_instructor_id = ?',
                [user.id]
            );
            if (classRecord.length > 0) {
                assignedClass = classRecord[0];
            }
        }

        res.json({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role_name,
            role_id: user.role_id,
            grade: user.grade,
            plan_name: user.plan_name,
            subscription_expires_at: user.subscription_expires_at,
            phone: user.phone,
            assignedClass
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.forgotPassword = async (req, res) => {
    const { email } = req.body;
    try {
        const [users] = await req.app.locals.db.query('SELECT * FROM users WHERE email = ?', [email]);

        if (users.length === 0) {
            // Don't reveal if user exists or not (security best practice)
            return res.json({ message: 'If that email exists, a reset link has been sent.' });
        }

        const user = users[0];

        // Generate unique reset token
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpires = new Date(Date.now() + 3600000); // 1 hour from now

        // Store token in database
        await req.app.locals.db.query(
            'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
            [resetToken, resetTokenExpires, user.id]
        );

        // Send reset email
        await emailService.sendPasswordResetEmail(email, user.name, resetToken);

        res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.resetPassword = async (req, res) => {
    const { token, newPassword } = req.body;
    try {
        const [users] = await req.app.locals.db.query(
            'SELECT * FROM users WHERE reset_token = ? AND reset_token_expires > UTC_TIMESTAMP()',
            [token]
        );

        if (users.length === 0) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        const user = users[0];

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update password and clear reset token
        await req.app.locals.db.query(
            'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
            [hashedPassword, user.id]
        );

        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

