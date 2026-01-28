const studentController = {
    getDashboard: async (req, res) => {
        try {
            const db = req.app.locals.db;
            const studentId = req.user.id;

            // 1. Get Student's Grade & Selected Course
            const [users] = await db.query(`
                SELECT u.grade, u.selected_subject_id, s.name as course_name 
                FROM users u
                LEFT JOIN subjects s ON u.selected_subject_id = s.id
                WHERE u.id = ?
            `, [studentId]);

            if (users.length === 0) return res.status(404).json({ message: 'Student not found' });
            let grade = users[0].grade;
            let courseName = users[0].course_name;
            console.log('[getDashboard] User data:', users[0]);

            // Fallback: If map by ID failed, try matching by Name (Fuzzy)
            if (!courseName && grade) {
                try {
                    const cleanGrade = grade.replace(/[^a-zA-Z0-9\s]/g, '').trim();
                    if (cleanGrade.length > 3) { // Avoid over-matching short strings
                        console.log(`[getDashboard] Attempting fuzzy match for grade: "${cleanGrade}"`);
                        const [fuzzyMatch] = await db.query(`
                            SELECT name FROM subjects 
                            WHERE name LIKE ? OR grade LIKE ? 
                            LIMIT 1
                        `, [`%${cleanGrade}%`, `%${cleanGrade}%`]);

                        if (fuzzyMatch.length > 0) {
                            courseName = fuzzyMatch[0].name;
                            console.log(`[getDashboard] Fuzzy match found: "${courseName}"`);
                        }
                    }
                } catch (e) {
                    console.error("[getDashboard] Fuzzy match error:", e);
                }
            }

            // 2. Get Stats (Strictly Batch-Specific and Expiry-Aware)
            // Regular Classes
            const [regularClassesCount] = await db.query(`
                SELECT COUNT(*) as count FROM live_classes lc 
                JOIN batches b ON lc.instructor_id = b.instructor_id AND lc.subject_id = b.subject_id
                JOIN student_batches sb ON b.id = sb.batch_id
                WHERE sb.student_id = ? AND lc.status = "live"
            `, [studentId]);

            // Super Instructor Classes (Based on Grade)
            // Use filtered subject if available for UG/PG, otherwise just grade
            let siQuery = `SELECT COUNT(*) as count FROM super_instructor_classes WHERE grade = ? AND status = 'live'`;
            let siParams = [users[0].grade];

            if (users[0].selected_subject_id) {
                siQuery += ` AND (subject_id IS NULL OR subject_id = ?)`;
                siParams.push(users[0].selected_subject_id);
            }

            const [siClassesCount] = await db.query(siQuery, siParams);

            const classesCount = [{ count: regularClassesCount[0].count + siClassesCount[0].count }];

            const [examsCount] = await db.query(`
                SELECT COUNT(*) as count FROM exams e 
                JOIN batches b ON e.instructor_id = b.instructor_id AND e.subject_id = b.subject_id
                JOIN student_batches sb ON b.id = sb.batch_id
                LEFT JOIN exam_submissions es ON e.id = es.exam_id AND es.student_id = ?
                WHERE sb.student_id = ? 
                AND e.date <= UTC_TIMESTAMP() 
                AND (e.expiry_date IS NULL OR e.expiry_date >= UTC_TIMESTAMP())
                AND es.id IS NULL
            `, [studentId, studentId]);

            const [liveTournamentsCount] = await db.query(`
                SELECT COUNT(*) as count FROM tournaments t
                WHERE t.grade = ? AND (t.status = 'LIVE' OR (t.status = 'UPCOMING' AND t.exam_start <= UTC_TIMESTAMP() AND t.exam_end > UTC_TIMESTAMP()))
            `, [grade]);

            const [upcomingTournamentsCount] = await db.query(`
                SELECT COUNT(*) as count FROM tournaments t
                WHERE t.grade = ? AND t.status = 'UPCOMING' AND t.exam_start > UTC_TIMESTAMP()
            `, [grade]);

            const [notesCount] = await db.query(`
                SELECT COUNT(*) as count FROM notes n 
                JOIN batches b ON n.uploaded_by = b.instructor_id AND n.subject_id = b.subject_id
                JOIN student_batches sb ON b.id = sb.batch_id
                WHERE sb.student_id = ?
            `, [studentId]);

            // 3. Get Assigned Batches & Subjects
            const [batches] = await db.query(`
                SELECT b.id as batch_id, b.name as batch_name, s.name as subject_name, u.name as instructor_name
                FROM student_batches sb
                JOIN batches b ON sb.batch_id = b.id
                JOIN subjects s ON b.subject_id = s.id
                JOIN users u ON b.instructor_id = u.id
                WHERE sb.student_id = ?
            `, [studentId]);

            // 4. Get Upcoming Classes (Strictly Batch-Specific)
            const [upcomingClasses] = await db.query(`
                SELECT DISTINCT lc.*, s.name as subject_name, u.name as instructor_name
                FROM live_classes lc
                JOIN batches b ON lc.instructor_id = b.instructor_id 
                    AND (lc.subject_id = b.subject_id OR lc.subject_id IS NULL)
                JOIN student_batches sb ON b.id = sb.batch_id
                LEFT JOIN subjects s ON lc.subject_id = s.id
                JOIN users u ON lc.instructor_id = u.id
                WHERE sb.student_id = ? AND (lc.start_time >= UTC_TIMESTAMP() OR lc.status = "live")
                ORDER BY lc.status = "live" DESC, lc.start_time ASC
                LIMIT 5
            `, [studentId]);

            // 4b. Get Live/Upcoming Tournaments (Exclude already submitted)
            const [liveTournaments] = await db.query(`
                SELECT t.*, u.name as instructor_name, s.name as subject_name
                FROM tournaments t
                JOIN users u ON t.instructor_id = u.id
                LEFT JOIN subjects s ON t.subject_id = s.id
                WHERE t.grade = ? AND t.status IN ('LIVE', 'UPCOMING')
                AND (SELECT COUNT(*) FROM tournament_registrations tr WHERE tr.tournament_id = t.id AND tr.student_id = ?) > 0
                AND NOT EXISTS (SELECT 1 FROM tournament_attempts ta WHERE ta.tournament_id = t.id AND ta.student_id = ?)
                AND (t.status = 'LIVE' OR (t.status = 'UPCOMING' AND t.exam_start <= UTC_TIMESTAMP() AND t.exam_end > UTC_TIMESTAMP()))
                ORDER BY t.status = 'LIVE' DESC, t.exam_start ASC
                LIMIT 5
            `, [grade, studentId, studentId]);

            console.log(`[getDashboard] Student ID: ${studentId}, Upcoming Classes Found: ${upcomingClasses.length}`);
            if (upcomingClasses.length > 0) {
                console.log(`[getDashboard] First Class Details:`, JSON.stringify(upcomingClasses[0]));
            }

            // 5. Get Recent Test Results (Including Reviews)
            const [examResults] = await db.query(`
                SELECT es.id as submission_id, es.score as auto_score, es.submitted_at, 
                       es.file_path, e.title, e.total_marks, s.name as subject_name,
                       sr.review_text, sr.score as reviewed_score,
                       'exam' as type
                FROM exam_submissions es
                JOIN exams e ON es.exam_id = e.id
                JOIN subjects s ON e.subject_id = s.id
                LEFT JOIN submission_reviews sr ON es.id = sr.submission_id
                WHERE es.student_id = ?
                ORDER BY es.submitted_at DESC
                LIMIT 5
            `, [studentId]);

            // 5b. Get Recent Tournament Results
            const [tournamentResults] = await db.query(`
                SELECT ta.id as submission_id, ta.score, ta.submitted_at, 
                       t.name as title, t.questions,
                       'Tournament' as subject_name
                FROM tournament_attempts ta
                JOIN tournaments t ON ta.tournament_id = t.id
                WHERE ta.student_id = ?
                ORDER BY ta.submitted_at DESC
                LIMIT 5
            `, [studentId]);

            // Process Tournament Results to match shape
            const processedTournaments = tournamentResults.map(t => {
                let totalMarks = 100; // Default
                try {
                    const q = typeof t.questions === 'string' ? JSON.parse(t.questions) : t.questions;
                    if (Array.isArray(q)) {
                        totalMarks = q.length * 4; // Assuming 4 marks per question standard
                    }
                } catch (e) { }

                return {
                    submission_id: t.submission_id,
                    score: t.score,
                    submitted_at: t.submitted_at,
                    file_path: 'online-mode', // Hack to hide upload button
                    title: t.title,
                    total_marks: totalMarks || 100,
                    subject_name: 'TOURNAMENT',
                    review_text: null,
                    reviewed_score: null,
                    type: 'tournament'
                };
            });

            // Merge and Sort
            const allResults = [...examResults.map(r => ({
                ...r,
                score: r.reviewed_score !== null ? r.reviewed_score : r.auto_score
            })), ...processedTournaments];

            allResults.sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at));
            const recentResults = allResults.slice(0, 5);

            // Construct Branding Name
            let displayClassName = grade;
            if ((grade === 'UG' || grade === 'PG') && courseName) {
                displayClassName = `${grade} - ${courseName}`;
            } else if (grade && !isNaN(parseFloat(grade)) && !grade.includes('Class')) {
                displayClassName = `Class ${grade}`;
            }

            res.json({
                grade,
                course_name: courseName,
                displayClassName, // Branding Field
                stats: {
                    liveNow: (classesCount[0].count || 0) + (liveTournamentsCount[0].count || 0),
                    upcomingExams: (examsCount[0].count || 0) + (upcomingTournamentsCount[0].count || 0),
                    studyMaterials: notesCount[0].count || 0
                },
                batches,
                upcomingClasses,
                liveTournaments,
                recentResults
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Server error' });
        }
    },

    getProfile: async (req, res) => {
        try {
            const db = req.app.locals.db;
            const studentId = req.user.id;

            // 1. Get User Details
            const [users] = await db.query(`
                SELECT u.id, u.name, u.email, u.phone, u.grade, u.plan_name, u.subscription_expires_at, u.created_at,
                       s.name as course_name
                FROM users u
                LEFT JOIN subjects s ON u.selected_subject_id = s.id
                WHERE u.id = ?
            `, [studentId]);

            console.log('[getProfile] Fetched user:', users[0]);

            if (users.length === 0) return res.status(404).json({ message: 'User not found' });

            let user = users[0];
            // Fallback: Fuzzy match course name if missing
            if (!user.course_name && user.grade) {
                try {
                    const cleanGrade = user.grade.replace(/[^a-zA-Z0-9\s]/g, '').trim();
                    if (cleanGrade.length > 3) {
                        const [fuzzyMatch] = await db.query(`
                            SELECT name FROM subjects 
                            WHERE name LIKE ? OR grade LIKE ? 
                            LIMIT 1
                        `, [`%${cleanGrade}%`, `%${cleanGrade}%`]);

                        if (fuzzyMatch.length > 0) {
                            user.course_name = fuzzyMatch[0].name;
                            console.log(`[getProfile] Fuzzy match found: "${user.course_name}"`);
                        }
                    }
                } catch (e) { console.error("Fuzzy match err", e); }
            }

            // 2. Get Payment History
            const [payments] = await db.query(`
                SELECT id, order_id, amount, status, created_at 
                FROM payments WHERE user_id = ? 
                ORDER BY created_at DESC
            `, [studentId]);

            res.json({
                user,
                payments
            });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Server error' });
        }
    },

    getSubjects: async (req, res) => {
        try {
            const db = req.app.locals.db;
            const studentId = req.user.id;

            // Get Student's Grade
            const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [studentId]);
            if (users.length === 0) return res.status(404).json({ message: 'Student not found' });
            const grade = users[0].grade;

            // Get Subjects for Grade
            const [subjects] = await db.query(`
                SELECT s.id, s.name, (SELECT COUNT(*) FROM notes WHERE subject_id = s.id) as materials_count
                FROM subjects s
                WHERE s.grade = ? OR s.class_id = (SELECT id FROM classes WHERE name = ?)
            `, [grade, grade]);

            res.json(subjects);
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Server error' });
        }
    },

    getSubjectsFull: async (req, res) => {
        try {
            const db = req.app.locals.db;
            const studentId = req.user.id;

            // 1. Get Student's Grade
            const [users] = await db.query('SELECT grade FROM users WHERE id = ?', [studentId]);
            if (users.length === 0) return res.status(404).json({ message: 'Student not found' });

            let grade = users[0].grade;
            console.log(`[getSubjectsFull] Fetching for student ${studentId}, grade: ${grade}`);

            if (!grade) {
                return res.json([]); // No grade, no subjects
            }

            // 2. Get Subjects (Including Assigned Instructor - ONLY if student is in that batch)
            console.log(`[getSubjectsFull] Student ID: ${studentId}, Grade: ${grade}`);

            let subjectQuery = `
                SELECT s.id, s.name, 
                       (SELECT CASE WHEN u2.is_active = 0 THEN CONCAT(u2.name, ' (Instructor removed)') ELSE u2.name END
                        FROM student_batches sb2
                        JOIN batches b2 ON sb2.batch_id = b2.id
                        JOIN users u2 ON b2.instructor_id = u2.id
                        WHERE sb2.student_id = ? AND b2.subject_id = s.id
                        LIMIT 1) as instructor_name
                FROM subjects s
                WHERE s.class_id = (SELECT id FROM classes WHERE name = ? OR name LIKE ? LIMIT 1) 
                OR s.grade = ? 
                OR s.grade LIKE ?
            `;

            let subjectParams = [studentId, grade, `${grade}%`, grade, `${grade}%`];
            const [subjects] = await db.query(subjectQuery, subjectParams);

            console.log(`[getSubjectsFull] Found ${subjects.length} subjects for grade "${grade}"`);

            // Group subjects by Name to handle duplicates (Merging)
            const subjectsByName = {};
            for (const sub of subjects) {
                if (!subjectsByName[sub.name]) {
                    subjectsByName[sub.name] = { ...sub, all_ids: [sub.id] };
                } else {
                    subjectsByName[sub.name].all_ids.push(sub.id);
                    // Keep the ID that has an instructor name if possible
                    if (!subjectsByName[sub.name].instructor_name && sub.instructor_name) {
                        subjectsByName[sub.name].instructor_name = sub.instructor_name;
                        subjectsByName[sub.name].id = sub.id; // Promote this ID as primary
                    }
                }
            }
            const uniqueSubjects = Object.values(subjectsByName);

            // 3. Get Notes for Assigned Batches
            const [notes] = await db.query(`
                SELECT DISTINCT n.*, s.id as subject_id 
                FROM notes n 
                JOIN batches b ON n.uploaded_by = b.instructor_id AND n.subject_id = b.subject_id
                JOIN student_batches sb ON b.id = sb.batch_id
                JOIN subjects s ON n.subject_id = s.id
                WHERE sb.student_id = ?
            `, [studentId]);

            // 4. Get Exams for Assigned Batches (Including Expired)
            const [exams] = await db.query(`
                SELECT DISTINCT e.*, s.id as subject_id 
                FROM exams e 
                JOIN batches b ON e.instructor_id = b.instructor_id AND e.subject_id = b.subject_id
                JOIN student_batches sb ON b.id = sb.batch_id
                JOIN subjects s ON e.subject_id = s.id
                WHERE sb.student_id = ?
            `, [studentId]);

            // 5. Get Submissions (Including Reviews & Attempt Counts)
            const [submissions] = await db.query(`
                SELECT es.*, sr.review_text, sr.score as reviewed_score
                FROM exam_submissions es
                LEFT JOIN submission_reviews sr ON es.id = sr.submission_id
                WHERE es.student_id = ?
                ORDER BY es.submitted_at DESC
            `, [studentId]);

            // 6. Assemble
            const data = uniqueSubjects.map(s => {
                const subjectIds = s.all_ids;
                return {
                    ...s,
                    notes: notes.filter(n => subjectIds.includes(n.subject_id)),
                    exams: exams.filter(e => subjectIds.includes(e.subject_id)).map(e => {
                        const studentSubmissions = submissions.filter(su => su.exam_id === e.id);
                        const bestSubmission = studentSubmissions.find(su => su.status === 'graded') || studentSubmissions[0];
                        const isExpired = e.expiry_date && new Date(e.expiry_date) < new Date();

                        let status = 'Attempt Now';
                        if (studentSubmissions.length > 0) {
                            status = bestSubmission.status === 'graded' ? 'Completed' : 'Pending';
                        } else if (isExpired) {
                            status = 'Expired';
                        }

                        return {
                            ...e,
                            status,
                            score: bestSubmission ? (bestSubmission.reviewed_score !== null ? bestSubmission.reviewed_score : bestSubmission.score) : null,
                            review_text: bestSubmission ? bestSubmission.review_text : null,
                            attempts_done: studentSubmissions.length,
                            is_expired: isExpired,
                            all_attempts: studentSubmissions.map(sub => ({
                                id: sub.id,
                                score: sub.reviewed_score !== null ? sub.reviewed_score : sub.score,
                                submitted_at: sub.submitted_at,
                                review_text: sub.review_text,
                                file_path: sub.file_path
                            }))
                        };
                    }).filter(e => e.status !== 'Expired')
                };
            });

            // Handle independent items (if any instructor uploaded without subject)
            // For now, we only show subject-linked ones to keep it clean.

            res.json(data);
        } catch (err) {
            console.error("Error in getSubjectsFull:", err);
            res.status(500).json({ message: 'Server error' });
        }
    },
    updateProfile: async (req, res) => {
        try {
            const db = req.app.locals.db;
            const studentId = req.user.id;
            const { name, email, phone } = req.body;

            // Validation
            if (!name || !email) {
                return res.status(400).json({ message: 'Name and email are required' });
            }

            // Check if email is taken by another user
            const [existing] = await db.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, studentId]);
            if (existing.length > 0) {
                return res.status(400).json({ message: 'This email is already taken by another user. Please use a different email.' });
            }

            // Update user
            await db.query(
                'UPDATE users SET name = ?, email = ?, phone = ? WHERE id = ?',
                [name, email, phone || null, studentId]
            );

            res.json({ message: 'Profile updated successfully' });

        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Server error' });
        }
    }
};

module.exports = studentController;
