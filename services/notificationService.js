const nodemailer = require('nodemailer');

// Configure email transporter
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

/**
 * Schedule notifications for a tournament
 * Called when tournament is created or updated
 */
async function scheduleNotifications(tournamentId, pool) {
    try {
        // Get tournament details
        const [tournaments] = await pool.query(
            'SELECT * FROM tournaments WHERE id = ?',
            [tournamentId]
        );

        if (tournaments.length === 0) {
            console.error('Tournament not found for notification scheduling');
            return;
        }

        const tournament = tournaments[0];

        // Get all registered students (or all students assigned to instructor if registration window hasn't started)
        let students = [];
        const now = new Date();
        const regStart = new Date(tournament.registration_start);

        if (now < regStart) {
            // Tournament just created - notify all students assigned to this instructor
            const [assignedStudents] = await pool.query(
                `SELECT DISTINCT u.id, u.email, u.name
                 FROM users u
                 INNER JOIN student_batches sb ON u.id = sb.student_id
                 INNER JOIN batches b ON sb.batch_id = b.id
                 WHERE b.instructor_id = ? AND u.role_id = (SELECT id FROM roles WHERE name = 'student')`,
                [tournament.instructor_id]
            );
            students = assignedStudents;
        } else {
            // Get registered students
            const [registeredStudents] = await pool.query(
                `SELECT u.id, u.email, u.name
                 FROM tournament_registrations tr
                 INNER JOIN users u ON tr.student_id = u.id
                 WHERE tr.tournament_id = ?`,
                [tournamentId]
            );
            students = registeredStudents;
        }

        if (students.length === 0) {
            console.log('No students to notify for tournament:', tournamentId);
            return;
        }

        const examStart = new Date(tournament.exam_start);
        const examEnd = new Date(tournament.exam_end);

        // Calculate notification times
        const reminder24h = new Date(examStart.getTime() - 24 * 60 * 60 * 1000);
        const reminder1h = new Date(examStart.getTime() - 60 * 60 * 1000);
        const exam10min = new Date(examEnd.getTime() - 10 * 60 * 1000);

        // Schedule notifications for each student
        for (const student of students) {
            // Announcement (immediate or at registration start)
            await pool.query(
                `INSERT INTO tournament_notifications 
                 (tournament_id, student_id, notification_type, title, message, scheduled_at)
                 VALUES (?, ?, 'ANNOUNCEMENT', ?, ?, ?)`,
                [
                    tournamentId,
                    student.id,
                    `New Tournament: ${tournament.name}`,
                    `A new tournament "${tournament.name}" has been created. Register now!`,
                    now < regStart ? regStart : now
                ]
            );

            // 24 hour reminder
            if (reminder24h > now) {
                await pool.query(
                    `INSERT INTO tournament_notifications 
                     (tournament_id, student_id, notification_type, title, message, scheduled_at)
                     VALUES (?, ?, 'REMINDER_24H', ?, ?, ?)`,
                    [
                        tournamentId,
                        student.id,
                        `Reminder: ${tournament.name} - 24 Hours`,
                        `Tournament "${tournament.name}" starts in 24 hours. Don't forget to register!`,
                        reminder24h
                    ]
                );
            }

            // 1 hour reminder
            if (reminder1h > now) {
                await pool.query(
                    `INSERT INTO tournament_notifications 
                     (tournament_id, student_id, notification_type, title, message, scheduled_at)
                     VALUES (?, ?, 'REMINDER_1H', ?, ?, ?)`,
                    [
                        tournamentId,
                        student.id,
                        `Reminder: ${tournament.name} - 1 Hour`,
                        `Tournament "${tournament.name}" starts in 1 hour. Get ready!`,
                        reminder1h
                    ]
                );
            }

            // Exam start notification
            await pool.query(
                `INSERT INTO tournament_notifications 
                 (tournament_id, student_id, notification_type, title, message, scheduled_at)
                 VALUES (?, ?, 'EXAM_START', ?, ?, ?)`,
                [
                    tournamentId,
                    student.id,
                    `${tournament.name} is LIVE NOW!`,
                    `Tournament "${tournament.name}" has started. Join now!`,
                    examStart
                ]
            );

            // 10 min warning (only for registered students)
            const [isRegistered] = await pool.query(
                'SELECT COUNT(*) as count FROM tournament_registrations WHERE tournament_id = ? AND student_id = ?',
                [tournamentId, student.id]
            );

            if (isRegistered[0].count > 0 && exam10min > now) {
                await pool.query(
                    `INSERT INTO tournament_notifications 
                     (tournament_id, student_id, notification_type, title, message, scheduled_at)
                     VALUES (?, ?, 'EXAM_10MIN', ?, ?, ?)`,
                    [
                        tournamentId,
                        student.id,
                        `Hurry Up! 10 Minutes Left`,
                        `Only 10 minutes remaining for "${tournament.name}". Finish your exam!`,
                        exam10min
                    ]
                );
            }
        }

        console.log(`✅ Notifications scheduled for tournament: ${tournament.name}`);
    } catch (error) {
        console.error('Error scheduling notifications:', error);
    }
}

