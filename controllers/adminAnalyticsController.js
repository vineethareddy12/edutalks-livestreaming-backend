// Dashboard Summary - Quick stats for top cards
const getDashboardSummary = async (req, res) => {
    try {
        const db = req.app.locals.db;

        // Parallel queries for better performance
        const [classesResult] = await db.query('SELECT COUNT(*) as total FROM classes');
        const [instructorsResult] = await db.query(`
            SELECT COUNT(*) as total FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE r.name IN ('instructor', 'super_instructor') AND u.is_active = 1
        `);
        const [studentsResult] = await db.query(`
            SELECT COUNT(*) as total FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE r.name = 'student' AND u.is_active = 1
        `);
        const [paidStudentsResult] = await db.query(`
            SELECT COUNT(*) as total FROM users u
            JOIN roles r ON u.role_id = r.id
            WHERE r.name = 'student' AND u.is_active = 1 AND u.plan_name != 'Free'
        `);
        const [revenueResult] = await db.query(
            'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = "completed"'
        );

        const totalStudents = studentsResult[0].total;
        const paidStudents = paidStudentsResult[0].total;

        res.json({
            total_classes: classesResult[0].total,
            total_instructors: instructorsResult[0].total,
            total_students: totalStudents,
            paid_students: paidStudents,
            unpaid_students: totalStudents - paidStudents,
            total_revenue: revenueResult[0].total
        });
    } catch (error) {
        console.error('[getDashboardSummary] Error:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard summary' });
    }
};

// Class Assignments - All classes with instructor details
const getClassAssignments = async (req, res) => {
    try {
        const db = req.app.locals.db;

        const query = `
            SELECT 
                c.id as class_id,
                c.name as class_name,
                COUNT(DISTINCT u.id) as instructor_count,
                JSON_ARRAYAGG(
                    JSON_OBJECT(
                        'id', u.id,
                        'name', u.name,
                        'email', u.email,
                        'subject', s.name
                    )
                ) as instructors
            FROM classes c
            LEFT JOIN users u ON u.grade = c.name 
            LEFT JOIN roles r ON u.role_id = r.id
            LEFT JOIN subjects s ON u.selected_subject_id = s.id
            WHERE (r.name IN ('instructor', 'super_instructor') AND u.is_active = 1) OR u.id IS NULL
            GROUP BY c.id, c.name
            ORDER BY c.name
        `;

        const [results] = await db.query(query);

        // Clean up null instructors
        const classes = results.map(row => ({
            ...row,
            instructors: row.instructors ? row.instructors.filter(i => i.id !== null) : []
        }));

        res.json({ classes });
    } catch (error) {
        console.error('[getClassAssignments] Error:', error);
        res.status(500).json({ error: 'Failed to fetch class assignments' });
    }
};

// Student Enrollment - Students per course/class with payment breakdown
const getStudentEnrollment = async (req, res) => {
    try {
        const db = req.app.locals.db;

        const query = `
            SELECT 
                c.name as class_name,
                s.name as course_name,
                COUNT(u.id) as total_students,
                SUM(CASE WHEN u.plan_name != 'Free' THEN 1 ELSE 0 END) as paid_students,
                SUM(CASE WHEN u.plan_name = 'Free' OR u.plan_name IS NULL THEN 1 ELSE 0 END) as unpaid_students
            FROM classes c
            LEFT JOIN users u ON u.grade = c.name
            LEFT JOIN roles r ON u.role_id = r.id
            LEFT JOIN subjects s ON u.selected_subject_id = s.id
            WHERE (r.name = 'student' AND u.is_active = 1) OR u.id IS NULL
            GROUP BY c.name, s.name
            HAVING COUNT(u.id) > 0
            ORDER BY c.name, s.name
        `;

        const [results] = await db.query(query);
        res.json({ enrollment: results });
    } catch (error) {
        console.error('[getStudentEnrollment] Error:', error);
        res.status(500).json({ error: 'Failed to fetch student enrollment' });
    }
};

// Payment Details - Complete student payment information
const getPaymentDetails = async (req, res) => {
    try {
        const db = req.app.locals.db;
        const { status } = req.query; // 'paid' or 'unpaid'

        let paymentCondition = '';
        if (status === 'paid') {
            paymentCondition = "AND u.plan_name != 'Free'";
        } else if (status === 'unpaid') {
            paymentCondition = "AND (u.plan_name = 'Free' OR u.plan_name IS NULL)";
        }

        const query = `
            SELECT 
                u.id,
                u.name,
                u.email,
                u.phone,
                u.grade,
                u.plan_name as payment_status,
                u.created_at as enrollment_date,
                p.amount as amount_paid,
                p.created_at as payment_date,
                p.currency
            FROM users u
            JOIN roles r ON u.role_id = r.id
            LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
            WHERE r.name = 'student' AND u.is_active = 1
            ${paymentCondition}
            ORDER BY u.name
        `;

        const [results] = await db.query(query);
        res.json({ students: results });
    } catch (error) {
        console.error('[getPaymentDetails] Error:', error);
        res.status(500).json({ error: 'Failed to fetch payment details' });
    }
};

module.exports = {
    getDashboardSummary,
    getClassAssignments,
    getStudentEnrollment,
    getPaymentDetails
};
