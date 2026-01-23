const cron = require('node-cron');
const emailService = require('./emailService');

const initScheduledJobs = (db) => {
    console.log('Initializing scheduled jobs...');

    // Daily Motivational Email at 10:00 AM
    cron.schedule('0 10 * * *', async () => {
        console.log('Running daily reminder email job...');
        try {
            // Get all 'student' role users
            // First get student role ID (assuming 3, but best to query)
            const [roles] = await db.query("SELECT id FROM roles WHERE name = 'student'");
            if (roles.length === 0) {
                console.error("Student role not found for scheduler.");
                return;
            }
            const studentRoleId = roles[0].id;

            const [students] = await db.query('SELECT name, email FROM users WHERE role_id = ?', [studentRoleId]);
            console.log(`Found ${students.length} students to notify.`);

            if (students.length > 0) {
                // Send in chunks to prevent blocking or rate limiting if list is huge
                // For now, simple loop is fine for moderate user base
                let count = 0;
                for (const student of students) {
                    if (student.email) {
                        try {
                            await emailService.sendDailyReminderEmail(student.email, student.name);
                            count++;
                            // Small delay to be nice to the mail server? Not strictly needed for small batches
                        } catch (err) {
                            console.error(`Failed to email ${student.email}:`, err.message);
                        }
                    }
                }
                console.log(`Daily emails sent to ${count} students.`);
            }
        } catch (error) {
            console.error('Error in daily reminder cron job:', error);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata" // Or 'UTC' depending on server preference. User implies "morning 11:57", assuming local time.
    });

    console.log('Scheduled jobs initialized.');
};

module.exports = { initScheduledJobs };