/**
 * Send in-app notification
 */
async function sendInAppNotification(userId, title, message, pool) {
    try {
        // You can store these in a generic notifications table
        // For now, we'll just log it
        console.log(`📱 In-App Notification sent to user ${userId}: ${title}`);
        return true;
    } catch (error) {
        console.error('Error sending in-app notification:', error);
        return false;
    }
}

/**
 * Send email notification
 */
async function sendEmailNotification(email, subject, htmlContent) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: subject,
            html: htmlContent
        });
        console.log(`📧 Email sent to: ${email}`);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
}

/**
 * Send push notification (Firebase - placeholder)
 */
async function sendPushNotification(userId, title, body) {
    try {
        // TODO: Implement Firebase Cloud Messaging
        console.log(`🔔 Push notification would be sent to user ${userId}: ${title}`);
        return true;
    } catch (error) {
        console.error('Error sending push notification:', error);
        return false;
    }
}

/**
 * Process notification queue
 * This should be called periodically (every minute) via cron job
 */
async function processNotificationQueue(pool) {
    try {
        const now = new Date();

        // Get pending notifications
        const [notifications] = await pool.query(
            `SELECT tn.*, u.email, u.name
             FROM tournament_notifications tn
             INNER JOIN users u ON tn.student_id = u.id
             WHERE tn.scheduled_at <= ? 
               AND tn.in_app_sent = FALSE
             ORDER BY tn.scheduled_at ASC
             LIMIT 100`,
            [now]
        );

        for (const notification of notifications) {
            // Send in-app notification
            const inAppSent = await sendInAppNotification(
                notification.student_id,
                notification.title,
                notification.message,
                pool
            );

            // Send email if not sent
            let emailSent = notification.email_sent;
            if (!emailSent && notification.email) {
                const emailBody = `
                    <h2>${notification.title}</h2>
                    <p>Dear ${notification.name},</p>
                    <p>${notification.message}</p>
                    <br>
                    <p>Login to LearnPulse to view your tournaments.</p>
                    <p>Best regards,<br>LearnPulse Team</p>
                `;
                emailSent = await sendEmailNotification(
                    notification.email,
                    notification.title,
                    emailBody
                );
            }

            // Update notification status
            await pool.query(
                `UPDATE tournament_notifications 
                 SET in_app_sent = ?, email_sent = ?, sent_at = NOW()
                 WHERE id = ?`,
                [inAppSent, emailSent, notification.id]
            );
        }

        if (notifications.length > 0) {
            console.log(`✅ Processed ${notifications.length} notifications`);
        }
    } catch (error) {
        console.error('Error processing notification queue:', error);
    }
}

/**
 * Notify students about result publication
 */
async function notifyResultsPublished(tournamentId, pool) {
    try {
        const [tournament] = await pool.query(
            'SELECT * FROM tournaments WHERE id = ?',
            [tournamentId]
        );

        if (tournament.length === 0) return;

        const [students] = await pool.query(
            `SELECT DISTINCT u.id, u.email, u.name
             FROM tournament_registrations tr
             INNER JOIN users u ON tr.student_id = u.id
             WHERE tr.tournament_id = ?`,
            [tournamentId]
        );

        for (const student of students) {
            await pool.query(
                `INSERT INTO tournament_notifications 
                 (tournament_id, student_id, notification_type, title, message, scheduled_at)
                 VALUES (?, ?, 'RESULT_PUBLISHED', ?, ?, NOW())`,
                [
                    tournamentId,
                    student.id,
                    `Results Published: ${tournament[0].name}`,
                    `Results for "${tournament[0].name}" are now available. Check your rank and score!`
                ]
            );
        }

        console.log(`✅ Result notifications created for tournament: ${tournament[0].name}`);
    } catch (error) {
        console.error('Error notifying results published:', error);
    }
}

/**
 * Start notification processing service
 * Runs every minute
 */
function startNotificationService(pool) {
    console.log('🔔 Starting notification service...');

    // Process immediately
    processNotificationQueue(pool);

    // Then every minute
    setInterval(() => {
        processNotificationQueue(pool);
    }, 60 * 1000); // 60 seconds

    console.log('✅ Notification service started');
}

module.exports = {
    scheduleNotifications,
    sendInAppNotification,
    sendEmailNotification,
    sendPushNotification,
    processNotificationQueue,
    notifyResultsPublished,
    startNotificationService
};
