import crypto from 'node:crypto';

const TITLE_RULES = [
  ['questions',0,'New Recruit'],['questions',100,'First Step'],['questions',500,'Question Seeker'],['questions',1000,'Knowledge Hunter'],['questions',2500,'Vault Explorer'],['questions',5000,'Relentless Learner'],['questions',10000,'Nexus Scholar'],['questions',15000,'Prelims Veteran'],['questions',20000,'Nexus Master'],['questions',30000,'Vault Conqueror'],
  ['wins',1,'First Blood'],['wins',5,'Arena Fighter'],['wins',10,'Battle Veteran'],['wins',25,'Arena Warrior'],['wins',50,'Arena Champion'],['wins',100,'Battle Legend'],['wins',250,'Arena Dominator'],['wins',500,'Nexus Warlord'],
  ['streak',3,'Getting Started'],['streak',7,'Week Warrior'],['streak',14,'Consistent'],['streak',30,'Dedicated'],['streak',60,'Disciplined'],['streak',100,'Unbreakable'],
  ['accuracy',75,'Sharp Shooter'],['accuracy',80,'Precision Mind'],['accuracy',90,'Elite Accuracy'],['accuracy',95,'Mastermind'],
  ['tests',5,'Test Taker'],['tests',10,'Mock Regular'],['tests',25,'Test Veteran'],['tests',50,'Mock Specialist'],['tests',100,'Prelims Machine'],
  ['revision',100,'Revision Rookie'],['revision',500,'Revision Pro'],['revision',1000,'Memory Builder'],['revision',2500,'Recall Master'],['revision',5000,'Revision Beast']
];

