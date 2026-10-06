CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_code TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deactivated')),
  target_exam TEXT DEFAULT 'BPSC Prelims',
  exam_date DATE,
  daily_target INTEGER DEFAULT 100,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  streak_days INTEGER NOT NULL DEFAULT 0,
  last_activity_date DATE,
  last_login_at TIMESTAMPTZ,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS student_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_attempt TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en-hi';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_student_code ON users(student_code) WHERE student_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status,role);

CREATE TABLE IF NOT EXISTS planner_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_date DATE NOT NULL, title TEXT NOT NULL, subject TEXT, target INTEGER,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  completed BOOLEAN NOT NULL DEFAULT FALSE, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_planner_user_date ON planner_tasks(user_id,task_date);

CREATE TABLE IF NOT EXISTS tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, institution TEXT, category TEXT,
  year INTEGER, sequence_no INTEGER, access_type TEXT NOT NULL DEFAULT 'premium',
  duration_seconds INTEGER NOT NULL DEFAULT 7200, published BOOLEAN NOT NULL DEFAULT TRUE,
  question_count INTEGER NOT NULL DEFAULT 0, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tests_library ON tests(institution,year DESC,sequence_no);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  subject TEXT, topic TEXT, subtopic TEXT, year INTEGER, language TEXT DEFAULT 'bilingual',
  question_en TEXT NOT NULL, question_hi TEXT, options JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer INTEGER, explanation_en TEXT, explanation_hi TEXT, difficulty TEXT,
  source TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_questions_subject_topic ON questions(subject,topic);
CREATE INDEX IF NOT EXISTS idx_questions_year ON questions(year DESC);

CREATE TABLE IF NOT EXISTS test_questions (
  test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(test_id,question_id)
);
-- Legacy compatibility: an older test_questions table may already exist without question_id/sort_order.
ALTER TABLE test_questions ADD COLUMN IF NOT EXISTS test_id UUID;
ALTER TABLE test_questions ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE test_questions ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 1;

CREATE TABLE IF NOT EXISTS test_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('practice','exam')),
  score NUMERIC(7,2) NOT NULL DEFAULT 0, total_questions INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0, incorrect INTEGER NOT NULL DEFAULT 0, unattempted INTEGER NOT NULL DEFAULT 0,
  accuracy NUMERIC(7,2) NOT NULL DEFAULT 0, time_taken_seconds INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attempts_user_time ON test_attempts(user_id,submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_test_time ON test_attempts(test_id,submitted_at DESC);

CREATE TABLE IF NOT EXISTS question_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_id UUID NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE, question_id TEXT NOT NULL,
  selected_option INTEGER, correct_option INTEGER, is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  is_bookmarked BOOLEAN NOT NULL DEFAULT FALSE, marked_for_review BOOLEAN NOT NULL DEFAULT FALSE,
  time_spent_seconds INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Legacy database compatibility: migrate columns BEFORE creating any index that references them.
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS attempt_id UUID;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS selected_option INTEGER;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS correct_option INTEGER;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS is_correct BOOLEAN DEFAULT FALSE;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS is_bookmarked BOOLEAN DEFAULT FALSE;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS marked_for_review BOOLEAN DEFAULT FALSE;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS time_spent_seconds INTEGER DEFAULT 0;
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS revision_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL, source TEXT, reason TEXT, notes TEXT,
  revision_status TEXT NOT NULL DEFAULT 'needs_revision', next_revision_date DATE,
  revision_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id,question_id)
);
CREATE INDEX IF NOT EXISTS idx_revision_user_due ON revision_items(user_id,next_revision_date);

CREATE TABLE IF NOT EXISTS xp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, source_id TEXT, xp_amount INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_xp_user_time ON xp_ledger(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS badges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key TEXT NOT NULL, earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,badge_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL, target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- Existing v1 databases may have a NOT NULL email column. Make it nullable so admin-generated accounts can use student_code only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email') THEN
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
  END IF;
EXCEPTION WHEN others THEN NULL; END $$;


-- Persistent in-progress quiz sessions: survives browser close, device change and multi-day gaps.
CREATE TABLE IF NOT EXISTS quiz_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  test_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('practice','exam')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quiz_sessions_one_open_per_user ON quiz_sessions(user_id) WHERE status='in_progress';
CREATE INDEX IF NOT EXISTS idx_quiz_sessions_user_status ON quiz_sessions(user_id,status,updated_at DESC);


-- DHYEYA V3: notifications, presence and Battle Arena
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'announcement',
  link TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  PRIMARY KEY(notification_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_notification_recipient_user ON notification_recipients(user_id,read_at);

CREATE TABLE IF NOT EXISTS user_presence (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON user_presence(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS battle_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','completed','cancelled')),
  mode TEXT NOT NULL DEFAULT 'standard',
  subject TEXT,
  question_count INTEGER NOT NULL DEFAULT 20,
  seconds_per_question INTEGER NOT NULL DEFAULT 20,
  current_question INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  winner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Legacy battle_rooms compatibility: ensure columns exist before indexes/API use.
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS creator_id UUID;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS accepted_by UUID;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'waiting';
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS mode TEXT DEFAULT 'standard';
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS question_count INTEGER DEFAULT 20;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS seconds_per_question INTEGER DEFAULT 20;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS current_question INTEGER DEFAULT 0;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS winner_id UUID;
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE battle_rooms ADD COLUMN IF NOT EXISTS current_question_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_battle_rooms_status ON battle_rooms(status,created_at DESC);
CREATE TABLE IF NOT EXISTS battle_players (
  battle_id UUID NOT NULL REFERENCES battle_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(battle_id,user_id)
);
CREATE TABLE IF NOT EXISTS battle_questions (
  battle_id UUID NOT NULL REFERENCES battle_rooms(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL,
  PRIMARY KEY(battle_id,question_id)
);
CREATE TABLE IF NOT EXISTS battle_answers (
  battle_id UUID NOT NULL REFERENCES battle_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  selected_option INTEGER,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  time_ms INTEGER NOT NULL DEFAULT 0,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(battle_id,user_id,question_id)
);
ALTER TABLE battle_questions ADD COLUMN IF NOT EXISTS battle_id UUID;
ALTER TABLE battle_questions ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE battle_questions ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS battle_id UUID;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS question_id TEXT;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS selected_option INTEGER;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS is_correct BOOLEAN DEFAULT FALSE;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS time_ms INTEGER DEFAULT 0;
ALTER TABLE battle_answers ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ DEFAULT NOW();


CREATE INDEX IF NOT EXISTS idx_battle_rooms_updated ON battle_rooms(updated_at DESC);


