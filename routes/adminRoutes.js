const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAnalyticsController = require('../controllers/adminAnalyticsController');
const { verifyToken, authorizeRoles } = require('../middleware/authMiddleware');

// Dashboard Stats
router.get('/dashboard/stats', verifyToken, authorizeRoles('admin'), adminController.getDashboardStats);

// User Management Lists
router.get('/super-instructors', verifyToken, authorizeRoles('admin'), adminController.getSuperInstructors);
router.get('/instructors', verifyToken, authorizeRoles('admin'), adminController.getInstructors);
router.get('/students', verifyToken, authorizeRoles('admin'), adminController.getStudents);

// Approval
router.put('/approve/:id', verifyToken, authorizeRoles('admin'), adminController.approveUser);
router.put('/deactivate/:id', verifyToken, authorizeRoles('admin'), adminController.deactivateUser);

// Analytics Endpoints
router.get('/analytics/dashboard-summary', verifyToken, authorizeRoles('admin', 'super_admin'), adminAnalyticsController.getDashboardSummary);
router.get('/analytics/class-assignments', verifyToken, authorizeRoles('admin', 'super_admin'), adminAnalyticsController.getClassAssignments);
router.get('/analytics/student-enrollment', verifyToken, authorizeRoles('admin', 'super_admin'), adminAnalyticsController.getStudentEnrollment);
router.get('/analytics/payment-details', verifyToken, authorizeRoles('admin', 'super_admin'), adminAnalyticsController.getPaymentDetails);


module.exports = router;