export async function ensureNexusV53(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS community_posts(
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_type TEXT NOT NULL DEFAULT 'discussion', title TEXT, body TEXT NOT NULL, image_url TEXT, poll JSONB,
    status TEXT NOT NULL DEFAULT 'visible', pinned BOOLEAN NOT NULL DEFAULT FALSE, locked BOOLEAN NOT NULL DEFAULT FALSE,
    helpful_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_community_posts_feed ON community_posts(status,pinned,created_at DESC);
    CREATE TABLE IF NOT EXISTS community_comments(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE,
      helpful_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS idx_community_comments_post ON community_comments(post_id,created_at ASC);
    CREATE TABLE IF NOT EXISTS community_reactions(
      post_id UUID NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reaction TEXT NOT NULL DEFAULT 'like', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(post_id,user_id));
    CREATE TABLE IF NOT EXISTS community_reports(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
      comment_id UUID REFERENCES community_comments(id) ON DELETE CASCADE, reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS battle_profiles(
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, rating INTEGER NOT NULL DEFAULT 1000,
      wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS nexus_seasons(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL, active BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS nexus_daily_missions(
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mission_date DATE NOT NULL, mission_key TEXT NOT NULL, target INTEGER NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
      xp_reward INTEGER NOT NULL DEFAULT 25, completed BOOLEAN NOT NULL DEFAULT FALSE, UNIQUE(user_id,mission_date,mission_key));
    CREATE INDEX IF NOT EXISTS idx_nexus_missions_user_date ON nexus_daily_missions(user_id,mission_date);
    CREATE OR REPLACE FUNCTION nexus_v53_battle_complete() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE loser UUID; winner UUID; draw BOOLEAN;
    BEGIN
      IF NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
        INSERT INTO battle_profiles(user_id) VALUES(NEW.creator_id) ON CONFLICT DO NOTHING;
        IF NEW.accepted_by IS NOT NULL THEN INSERT INTO battle_profiles(user_id) VALUES(NEW.accepted_by) ON CONFLICT DO NOTHING; END IF;
        winner:=NEW.winner_id; draw:=winner IS NULL;
        IF draw THEN
          UPDATE battle_profiles SET draws=draws+1,current_streak=0,updated_at=NOW() WHERE user_id IN (NEW.creator_id,NEW.accepted_by);
        ELSE
          loser:=CASE WHEN winner=NEW.creator_id THEN NEW.accepted_by ELSE NEW.creator_id END;
          UPDATE battle_profiles SET wins=wins+1,current_streak=current_streak+1,best_streak=GREATEST(best_streak,current_streak+1),rating=rating+32,updated_at=NOW() WHERE user_id=winner;
          IF loser IS NOT NULL THEN UPDATE battle_profiles SET losses=losses+1,current_streak=0,rating=GREATEST(100,rating-32),updated_at=NOW() WHERE user_id=loser; END IF;
        END IF;
      END IF; RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS trg_nexus_v53_battle_complete ON battle_rooms;
    CREATE TRIGGER trg_nexus_v53_battle_complete AFTER UPDATE OF status ON battle_rooms FOR EACH ROW EXECUTE FUNCTION nexus_v53_battle_complete();
  `);
  const active=(await pool.query('SELECT id FROM nexus_seasons WHERE active=true ORDER BY starts_at DESC LIMIT 1')).rows[0];
  if(!active) await pool.query(`INSERT INTO nexus_seasons(name,starts_at,ends_at,active) VALUES($1,NOW(),NOW()+INTERVAL '90 days',true)`,['Season 01 — Prelims Ascension']);
}

function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
async function ensureProfile(pool,id){await pool.query(`INSERT INTO battle_profiles(user_id) VALUES($1) ON CONFLICT DO NOTHING`,[id]);}
async function stats(pool,id){
  const a=(await pool.query(`SELECT COALESCE(SUM(total_questions),0)::int questions,COALESCE(SUM(correct),0)::int correct,COUNT(*)::int tests,COALESCE(AVG(accuracy),0)::numeric accuracy FROM test_attempts WHERE user_id=$1`,[id])).rows[0];
  const b=(await pool.query(`SELECT COUNT(*)::int battles,COUNT(*) FILTER(WHERE winner_id=$1)::int wins FROM battle_rooms WHERE (creator_id=$1 OR accepted_by=$1) AND status='completed'`,[id])).rows[0];
  const r=(await pool.query(`SELECT COUNT(*)::int revision FROM revision_items WHERE user_id=$1`,[id])).rows[0];
  const c=(await pool.query(`SELECT COUNT(*)::int posts FROM community_posts WHERE user_id=$1 AND status='visible'`,[id])).rows[0];
  const bp=(await pool.query(`SELECT rating,wins,losses,draws,current_streak,best_streak FROM battle_profiles WHERE user_id=$1`,[id])).rows[0]||{};
  return {...a,...b,...r,...c,...bp,streak:0};
}
function titles(s){
  const out=[];
  for(const [kind,threshold,title] of TITLE_RULES){const value=kind==='questions'?s.questions:kind==='wins'?s.wins:kind==='tests'?s.tests:kind==='revision'?s.revision:kind==='accuracy'?Number(s.accuracy):kind==='streak'?s.streak:0;if(value>=threshold&&threshold>0)out.push({kind,threshold,title});}
  return out;
}
function elite(s){const e=[];if(s.questions>=10000&&Number(s.accuracy)>=75&&s.tests>=50&&s.wins>=25&&s.streak>=30)e.push('Nexus Elite');if(s.questions>=20000&&Number(s.accuracy)>=80&&s.tests>=100&&s.wins>=100&&s.streak>=60)e.push('Nexus Legend');if(s.questions>=30000&&Number(s.accuracy)>=85&&s.battles>=150&&s.wins>=100&&s.streak>=100)e.push('Nexus Grandmaster');return e;}

async function missions(pool,id){
  const d=(await pool.query(`SELECT (NOW() AT TIME ZONE 'UTC')::date d`)).rows[0].d;
  const defs=[['questions',50,50],['tests',1,40],['battle',1,50],['revision',15,35]];
  for(const [key,target,xp] of defs) await pool.query(`INSERT INTO nexus_daily_missions(user_id,mission_date,mission_key,target,xp_reward) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[id,d,key,target,xp]);
  const rows=(await pool.query(`SELECT * FROM nexus_daily_missions WHERE user_id=$1 AND mission_date=$2 ORDER BY id`,[id,d])).rows;
  const s=await stats(pool,id);
  for(const m of rows){let p=0;if(m.mission_key==='questions')p=s.questions; if(m.mission_key==='tests')p=s.tests;if(m.mission_key==='battle')p=s.wins+s.losses+s.draws;if(m.mission_key==='revision')p=s.revision; p=clamp(p,0,m.target);if(p!==m.progress)await pool.query(`UPDATE nexus_daily_missions SET progress=$1,completed=$2 WHERE id=$3`,[p,p>=m.target,m.id]);}
  return (await pool.query(`SELECT * FROM nexus_daily_missions WHERE user_id=$1 AND mission_date=$2 ORDER BY id`,[id,d])).rows;
}

export function attachNexusV53Routes(app,pool,auth,admin){
  app.get('/api/v53/dashboard',auth,async(req,res)=>{try{const s=await stats(pool,req.user.id);s.streak=req.user.streak_days||0;const ts=titles(s),el=elite(s),ms=await missions(pool,req.user.id);let weak=[];try{weak=(await pool.query(`SELECT COALESCE(q.subject,'General Studies') subject,ROUND(AVG(CASE WHEN qa.is_correct THEN 100 ELSE 0 END),1) accuracy,COUNT(*)::int attempts FROM question_attempts qa LEFT JOIN questions q ON q.id=qa.question_id WHERE qa.user_id=$1 GROUP BY q.subject HAVING COUNT(*)>=3 ORDER BY accuracy ASC LIMIT 5`,[req.user.id])).rows}catch{}res.json({stats:s,titles:ts.slice(-8).reverse(),elite:el,missions:ms,weak,season:(await pool.query(`SELECT id,name,starts_at,ends_at FROM nexus_seasons WHERE active=true ORDER BY starts_at DESC LIMIT 1`)).rows[0]||null});}catch(e){res.status(500).json({error:e.message})}});

  app.get('/api/v53/intelligence',auth,async(req,res)=>{try{const s=await stats(pool,req.user.id);const weak=(await pool.query(`SELECT COALESCE(q.subject,'General Studies') subject,COUNT(*)::int attempts,ROUND(AVG(CASE WHEN qa.is_correct THEN 100 ELSE 0 END),1) accuracy FROM question_attempts qa LEFT JOIN questions q ON q.id=qa.question_id WHERE qa.user_id=$1 GROUP BY q.subject HAVING COUNT(*)>=2 ORDER BY accuracy ASC,attempts DESC LIMIT 6`,[req.user.id])).rows;let recommendation='Start with a 25-question mixed diagnostic.';if(weak[0])recommendation=`Focus on ${weak[0].subject}: your recorded accuracy is ${weak[0].accuracy}%. Do 25 targeted questions, then revise mistakes.`;else if(Number(s.accuracy)<70)recommendation='Prioritise accuracy: do 25-question Practice Mode sets and review every wrong answer.';else if(s.streak<7)recommendation='Build consistency: complete today’s missions and a short revision set.';else recommendation='You are progressing well. Take a 50-question mixed set and one ranked battle today.';res.json({recommendation,weak,stats:s});}catch(e){res.status(500).json({error:e.message})}});

  app.get('/api/v53/report',auth,async(req,res)=>{const s=await stats(pool,req.user.id);const days=Number(req.query.days||30);const trend=(await pool.query(`SELECT DATE(submitted_at) day,COUNT(*)::int tests,SUM(total_questions)::int questions,ROUND(AVG(accuracy),1) accuracy FROM test_attempts WHERE user_id=$1 AND submitted_at>=NOW()-$2::interval GROUP BY DATE(submitted_at) ORDER BY day`,[req.user.id,`${days} days`])).rows;res.json({stats:s,trend,generated_at:new Date().toISOString()})});

  app.get('/api/v53/missions',auth,async(req,res)=>res.json({missions:await missions(pool,req.user.id)}));
  app.get('/api/v53/titles',auth,async(req,res)=>{const s=await stats(pool,req.user.id);s.streak=req.user.streak_days||0;res.json({stats:s,titles:titles(s),elite:elite(s)})});

  app.get('/api/v53/battle/profile',auth,async(req,res)=>{await ensureProfile(pool,req.user.id);const p=(await pool.query('SELECT * FROM battle_profiles WHERE user_id=$1',[req.user.id])).rows[0];const season=(await pool.query(`SELECT * FROM nexus_seasons WHERE active=true ORDER BY starts_at DESC LIMIT 1`)).rows[0];res.json({profile:p,season})});
  app.get('/api/v53/battle/leaderboard',auth,async(req,res)=>{const rows=(await pool.query(`SELECT u.id,u.name,u.student_code,b.rating,b.wins,b.losses,b.draws,b.current_streak,b.best_streak FROM battle_profiles b JOIN users u ON u.id=b.user_id WHERE u.role='student' AND u.status='active' ORDER BY b.rating DESC,b.wins DESC LIMIT 100`)).rows;res.json({leaders:rows.map((x,i)=>({...x,rank:i+1}))})});
  app.get('/api/v53/leaderboards',auth,async(req,res)=>{const scope=['effort','mastery','battle','consistency','all'].includes(req.query.scope)?req.query.scope:'all';let rows;if(scope==='battle')rows=(await pool.query(`SELECT u.name,u.student_code,b.rating,b.wins,b.current_streak FROM battle_profiles b JOIN users u ON u.id=b.user_id WHERE u.role='student' AND u.status='active' ORDER BY b.rating DESC,b.wins DESC LIMIT 100`)).rows;else if(scope==='mastery')rows=(await pool.query(`SELECT u.name,u.student_code,ROUND(AVG(a.accuracy),1)::numeric accuracy,SUM(a.total_questions)::int questions FROM users u JOIN test_attempts a ON a.user_id=u.id WHERE u.role='student' AND u.status='active' GROUP BY u.id ORDER BY accuracy DESC,questions DESC LIMIT 100`)).rows;else if(scope==='consistency')rows=(await pool.query(`SELECT name,student_code,streak_days FROM users WHERE role='student' AND status='active' ORDER BY streak_days DESC,xp DESC LIMIT 100`)).rows;else rows=(await pool.query(`SELECT name,student_code,xp,level,streak_days FROM users WHERE role='student' AND status='active' ORDER BY xp DESC,level DESC LIMIT 100`)).rows;res.json({scope,leaders:rows.map((x,i)=>({...x,rank:i+1}))})});

  app.get('/api/v53/community',auth,async(req,res)=>{const cat=String(req.query.category||'').trim();const p=[req.user.id];let where=`p.status='visible'`;if(cat){p.push(cat);where+=` AND p.post_type=$${p.length}`}const rows=(await pool.query(`SELECT p.*,u.name,u.student_code,COALESCE((SELECT COUNT(*) FROM community_reactions r WHERE r.post_id=p.id),0)::int likes,EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id=p.id AND r.user_id=$1) liked,(SELECT COUNT(*) FROM community_comments c WHERE c.post_id=p.id)::int comments FROM community_posts p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.pinned DESC,p.created_at DESC LIMIT 50`,p)).rows;res.json({posts:rows})});
  app.post('/api/v53/community',auth,async(req,res)=>{const b=req.body||{};const body=String(b.body||'').trim();if(!body)return res.status(400).json({error:'Post body is required'});const q=await pool.query(`INSERT INTO community_posts(user_id,post_type,title,body,image_url,poll) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.id,String(b.post_type||'discussion'),b.title||null,body,b.image_url||null,b.poll?JSON.stringify(b.poll):null]);res.status(201).json({post:q.rows[0]})});
  app.get('/api/v53/community/:id',auth,async(req,res)=>{const post=(await pool.query(`SELECT p.*,u.name,u.student_code FROM community_posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id])).rows[0];if(!post)return res.status(404).json({error:'Post not found'});const comments=(await pool.query(`SELECT c.*,u.name,u.student_code FROM community_comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=$1 ORDER BY c.verified DESC,c.created_at ASC`,[req.params.id])).rows;res.json({post,comments})});
  app.post('/api/v53/community/:id/comments',auth,async(req,res)=>{const body=String(req.body?.body||'').trim();if(!body)return res.status(400).json({error:'Comment is required'});const q=await pool.query(`INSERT INTO community_comments(post_id,user_id,body) VALUES($1,$2,$3) RETURNING *`,[req.params.id,req.user.id,body]);res.status(201).json({comment:q.rows[0]})});
  app.post('/api/v53/community/:id/react',auth,async(req,res)=>{await pool.query(`INSERT INTO community_reactions(post_id,user_id,reaction) VALUES($1,$2,'like') ON CONFLICT(post_id,user_id) DO DELETE`,[req.params.id,req.user.id]);res.json({ok:true})});
  app.post('/api/v53/community/report',auth,async(req,res)=>{const b=req.body||{};if(!b.reason)return res.status(400).json({error:'Reason required'});await pool.query(`INSERT INTO community_reports(post_id,comment_id,reporter_id,reason) VALUES($1,$2,$3,$4)`,[b.post_id||null,b.comment_id||null,req.user.id,String(b.reason).slice(0,500)]);res.json({ok:true})});

  app.get('/api/admin/v53/community/reports',auth,admin,async(_req,res)=>{res.json({reports:(await pool.query(`SELECT r.*,u.name reporter,p.body FROM community_reports r JOIN users u ON u.id=r.reporter_id LEFT JOIN community_posts p ON p.id=r.post_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 200`)).rows})});
  app.patch('/api/admin/v53/community/posts/:id',auth,admin,async(req,res)=>{const b=req.body||{};const q=await pool.query(`UPDATE community_posts SET status=COALESCE($1,status),pinned=COALESCE($2,pinned),locked=COALESCE($3,locked),updated_at=NOW() WHERE id=$4 RETURNING *`,[b.status??null,b.pinned??null,b.locked??null,req.params.id]);res.json({post:q.rows[0]})});
  app.patch('/api/admin/v53/community/reports/:id',auth,admin,async(req,res)=>{await pool.query(`UPDATE community_reports SET status=$1 WHERE id=$2`,[String(req.body?.status||'resolved'),req.params.id]);res.json({ok:true})});
  app.get('/api/admin/v53/students',auth,admin,async(_req,res)=>{const rows=(await pool.query(`SELECT u.id,u.student_code,u.name,u.username,u.xp,u.level,u.streak_days,u.status,COALESCE(SUM(a.total_questions),0)::int questions,ROUND(COALESCE(AVG(a.accuracy),0),1)::numeric accuracy,COALESCE(b.rating,1000)::int battle_rating,COALESCE(b.wins,0)::int battle_wins FROM users u LEFT JOIN test_attempts a ON a.user_id=u.id LEFT JOIN battle_profiles b ON b.user_id=u.id WHERE u.role='student' GROUP BY u.id,b.rating,b.wins ORDER BY u.xp DESC LIMIT 500`)).rows;res.json({students:rows})});
}

export async function updateBattleRating(pool,userId,opponentId,result){
  await ensureProfile(pool,userId);await ensureProfile(pool,opponentId);
  const rows=await pool.query(`SELECT user_id,rating FROM battle_profiles WHERE user_id=ANY($1::uuid[]) FOR UPDATE`,[[userId,opponentId]]);
  const me=rows.rows.find(x=>x.user_id===userId),op=rows.rows.find(x=>x.user_id===opponentId);if(!me||!op)return;
  const expected=1/(1+10**((Number(op.rating)-Number(me.rating))/400));const k=32;const nr=Math.round(Number(me.rating)+k*(result-expected));await pool.query(`UPDATE battle_profiles SET rating=$1,updated_at=NOW() WHERE user_id=$2`,[nr,userId]);
}
