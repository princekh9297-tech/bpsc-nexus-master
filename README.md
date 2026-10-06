# BPSC Nexus Premium v5.0

Premium BPSC preparation platform built around the existing 30,157-question vault.

## Core platform
- 30,157 bundled question records preserved unchanged.
- Practice Mode / Exam Mode / Custom Mock / BPSC Full Mock.
- Revision Bank, Mistake Bank, bookmarks, PYQ hub and performance analytics.
- Dhyeya-derived premium design system and six-world theme architecture.
- NIVA tutor and English/Hindi translation backend.

## Account system
- Separate Student and Admin login modes.
- HTTP-only JWT session cookie.
- Passwords hashed with bcryptjs; never stored/displayed in plaintext.
- Student ID, username or email login.
- Admin-created student accounts, credential reset, account block/activate/deactivate.
- Profile and password management.
- Presence heartbeat and notifications.

## Advanced student systems
- Day Planner with date navigation, priorities, targets, completion progress and study-day template generation.
- XP, levels and streak progression.
- Global leaderboard with All-Time / Daily / Weekly / Monthly scopes.
- Battle Arena: server-authoritative 1v1 matchmaking, timed questions, scoring, opponent state, winner and XP.
- Persistent support tickets and admin replies.
- Persistent quiz activity reporting for analytics/XP.

## Admin Control Center
- Student management and credential generation/reset.
- Question Bank: PDF/JSON/CSV/TXT import, validation, Unicode diagnostics, browse/search and import history.
- Test/section creation, publishing/unpublishing and deletion.
- Attempt monitoring.
- Analytics and question-quality infrastructure.
- Planner monitoring.
- Support inbox.
- Broadcast notifications.
- Audit logs.

## PostgreSQL deployment
Set these environment variables in Render or your server:
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- optional `ADMIN_NAME`, `ADMIN_USERNAME`
- `GEMINI_API_KEY` for NIVA/translation
- optional `GEMINI_MODEL`

On first deployment, if the PostgreSQL `questions` table is empty, the server seeds the bundled 30,157-question vault. If the database already contains questions, the seed is skipped and existing database content is preserved.

For production, PostgreSQL is required for real student accounts, global leaderboard state and cross-device Battle Arena state.
