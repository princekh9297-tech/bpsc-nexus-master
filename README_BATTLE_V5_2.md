# BPSC Nexus V5.2 — Challenge Everyone

## Battle Arena flow
1. A logged-in student completes any quiz with at least 3 questions.
2. The result screen exposes **⚔ Challenge Everyone**.
3. The server recalculates the creator's correct answers from PostgreSQL; client-supplied score is not trusted.
4. A challenge room is created for 15 minutes.
5. Students whose presence heartbeat is less than 90 seconds old receive a `battle_challenge` notification.
6. The first eligible student to accept atomically claims the challenge. Other accepts fail safely.
7. The opponent receives the same question set and completes an independent attempt.
8. The server scores the opponent, compares both scores, awards XP, closes the challenge, and notifies the creator.
9. The challenge is visible in Battle Arena and can also be opened from Alerts.

## Presence
Student clients send a heartbeat every 25 seconds. A student is considered online for Challenge Everyone when their last heartbeat is within 90 seconds.

## Database migration
The server bootstrap adds the following `battle_rooms` columns when they are missing:
- challenge_total
- creator_score
- creator_correct
- creator_time_seconds
- challenge_expires_at
- challenge_meta

The migration is additive and does not delete existing battle or question data.
