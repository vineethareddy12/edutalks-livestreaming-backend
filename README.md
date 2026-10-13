# LearnPulse — Backend

LearnPulse (internal codebase branding: EduTalks) is a live-streaming and e-learning platform built with Node.js, Express, and MySQL.

## Technology Stack
- Node.js and Express.js
- MySQL
- JWT authentication and bcryptjs password hashing
- Socket.io for real-time communication
- Agora RTC for live classes
- Razorpay for subscription payments
- Multer for file uploads

## Core Features
- Authentication and role-based access
- Live class scheduling and streaming
- Student and instructor management
- Study material uploads
- Exams, submissions, and grading
- Student doubts and messaging
- Tournaments and attendance tracking
- Subscription and payment verification

## Project Structure
- `controllers/` — Request handling
- `middleware/` — Authentication and other middleware
- `models/` — Data models
- `routes/` — API route definitions
- `services/` — Business logic and integrations
- `utils/` — Shared utilities
- `server.js` — Server entry point

## Environment Configuration
Configure the required environment variables locally. Refer to `.env.example` for placeholder names and descriptions.

Never commit real API keys, passwords, JWT secrets, payment credentials, or production database credentials.

## Local Development
1. Install Node.js and MySQL.
2. Clone the repository.
3. Install dependencies using `npm install`.
4. Configure the required environment variables.
5. Set up the database using the project's actual schema and setup instructions.
6. Start the server using the appropriate script defined in `package.json`.

## Planned AI Integration
LearnPulse may integrate the Claude API to support course-related questions, learning explanations, and instructor-reviewed quiz generation. These are planned capabilities unless explicitly implemented.

## Security
Do not expose credentials, personal information, database dumps, or confidential production data in this repository.

## License
A license should be added only after confirming that you have permission to publish and license this code.
