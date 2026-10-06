import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import crypto from 'node:crypto';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import fs from 'node:fs';
import path from 'node:path';
import { attachNexusV53Routes, ensureNexusV53 } from './nexus-v53-addon.mjs';
import { fileURLToPath } from 'node:url';
const {Pool}=pg;
const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const pool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c client_encoding=UTF8',ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
const JWT_SECRET=process.env.JWT_SECRET;if(!JWT_SECRET)throw new Error('JWT_SECRET is required');
app.set('trust proxy', 1);
app.use(express.json({limit:'50mb'}));app.use(cookieParser());app.use('/api',(req,res,next)=>{const json=res.json.bind(res);res.json=(body)=>{res.setHeader('Content-Type','application/json; charset=utf-8');return json(body)};next()});

function sign(u){return jwt.sign({sub:u.id},JWT_SECRET,{expiresIn:'30d'})}
const COOKIE_OPTS={httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:30*24*60*60*1000,path:'/'};
function setAuth(res,u){const token=sign(u);res.cookie('nexus_session',token,COOKIE_OPTS);res.cookie('bpn_session',token,COOKIE_OPTS)}
function clearAuth(res){for(const name of ['nexus_session','dhyeya_session','bpn_session'])res.clearCookie(name,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/'})}
function publicUser(u){return {id:u.id,student_code:u.student_code,email:u.email,name:u.name,username:u.username,avatar_url:u.avatar_url,role:u.role,status:u.status,target_exam:u.target_exam,exam_date:u.exam_date,daily_target:u.daily_target,xp:u.xp,level:u.level,streak_days:u.streak_days,last_activity_date:u.last_activity_date,last_login_at:u.last_login_at,preferences:u.preferences,bio:u.bio,target_attempt:u.target_attempt,language:u.language,notification_preferences:u.notification_preferences,created_at:u.created_at}}
async function auth(req,res,next){try{const t=req.cookies.nexus_session||req.cookies.dhyeya_session||req.cookies.bpn_session;if(!t)return res.status(401).json({error:'Authentication required'});const d=jwt.verify(t,JWT_SECRET);const q=await pool.query('SELECT * FROM users WHERE id=$1',[d.sub]);const u=q.rows[0];if(!u)return res.status(401).json({error:'Session expired'});if(u.status!=='active')return res.status(403).json({error:'Account is '+u.status});req.user=u; const ignored=['/auth/me','/presence/heartbeat','/notifications']; if(!ignored.includes(req.path))audit(req.user,`activity:${req.method} ${req.path}`,req.user.id,{ip:req.ip,user_agent:req.get('user-agent')||null}); next()}catch{return res.status(401).json({error:'Invalid session'})}}
function admin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Admin access required'});next()}
function auditActivity(req,res,next){if(req.user&&req.method!=='GET'&&req.path!=='/auth/logout'&&req.path!=='/auth/change-password')audit(req.user,`activity:${req.method} ${req.path}`,req.user.id,{});next()}
async function hasValidSession(req){try{const t=req.cookies.nexus_session||req.cookies.dhyeya_session||req.cookies.bpn_session;if(!t)return false;const d=jwt.verify(t,JWT_SECRET);const q=await pool.query('SELECT status FROM users WHERE id=$1',[d.sub]);return q.rows[0]?.status==='active'}catch{return false}}
app.get('/',async(req,res)=>{
  res.set('Cache-Control','no-store');
  return res.sendFile(path.join(__dirname,'index.html'));
});
app.get('/admin',auth,admin,(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.get('/student',auth,(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'index.html'));});
app.get('/index.html',(req,res)=>{res.set('Cache-Control','no-store');res.sendFile(path.join(__dirname,'index.html'));});
app.use(express.static(__dirname,{index:false,setHeaders:(res,file)=>{if(/\.(html|js)$/.test(file))res.setHeader('Cache-Control','no-store')}}));

async function audit(actor,action,target,details={}){try{await pool.query('INSERT INTO audit_logs(actor_user_id,action,target_user_id,details) VALUES($1,$2,$3,$4)',[actor?.id||null,action,target||null,JSON.stringify(details||{})])}catch(e){console.error('audit',e.message)}}
function makeStudentCode(){return 'DHY-'+new Date().getFullYear().toString().slice(-2)+'-'+crypto.randomBytes(3).toString('hex').toUpperCase()}
function makePassword(){return crypto.randomBytes(5).toString('base64url')+'@1'}
async function bootstrapAdmin(){if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)return;const email=process.env.ADMIN_EMAIL.trim().toLowerCase();const found=await pool.query('SELECT id FROM users WHERE email=$1',[email]);if(found.rows[0]){await pool.query("UPDATE users SET role='admin',status='active' WHERE email=$1",[email]);return}const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);await pool.query("INSERT INTO users(student_code,email,password_hash,name,username,role,status) VALUES($1,$2,$3,$4,$5,'admin','active')",[makeStudentCode(),email,hash,process.env.ADMIN_NAME||'BPSC Nexus Admin',process.env.ADMIN_USERNAME||'admin']);console.log('Initial admin created:',email)}

app.get('/api/health',async(_req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,database:true})}catch(e){res.status(503).json({ok:false,database:false,error:e.message})}});

app.post('/api/auth/register',async(req,res)=>{if(process.env.ALLOW_SELF_REGISTER!=='true')return res.status(403).json({error:'Student accounts are created by BPSC Nexus Admin. Please use your Student ID and password.'});const {email,password,name,username}=req.body||{};if(!email||!password||!name)return res.status(400).json({error:'Name, email and password are required'});if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});try{const hash=await bcrypt.hash(password,12);const code=makeStudentCode();const q=await pool.query(`INSERT INTO users(student_code,email,password_hash,name,username) VALUES($1,$2,$3,$4,$5) RETURNING *`,[code,email.trim().toLowerCase(),hash,name.trim(),username?.trim()||null]);setAuth(res,q.rows[0]);res.status(201).json({user:publicUser(q.rows[0])})}catch(e){res.status(409).json({error:e.code==='23505'?'Email, username or student ID already exists':'Could not create account'})}});
app.post('/api/auth/login',async(req,res)=>{const {identifier,password}=req.body||{};const login=String(identifier||req.body?.email||'').trim();if(!login||!password)return res.status(400).json({error:'User ID/email/username and password are required'});try{const q=await pool.query(`SELECT * FROM users WHERE lower(coalesce(email,''))=lower($1) OR lower(coalesce(username,''))=lower($1) OR lower(coalesce(student_code,''))=lower($1) LIMIT 1`,[login]);const u=q.rows[0];if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Invalid credentials'});if(u.status!=='active')return res.status(403).json({error:'Account is '+u.status});await pool.query('UPDATE users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1',[u.id]);setAuth(res,u);await audit(u,'login',u.id,{role:u.role});res.set('Cache-Control','no-store');res.json({user:publicUser({...u,last_login_at:new Date().toISOString()})})}catch(e){console.error('login',e);res.status(500).json({error:'Login service temporarily unavailable'})}});
app.post('/api/auth/logout',(req,res)=>{clearAuth(res);res.json({ok:true})});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:publicUser(req.user)}));
app.post('/api/auth/change-password',auth,async(req,res)=>{const current=String(req.body?.current_password||'');const next=String(req.body?.new_password||'');if(next.length<8)return res.status(400).json({error:'New password must be at least 8 characters'});if(current===next)return res.status(400).json({error:'New password must differ from current password'});try{const ok=await bcrypt.compare(current,req.user.password_hash);if(!ok)return res.status(401).json({error:'Current password is incorrect'});const hash=await bcrypt.hash(next,12);await pool.query('UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2',[hash,req.user.id]);await audit(req.user,'change_own_password',req.user.id,{});res.json({ok:true})}catch(e){res.status(500).json({error:'Could not change password'})}});
app.post('/api/presence/heartbeat',auth,async(req,res)=>{await pool.query(`INSERT INTO user_presence(user_id,last_seen_at) VALUES($1,NOW()) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=NOW()`,[req.user.id]);res.json({ok:true})});
app.post('/api/activity/quiz-complete',auth,async(req,res)=>{if(req.user.role!=='student')return res.status(403).json({error:'Student activity only'});const b=req.body||{};const total=Math.min(500,Math.max(0,Number(b.total||0))),correct=Math.min(total,Math.max(0,Number(b.correct||0))),incorrect=Math.min(total-correct,Math.max(0,Number(b.incorrect||0))),unattempted=Math.max(0,total-correct-incorrect),accuracy=total?correct/total*100:0,score=Number(b.score??correct);const sourceId=String(b.attempt_id||crypto.randomUUID()).slice(0,120);try{const dup=await pool.query("SELECT id FROM test_attempts WHERE test_id=$1 AND user_id=$2 LIMIT 1",[sourceId,req.user.id]);if(dup.rows[0])return res.json({ok:true,duplicate:true});const q=await pool.query(`INSERT INTO test_attempts(user_id,test_id,mode,score,total_questions,correct,incorrect,unattempted,accuracy,time_taken_seconds,submitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id`,[req.user.id,sourceId,String(b.mode||'practice')==='exam'?'exam':'practice',score,total,correct,incorrect,unattempted,accuracy,Math.max(0,Number(b.time_taken_seconds||0))]);const xp=Math.min(250,10+correct*2+(accuracy>=80?25:0));await pool.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'quiz',$2,$3)`,[req.user.id,q.rows[0].id,xp]);await pool.query(`UPDATE users SET xp=xp+$1,level=GREATEST(1,((xp+$1)/500)::int+1),streak_days=CASE WHEN last_activity_date=CURRENT_DATE THEN streak_days WHEN last_activity_date=CURRENT_DATE-1 THEN streak_days+1 ELSE 1 END,last_activity_date=CURRENT_DATE,updated_at=NOW() WHERE id=$2`,[xp,req.user.id]);res.json({ok:true,attempt_id:q.rows[0].id,xp_awarded:xp})}catch(e){res.status(400).json({error:'Could not record quiz activity.'})}});
app.get('/api/presence/online',auth,async(req,res)=>{const q=await pool.query(`SELECT u.id,u.name,u.username,u.student_code,u.xp,u.level,u.avatar_url FROM users u JOIN user_presence p ON p.user_id=u.id WHERE u.role='student' AND u.status='active' AND p.last_seen_at>NOW()-INTERVAL '45 seconds' AND u.id<>$1 ORDER BY p.last_seen_at DESC LIMIT 50`,[req.user.id]);res.json({users:q.rows})});

app.get('/api/notifications',auth,async(req,res)=>{const q=await pool.query(`SELECT n.id,n.title,n.message,n.type,n.link,n.created_at,r.read_at FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id WHERE r.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`,[req.user.id]);res.json({notifications:q.rows,unread:q.rows.filter(x=>!x.read_at).length})});
app.patch('/api/notifications/:id/read',auth,async(req,res)=>{await pool.query(`UPDATE notification_recipients SET read_at=COALESCE(read_at,NOW()) WHERE notification_id=$1 AND user_id=$2`,[req.params.id,req.user.id]);res.json({ok:true})});

app.patch('/api/profile',auth,async(req,res)=>{const allowed=['name','username','avatar_url','bio','target_exam','target_attempt','exam_date','daily_target','language','notification_preferences','preferences'];const data=Object.fromEntries(Object.entries(req.body||{}).filter(([k])=>allowed.includes(k)));if(data.name!==undefined&&!String(data.name).trim())return res.status(400).json({error:'Name cannot be empty'});if(data.avatar_url!==undefined&&data.avatar_url!==null){const a=String(data.avatar_url);if(!/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(a)&&!/^https?:\/\//.test(a))return res.status(400).json({error:'Invalid profile image'});if(a.length>1600000)return res.status(413).json({error:'Profile image is too large. Use an image under 1 MB.'})}if(data.daily_target!==undefined)data.daily_target=Math.min(1000,Math.max(1,Number(data.daily_target)||100));const keys=Object.keys(data);if(!keys.length)return res.json({user:publicUser(req.user)});const sets=[],vals=[];keys.forEach((k,i)=>{sets.push(`${k}=$${i+1}`);vals.push(data[k])});vals.push(req.user.id);try{const q=await pool.query(`UPDATE users SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,vals);res.json({user:publicUser(q.rows[0])})}catch(e){res.status(409).json({error:e.code==='23505'?'Username already exists':'Profile update failed'})}});

// Planner
app.get('/api/planner',auth,async(req,res)=>{const date=req.query.date;const p=[req.user.id];let s='SELECT * FROM planner_tasks WHERE user_id=$1';if(date){p.push(date);s+=' AND task_date=$2'}s+=' ORDER BY task_date,priority DESC,created_at';res.json({tasks:(await pool.query(s,p)).rows})});
app.post('/api/planner',auth,async(req,res)=>{const {task_date,title,subject,target,priority}=req.body||{};if(!task_date||!title)return res.status(400).json({error:'Date and title are required'});const q=await pool.query(`INSERT INTO planner_tasks(user_id,task_date,title,subject,target,priority) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.user.id,task_date,title,subject||null,target??null,priority||'normal']);res.status(201).json({task:q.rows[0]})});
app.patch('/api/planner/:id',auth,async(req,res)=>{const {completed,title,subject,target,priority,task_date}=req.body||{};const before=(await pool.query('SELECT completed FROM planner_tasks WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];const q=await pool.query(`UPDATE planner_tasks SET completed=COALESCE($1,completed),title=COALESCE($2,title),subject=COALESCE($3,subject),target=COALESCE($4,target),priority=COALESCE($5,priority),task_date=COALESCE($6,task_date),completed_at=CASE WHEN COALESCE($1,completed)=TRUE THEN COALESCE(completed_at,NOW()) ELSE NULL END,updated_at=NOW() WHERE id=$7 AND user_id=$8 RETURNING *`,[completed??null,title??null,subject??null,target??null,priority??null,task_date??null,req.params.id,req.user.id]);if(!q.rows[0])return res.status(404).json({error:'Task not found'});if(!before?.completed&&q.rows[0].completed){await pool.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'planner',$2,10)`,[req.user.id,req.params.id]);await pool.query(`UPDATE users SET xp=xp+10,level=GREATEST(1,((xp+10)/500)::int+1),streak_days=CASE WHEN last_activity_date=CURRENT_DATE THEN streak_days WHEN last_activity_date=CURRENT_DATE-1 THEN streak_days+1 ELSE 1 END,last_activity_date=CURRENT_DATE,updated_at=NOW() WHERE id=$1`,[req.user.id]);}res.json({task:q.rows[0]})});
app.delete('/api/planner/:id',auth,async(req,res)=>{const r=await pool.query('DELETE FROM planner_tasks WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id]);res.json({deleted:r.rowCount===1})});

// Test library + engine
app.get('/api/tests',auth,async(req,res)=>{const p=[];let s='SELECT * FROM tests WHERE published=TRUE';if(req.query.institution){p.push(req.query.institution);s+=' AND lower(institution)=lower($1)'}s+=' ORDER BY COALESCE(year,0) DESC,COALESCE(sequence_no,999999) ASC,title';res.json({tests:(await pool.query(s,p)).rows})});
app.get('/api/tests/:id/questions',auth,async(req,res)=>{
  const q=await pool.query(`SELECT q.*,t.title test_title,t.duration_seconds FROM test_questions tq JOIN questions q ON q.id=tq.question_id JOIN tests t ON t.id=tq.test_id WHERE tq.test_id=$1 AND t.published=TRUE ORDER BY tq.sort_order`,[req.params.id]);
  const questions=q.rows;
  res.json({test:q.rows[0]?{id:req.params.id,title:q.rows[0].test_title,duration_seconds:q.rows[0].duration_seconds}:null,questions});
});
app.get('/api/pyq/archive',auth,async(_req,res)=>{const q=await pool.query(`WITH subject_map(subject,sort_order) AS (VALUES ('General Science',1),('Bihar Special',2),('Modern Indian History',3),('Ancient Indian History',4),('Medieval Indian History',5),('Indian Polity',6),('Geography',7),('Indian Economy',8)), paper_subjects AS (SELECT tq.test_id,sm.subject,sm.sort_order,COUNT(tq.question_id)::int AS count FROM subject_map sm JOIN test_questions tq ON TRUE JOIN questions q ON q.id=tq.question_id WHERE CASE sm.subject WHEN 'General Science' THEN lower(trim(coalesce(q.subject,''))) IN ('general science','science','general science & technology','science & technology','science and technology') WHEN 'Bihar Special' THEN lower(trim(coalesce(q.subject,''))) IN ('bihar special','bihar') WHEN 'Modern Indian History' THEN lower(trim(coalesce(q.subject,''))) IN ('modern indian history','modern history') WHEN 'Ancient Indian History' THEN lower(trim(coalesce(q.subject,''))) IN ('ancient indian history','ancient history') WHEN 'Medieval Indian History' THEN lower(trim(coalesce(q.subject,''))) IN ('medieval indian history','medieval history') WHEN 'Indian Polity' THEN lower(trim(coalesce(q.subject,''))) IN ('indian polity','polity') WHEN 'Geography' THEN lower(trim(coalesce(q.subject,''))) IN ('geography','indian geography') WHEN 'Indian Economy' THEN lower(trim(coalesce(q.subject,''))) IN ('indian economy','economy','indian economics') END GROUP BY tq.test_id,sm.subject,sm.sort_order) SELECT t.id,t.title,t.institution,t.category,t.year,t.sequence_no,t.duration_seconds,t.question_count,t.published,COALESCE((SELECT json_agg(json_build_object('subject',sm.subject,'count',COALESCE(ps.count,0)) ORDER BY sm.sort_order) FROM subject_map sm LEFT JOIN paper_subjects ps ON ps.test_id=t.id AND ps.subject=sm.subject),'[]'::json) AS subjects,COALESCE((SELECT SUM(COALESCE(ps.count,0)) FROM paper_subjects ps WHERE ps.test_id=t.id),0)::int AS mapped_subject_count FROM tests t WHERE t.published=TRUE AND (lower(coalesce(t.category,''))='bpsc pyq archive' OR (lower(coalesce(t.institution,''))='bpsc' AND lower(coalesce(t.title,'')) LIKE '%pyq%')) ORDER BY COALESCE(t.year,0) DESC,COALESCE(t.sequence_no,999999) ASC,t.title`);res.json({tests:q.rows})});
app.post('/api/attempts',auth,async(req,res)=>{const x=req.body||{};const total=Number(x.total_questions||0),correct=Number(x.correct||0),incorrect=Number(x.incorrect||0),unattempted=Number(x.unattempted??Math.max(0,total-correct-incorrect));const accuracy=total?Number(((correct/total)*100).toFixed(2)):0;const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query(`INSERT INTO test_attempts(user_id,test_id,mode,score,total_questions,correct,incorrect,unattempted,accuracy,time_taken_seconds,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[req.user.id,x.test_id||'unknown',x.mode==='exam'?'exam':'practice',Number(x.score||0),total,correct,incorrect,unattempted,accuracy,Number(x.time_taken_seconds||0),x.started_at||null]);const attempt=q.rows[0];for(const qa of (Array.isArray(x.question_attempts)?x.question_attempts:[])){await client.query(`INSERT INTO question_attempts(user_id,attempt_id,question_id,selected_option,correct_option,is_correct,is_bookmarked,marked_for_review,time_spent_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[req.user.id,attempt.id,qa.question_id,qa.selected_option??null,qa.correct_option??null,qa.is_correct==null?null:!!qa.is_correct,!!qa.is_bookmarked,!!qa.marked_for_review,Number(qa.time_spent_seconds||0)]);if(qa.is_correct===false&&qa.question_id){await client.query(`INSERT INTO revision_items(user_id,question_id,source,reason,next_revision_date) VALUES($1,$2,$3,$4,CURRENT_DATE+1) ON CONFLICT(user_id,question_id) DO UPDATE SET reason='answered incorrectly',next_revision_date=CURRENT_DATE+1,updated_at=NOW()`,[req.user.id,qa.question_id,x.test_id||'test','answered incorrectly'])}}
const xp=Math.min(50,Math.max(10,Math.round(correct*2)));await client.query('INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,$2,$3,$4)',[req.user.id,'test_completed',attempt.id,xp]);const u=await client.query('UPDATE users SET xp=xp+$1,level=((xp+$1)/500)::int+1,last_activity_date=CURRENT_DATE,streak_days=CASE WHEN last_activity_date=CURRENT_DATE-1 THEN streak_days+1 WHEN last_activity_date=CURRENT_DATE THEN streak_days ELSE 1 END,updated_at=NOW() WHERE id=$2 RETURNING xp,level,streak_days',[xp,req.user.id]);await client.query("UPDATE quiz_sessions SET status='completed',updated_at=NOW() WHERE user_id=$1 AND status='in_progress' AND test_id=$2",[req.user.id,String(x.test_id||'')]);await client.query('COMMIT');res.status(201).json({attempt,awarded_xp:xp,student:u.rows[0]})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.get('/api/attempts',auth,async(req,res)=>{res.json({attempts:(await pool.query('SELECT * FROM test_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 100',[req.user.id])).rows})});
app.get('/api/performance',auth,async(req,res)=>{const a=(await pool.query('SELECT * FROM test_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 100',[req.user.id])).rows;const qa=(await pool.query(`SELECT q.subject,COUNT(*) total,SUM(CASE WHEN qa.is_correct THEN 1 ELSE 0 END) correct,AVG(qa.time_spent_seconds) avg_time FROM question_attempts qa LEFT JOIN questions q ON q.id=qa.question_id WHERE qa.user_id=$1 GROUP BY q.subject ORDER BY total DESC`,[req.user.id])).rows;res.json({attempts:a,subjects:qa})});
app.get('/api/revision',auth,async(req,res)=>{const q=await pool.query(`SELECT r.*,q.question_en,q.question_hi,q.subject,q.topic,q.options,q.answer,q.explanation_en,q.explanation_hi FROM revision_items r LEFT JOIN questions q ON q.id=r.question_id WHERE r.user_id=$1 ORDER BY r.next_revision_date NULLS LAST,r.updated_at DESC`,[req.user.id]);res.json({items:q.rows})});
app.get('/api/dashboard',auth,async(req,res)=>{try{
  const [attempts,progress,revision,tests]=await Promise.all([
    pool.query(`SELECT a.*,COALESCE(t.title,a.test_id) test_title FROM test_attempts a LEFT JOIN tests t ON t.id::text=a.test_id WHERE a.user_id=$1 ORDER BY a.submitted_at DESC LIMIT 10`,[req.user.id]),
    pool.query(`SELECT a.test_id,COALESCE(t.title,a.test_id) test_title,COUNT(*)::int attempts,MAX(a.score)::numeric best_score,MAX(a.submitted_at) last_attempt,MAX(a.total_questions)::int total_questions,MAX(a.correct)::int best_correct FROM test_attempts a LEFT JOIN tests t ON t.id::text=a.test_id WHERE a.user_id=$1 GROUP BY a.test_id,t.title ORDER BY MAX(a.submitted_at) DESC`,[req.user.id]),
    pool.query(`SELECT COUNT(*)::int count,COUNT(*) FILTER (WHERE next_revision_date<=CURRENT_DATE OR next_revision_date IS NULL)::int due FROM revision_items WHERE user_id=$1 AND revision_status='needs_revision'`,[req.user.id]),
    pool.query(`SELECT t.id,t.title,t.institution,t.category,t.year,t.duration_seconds,t.question_count,t.published,COALESCE((SELECT COUNT(*)::int FROM test_questions tq WHERE tq.test_id=t.id),0) mapped_count FROM tests t WHERE t.published=TRUE ORDER BY COALESCE(t.year,0) DESC,COALESCE(t.sequence_no,999999) ASC,t.title LIMIT 50`)
  ]);
  const totalAttempts=progress.rows.reduce((n,x)=>n+Number(x.attempts||0),0);
  const totalQuestions=attempts.rows.reduce((n,x)=>n+Number(x.total_questions||0),0);
  const correct=attempts.rows.reduce((n,x)=>n+Number(x.correct||0),0);
  const avgScore=attempts.rows.length?Number((attempts.rows.reduce((n,x)=>n+Number(x.score||0),0)/attempts.rows.length).toFixed(2)):0;
  const bestScore=attempts.rows.length?Math.max(...attempts.rows.map(x=>Number(x.score||0))):0;
  res.json({summary:{attempts:totalAttempts,questions:totalQuestions,accuracy:totalQuestions?Number((correct/totalQuestions*100).toFixed(1)):0,avg_score:avgScore,best_score:bestScore,revision_due:Number(revision.rows[0]?.due||0),revision_total:Number(revision.rows[0]?.count||0)},attempts:attempts.rows,progress:progress.rows,tests:tests.rows});
}catch(e){res.status(500).json({error:'Dashboard data unavailable'})}});

app.post('/api/revision/practice',auth,async(req,res)=>{try{
  const rows=(await pool.query(`SELECT q.* FROM revision_items r JOIN questions q ON q.id=r.question_id WHERE r.user_id=$1 AND r.revision_status='needs_revision' ORDER BY r.next_revision_date NULLS LAST,r.updated_at DESC LIMIT 50`,[req.user.id])).rows;
  if(!rows.length)return res.status(404).json({error:'No revision questions available.'});
  res.json({questions:rows});
}catch(e){res.status(500).json({error:'Could not start revision practice.'})}});

app.get('/api/support/tickets',auth,async(req,res)=>{try{
  const q=await pool.query(`SELECT t.id,t.subject,t.status,t.created_at,t.updated_at,t.last_message_at,(SELECT COUNT(*)::int FROM support_messages m WHERE m.thread_id=t.id) message_count,(SELECT message FROM support_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC LIMIT 1) last_message FROM support_threads t WHERE t.user_id=$1 ORDER BY t.updated_at DESC`,[req.user.id]);
  res.json({tickets:q.rows});
}catch(e){res.status(500).json({error:'Support inbox unavailable'})}});
app.get('/api/support/tickets/:id',auth,async(req,res)=>{try{const t=(await pool.query(`SELECT * FROM support_threads WHERE id=$1 AND user_id=$2`,[req.params.id,req.user.id])).rows[0];if(!t)return res.status(404).json({error:'Ticket not found'});const m=(await pool.query(`SELECT m.*,u.name sender_name FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,[t.id])).rows;await pool.query(`UPDATE support_messages SET read_at=COALESCE(read_at,NOW()) WHERE thread_id=$1 AND sender_role='admin' AND read_at IS NULL`,[t.id]);res.json({ticket:t,messages:m});}catch(e){res.status(500).json({error:'Support ticket unavailable'})}});
app.post('/api/support/tickets',auth,async(req,res)=>{const subject=String(req.body?.subject||'General Support').trim(),message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'Message is required'});const c=await pool.connect();try{await c.query('BEGIN');let t=(await c.query(`SELECT * FROM support_threads WHERE user_id=$1 FOR UPDATE`,[req.user.id])).rows[0];if(!t){t=(await c.query(`INSERT INTO support_threads(user_id,subject,status,last_message_at) VALUES($1,$2,'open',NOW()) RETURNING *`,[req.user.id,subject||'General Support'])).rows[0];}else{t=(await c.query(`UPDATE support_threads SET subject=COALESCE(NULLIF($2,''),subject),status='open',updated_at=NOW(),last_message_at=NOW() WHERE id=$1 RETURNING *`,[t.id,subject||'General Support'])).rows[0];}await c.query(`INSERT INTO support_messages(thread_id,sender_id,sender_role,message) VALUES($1,$2,'student',$3)`,[t.id,req.user.id,message]);await c.query('COMMIT');await audit(req.user,'support_ticket_create',req.user.id,{ticket_id:t.id});res.status(201).json({ticket:t});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:'Could not create support ticket.'})}finally{c.release()}});
app.post('/api/support/tickets/:id/messages',auth,async(req,res)=>{const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'Message is required'});const c=await pool.connect();try{await c.query('BEGIN');const t=(await c.query(`SELECT * FROM support_threads WHERE id=$1 AND user_id=$2 FOR UPDATE`,[req.params.id,req.user.id])).rows[0];if(!t){await c.query('ROLLBACK');return res.status(404).json({error:'Ticket not found'})}await c.query(`INSERT INTO support_messages(thread_id,sender_id,sender_role,message) VALUES($1,$2,'student',$3)`,[t.id,req.user.id,message]);await c.query(`UPDATE support_threads SET status='open',updated_at=NOW(),last_message_at=NOW() WHERE id=$1`,[t.id]);await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:'Could not send message.'})}finally{c.release()}});

app.get('/api/xp',auth,async(req,res)=>{res.json({xp:req.user.xp,level:req.user.level,ledger:(await pool.query('SELECT * FROM xp_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.user.id])).rows})});
app.get('/api/leaderboard',auth,async(req,res)=>{const scope=['daily','weekly','monthly','all'].includes(String(req.query.scope||'all'))?String(req.query.scope||'all'):'all';let leaders;if(scope==='all'){leaders=(await pool.query(`SELECT id,student_code,name,username,xp,level,streak_days FROM users WHERE role='student' AND status='active' ORDER BY xp DESC,level DESC,created_at ASC LIMIT 100`)).rows}else{const interval=scope==='daily'?'1 day':scope==='weekly'?'7 days':'30 days';leaders=(await pool.query(`SELECT u.id,u.student_code,u.name,u.username,u.level,u.streak_days,COALESCE(SUM(x.xp_amount),0)::int AS xp FROM users u LEFT JOIN xp_ledger x ON x.user_id=u.id AND x.created_at>=NOW()-$1::interval WHERE u.role='student' AND u.status='active' GROUP BY u.id ORDER BY xp DESC,u.level DESC,u.created_at ASC LIMIT 100`,[interval])).rows}res.json({scope,leaders:leaders.map((x,i)=>({...x,rank:i+1}))})});

// Persistent in-progress quiz sessions
app.get('/api/quiz-sessions/current',auth,async(req,res)=>{
  const q=await pool.query("SELECT * FROM quiz_sessions WHERE user_id=$1 AND status='in_progress' ORDER BY updated_at DESC LIMIT 1",[req.user.id]);
  res.json({session:q.rows[0]||null});
});
app.post('/api/quiz-sessions',auth,async(req,res)=>{
  const b=req.body||{}; if(!b.test_id||!b.mode||!b.state)return res.status(400).json({error:'test_id, mode and state are required'});
  const mode=b.mode==='exam'?'exam':'practice';
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query("UPDATE quiz_sessions SET status='abandoned',updated_at=NOW() WHERE user_id=$1 AND status='in_progress'",[req.user.id]);
    const q=await client.query(`INSERT INTO quiz_sessions(user_id,test_id,mode,state,started_at,last_saved_at,updated_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING *`,[req.user.id,String(b.test_id),mode,b.state,b.started_at||new Date().toISOString()]);
    await client.query('COMMIT'); res.status(201).json({session:q.rows[0]});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});
app.patch('/api/quiz-sessions/current',auth,async(req,res)=>{
  const b=req.body||{}; if(!b.state)return res.status(400).json({error:'state is required'});
  const q=await pool.query("UPDATE quiz_sessions SET state=$1,last_saved_at=NOW(),updated_at=NOW() WHERE user_id=$2 AND status='in_progress' RETURNING *",[b.state,req.user.id]);
  if(!q.rows[0])return res.status(404).json({error:'No active quiz session'}); res.json({session:q.rows[0]});
});
app.delete('/api/quiz-sessions/current',auth,async(req,res)=>{await pool.query("UPDATE quiz_sessions SET status='abandoned',updated_at=NOW() WHERE user_id=$1 AND status='in_progress'",[req.user.id]);res.json({ok:true})});

// Admin Question Bank import — ongoing content management without GitHub updates.
// IMPORTANT: source content is authoritative. We normalize only to Unicode NFC;
// we never attempt to "repair" or rewrite Hindi by guessing a character encoding.
function isUnpairedSurrogate(s){
  for(let i=0;i<s.length;i++){
    const c=s.charCodeAt(i);
    if(c>=0xD800&&c<=0xDBFF){const n=s.charCodeAt(i+1);if(!(n>=0xDC00&&n<=0xDFFF))return true;i++;}
    else if(c>=0xDC00&&c<=0xDFFF)return true;
  }
  return false;
}
function looksLikeMojibake(s){return /(?:Ã.|Â.|à¤|à¦|â€|ðŸ|Ð.|Ñ.)/.test(s)}
function normalizeSourceText(value,label,{allowNull=true}={}){
  if(value===undefined||value===null)return allowNull?null:'';
  const s=String(value).normalize('NFC');
  if(s.includes('\u0000'))throw new Error(`${label}: NUL character detected`);
  if(s.includes('\uFFFD'))throw new Error(`${label}: Unicode replacement character detected (�). Re-import the original UTF-8 source; content was not changed.`);
  if(isUnpairedSurrogate(s))throw new Error(`${label}: invalid Unicode surrogate detected`);
  if(looksLikeMojibake(s))throw new Error(`${label}: possible mojibake/incorrect character decoding detected. Re-import the original UTF-8 source.`);
  return s;
}
function splitImportedBilingual(value,label='text'){
  const s=normalizeSourceText(value,label,{allowNull:false});
  const i=s.search(/[\u0900-\u097F]/);
  return i>=0?{en:s.slice(0,i),hi:s.slice(i)}:{en:s,hi:''};
}
const BPSC_SUBJECTS=['General Science','Bihar Special','Modern Indian History','Ancient Indian History','Medieval Indian History','Indian Polity','Geography','Indian Economy'];

const AI_MODEL=process.env.GEMINI_MODEL||'gemini-3.5-flash-lite';
const AI_BATCH_SIZE=Math.max(5,Math.min(50,Number(process.env.AI_BATCH_SIZE||process.env.AI_BATCH_SIZE||50)));
const AI_MAX_RETRIES=Math.max(0,Math.min(8,Number(process.env.AI_MAX_RETRIES||process.env.AI_MAX_RETRIES||5)));
const AI_RETRY_BASE_MS=Math.max(250,Math.min(10000,Number(process.env.AI_RETRY_BASE_MS||process.env.AI_RETRY_BASE_MS||1000)));
const AI_RETRY_MAX_MS=Math.max(2000,Math.min(60000,Number(process.env.AI_RETRY_MAX_MS||process.env.AI_RETRY_MAX_MS||15000)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function geminiResponseText(d){return d?.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';}
function geminiFinishReason(d){return d?.candidates?.[0]?.finishReason||null;}
async function callGeminiJson({key,model,prompt,schema,temperature=0,maxOutputTokens=65536}){
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':key},
    body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature,maxOutputTokens,responseFormat:{text:{mimeType:'application/json',schema}}}})
  });
  if(!r.ok){const body=await r.text();const e=new Error(`Gemini service failed (${r.status}): ${body.slice(0,500)}`);e.status=r.status;throw e;}
  const d=await r.json(); const text=geminiResponseText(d);
  if(!text.trim()){const e=new Error(`Gemini returned no structured output (finishReason=${geminiFinishReason(d)||'unknown'}).`);e.code=geminiFinishReason(d)==='MAX_TOKENS'?'MODEL_TRUNCATED':'EMPTY_MODEL_OUTPUT';e.finishReason=geminiFinishReason(d);throw e;}
  return {data:d,text};
}

const classificationSchema={type:'array',items:{type:'object',properties:{id:{type:'string'},subject:{type:'string',enum:BPSC_SUBJECTS},confidence:{type:'number',minimum:0,maximum:1},reason:{type:'string'},answer_check:{type:'string',enum:['ok','review','no_answer']},answer_reason:{type:'string'},exam_year:{type:'integer'},exam_name:{type:'string'}},required:['id','subject','confidence','reason','answer_check','answer_reason']}};
async function classifyBpscBatch(batch){
  const key=String(process.env.GEMINI_API_KEY||'').trim();
  if(!key) throw new Error('BPSC smart classification requires GEMINI_API_KEY on the server.');
  const payload=batch.map(q=>({id:q.id,question_en:q.question_en||'',question_hi:q.question_hi||'',options:(q.options||[]).map(o=>typeof o==='object'?String(o.en??o.text??o.label??''):String(o)),source_subject:q.subject||null,topic:q.topic||null,answer:q.answer==null?null:Number(q.answer)}));
  const subjectDefinitions={
    'General Science':'Physics, chemistry, biology, human body, scientific principles, basic science and technology when the core concept is scientific.',
    'Bihar Special':'Bihar-specific history, geography, economy, polity, culture, personalities, institutions, schemes, rivers, districts, movements or other Bihar-only facts.',
    'Modern Indian History':'Indian history mainly from the 18th century/company rule through the freedom movement and independence.',
    'Ancient Indian History':'Prehistory, Indus Valley, Vedic age, Mahajanapadas, Buddhism/Jainism, Mauryas, Guptas and other ancient Indian periods/culture.',
    'Medieval Indian History':'Delhi Sultanate, regional medieval kingdoms, Vijayanagara/Bahmani, Mughals, Marathas, Bhakti-Sufi traditions and other medieval-period topics.',
    'Indian Polity':'Constitution, Articles, schedules, rights/duties, Parliament, President, judiciary, elections, constitutional/statutory bodies, federalism, local government and governance structure.',
    'Geography':'Physical, human, economic and Indian geography: landforms, climate, rivers, soils, resources, agriculture, population, maps and spatial relationships.',
    'Indian Economy':'Macroeconomics, banking, monetary/fiscal policy, taxation, budget, GDP, inflation, poverty, unemployment, public finance, external sector and Indian economic institutions.'
  };
  const prompt=`You are DHYEYA's BPSC PYQ subject-classification engine. Classify every supplied question into EXACTLY ONE of these eight subjects and never invent another label. Use the full question and options, not keywords alone. Bihar Special wins only when the question is specifically about Bihar; a question merely mentioning a Bihar example is not automatically Bihar Special. For history, identify the historical period rather than using a generic History label. If two subjects overlap, choose the subject that best matches the question's primary knowledge being tested. Do not solve the question. Return exactly one result per input id, preserving ids. confidence must be between 0 and 1. If uncertain, lower confidence rather than invent certainty. For answer_check, compare the supplied answer with the question/options only when an answer exists; never invent or change the answer. If the answer appears inconsistent, use review. Infer exam_year and exam_name only when explicitly supported by supplied metadata/source/text; otherwise omit them. Subject definitions: ${Object.entries(subjectDefinitions).map(([k,v])=>k+': '+v).join('\n')}\nINPUT JSON:\n${JSON.stringify(payload)}`;
  let lastError=null;
  for(let attempt=0;attempt<=AI_MAX_RETRIES;attempt++){
    try{
      const {text}=await callGeminiJson({key,model:AI_MODEL,prompt,schema:classificationSchema,temperature:0,maxOutputTokens:32768});
      let out;try{out=JSON.parse(text)}catch(e){const err=new Error('BPSC classification returned malformed JSON.');err.code='INVALID_MODEL_JSON';throw err;}
      if(!Array.isArray(out)||out.length!==batch.length)throw new Error(`BPSC classification returned ${Array.isArray(out)?out.length:0} items for ${batch.length} questions.`);
      const allowed=new Set(BPSC_SUBJECTS),byId=new Map(out.map(x=>[String(x.id),x]));
      return batch.map(q=>{
        const x=byId.get(String(q.id));
        if(!x||!allowed.has(String(x.subject))) throw new Error(`Invalid BPSC subject classification for ${q.id}.`);
        const confidence=Math.max(0,Math.min(1,Number(x.confidence)||0));
        return {...q,subject:String(x.subject),metadata:{...(q.metadata||{}),classification_engine:'gemini-review',classification_model:AI_MODEL,classification_confidence:confidence,classification_reason:String(x.reason||'').slice(0,300),classification_reviewed:false,answer_check:String(x.answer_check||'no_answer'),answer_check_reason:String(x.answer_reason||'').slice(0,300),detected_exam_year:Number(x.exam_year)||inferExamYear(q)||null,detected_exam_name:String(x.exam_name||inferExamName(q)||'').slice(0,100)}};
      });
    }catch(e){
      lastError=e;const retryable=[408,409,425,429,500,502,503,504].includes(e.status)||e.code==='EMPTY_MODEL_OUTPUT'||e.code==='MODEL_TRUNCATED'||e.code==='INVALID_MODEL_JSON';
      if(!retryable||attempt>=AI_MAX_RETRIES)throw e;
      await sleep(Math.min(AI_RETRY_MAX_MS,AI_RETRY_BASE_MS*Math.pow(2,attempt))+Math.floor(Math.random()*250));
    }
  }
  throw lastError||new Error('BPSC classification failed after retries.');
}

function bpscReviewRequired(testConfig){
  if(testConfig?.bpsc_review===true) return true;
  return isBpscPyqImport(testConfig);
}

function validateApprovedBpscSubjects(questions,testConfig){
  if(!bpscReviewRequired(testConfig)) return;
  const bad=questions.filter(q=>!BPSC_SUBJECTS.includes(String(q.subject||'')));
  if(bad.length) throw new Error(`${bad.length} BPSC question(s) do not have an approved subject. Review classification before importing.`);
}

function applyBpscClassification(questions,testConfig){
  if(!isBpscPyqImport(testConfig)) return {questions,classified:0};
  let classified=0;
  const out=questions.map(q=>{const subject=classifyBpscPyqSubject(q);if(q.subject!==subject){classified++;return {...q,subject,metadata:{...(q.metadata||{}),auto_subject:'BPSC PYQ classifier',auto_subject_version:'4.3.0'}}}return q;});
  return {questions:out,classified};
}

function containsDevanagari(value){return /[\u0900-\u097F]/.test(String(value??''));}
function assertEnglishOnly(value,label){if(value!==undefined&&value!==null&&containsDevanagari(value))throw new Error(`${label}: Hindi/Devanagari text is not allowed in admin uploads. Upload the English master question only.`);}
function normalizeImportedQuestion(q,index){
  const raw={...(q||{})};
  const rawQuestion=raw.question_en??raw.question??raw.questionText??'';
  assertEnglishOnly(rawQuestion,`Row ${index} question`);
  if(raw.question_hi!==undefined&&raw.question_hi!==null&&String(raw.question_hi).trim()!=='')throw new Error(`Row ${index}: Hindi question field is not accepted. Upload English only.`);
  const question_en=normalizeSourceText(rawQuestion,`Row ${index} question_en`,{allowNull:false});
  if(!question_en.trim())throw new Error(`Row ${index}: question_en/question is required`);

  let options=raw.options;
  if(typeof options==='string'){
    try{options=JSON.parse(options)}catch{options=options.split(/\s*\|\s*/)}
  }
  if(!Array.isArray(options))options=[raw.option_a,raw.option_b,raw.option_c,raw.option_d,raw.option_e].filter(x=>x!==undefined&&x!==null&&String(x).trim()!=='');
  options=options.map((x,i)=>{
    const label=`Row ${index} option ${String.fromCharCode(65+i)}`;
    if(x&&typeof x==='object'){
      if(x.hi!==undefined&&x.hi!==null&&String(x.hi).trim()!=='')throw new Error(`${label}: Hindi option field is not accepted. Upload English only.`);
      const en=normalizeSourceText(x.en??x.text??x.label??'',label,{allowNull:false});
      assertEnglishOnly(en,label); return en;
    }
    const en=normalizeSourceText(String(x??''),label,{allowNull:false}); assertEnglishOnly(en,label); return en;
  }).filter(x=>String(x||'').trim()!=='');
  if(options.length<2)throw new Error(`Row ${index}: at least 2 options are required`);

  let answer=raw.answer??raw.correct_answer??raw.correctOption;
  if(answer===undefined||answer===null||(typeof answer==='string'&&!answer.trim()))answer=null;
  else if(typeof answer==='string'){
    const a=answer.trim().toUpperCase();
    if(a==='*')answer=null;
    else if(/^[ABCDE]$/.test(a))answer={A:0,B:1,C:2,D:3,E:4}[a];
    else if(/^\d+$/.test(a))answer=Number(a);
    else throw new Error(`Row ${index}: answer must be A-E, *, null, or a valid option index`);
  }else if(typeof answer==='number')answer=Number(answer);
  else throw new Error(`Row ${index}: answer must be A-E, *, null, or a valid option index`);
  if(answer!==null&&(!Number.isInteger(answer)||answer<0||answer>=options.length))throw new Error(`Row ${index}: answer must be A-E, *, null, or a valid option index`);

  const fingerprint=crypto.createHash('sha256').update([question_en,JSON.stringify(options)].join('\n').trim().toLowerCase()).digest('hex').slice(0,24);
  const id=String(raw.id||`IMP-${fingerprint}`).trim();
  if(!id)throw new Error(`Row ${index}: id is required or must be generated`);
  const metadata={...(raw.metadata&&typeof raw.metadata==='object'?raw.metadata:{})};
  for(const key of ['category','source_exam','source_page','page','source_image','source_image_url'])if(raw[key]!==undefined)metadata[key]=raw[key];

  const rawExplanation=raw.explanation_en??raw.explanation??'';
  assertEnglishOnly(rawExplanation,`Row ${index} explanation`);
  if(raw.explanation_hi!==undefined&&raw.explanation_hi!==null&&String(raw.explanation_hi).trim()!=='')throw new Error(`Row ${index}: Hindi explanation field is not accepted. Upload English only.`);
  const explanation_en=rawExplanation?normalizeSourceText(rawExplanation,`Row ${index} explanation_en`):null;
  return {id,subject:raw.subject==null?null:normalizeSourceText(raw.subject,`Row ${index} subject`),topic:raw.topic==null?null:normalizeSourceText(raw.topic,`Row ${index} topic`),subtopic:raw.subtopic==null?null:normalizeSourceText(raw.subtopic,`Row ${index} subtopic`),year:raw.year?Number(raw.year):null,language:'english',question_en,question_hi:null,options,answer,explanation_en,explanation_hi:null,difficulty:raw.difficulty==null?null:normalizeSourceText(raw.difficulty,`Row ${index} difficulty`),source:raw.source==null?'Admin English Question Bank Import':normalizeSourceText(raw.source,`Row ${index} source`),metadata};
}
function normalizeImportBatch(input){
  const normalized=[],errors=[];const seen=new Set();
  for(let i=0;i<input.length;i++){
    try{
      const q=normalizeImportedQuestion(input[i],i+1);
      if(seen.has(q.id))throw new Error(`Duplicate question ID in upload: ${q.id}`);
      seen.add(q.id);normalized.push(q);
    }catch(e){errors.push({row:i+1,error:e.message||'Invalid question'});}
  }
  return {normalized,errors};
}
async function importQuestionsToDb(questions,testConfig=null,actor=null){
  await validateApprovedBpscSubjects(questions,testConfig);
  const classified=0;
  const subject_counts=Object.fromEntries(BPSC_SUBJECTS.map(s=>[s,questions.filter(q=>q.subject===s).length]));
  const client=await pool.connect(); let inserted=0,updated=0,testId=null,mapped=0;
  try{
    await client.query('BEGIN');
    if(questions.length){
      const ids=questions.map(q=>q.id);
      const existingRows=await client.query('SELECT id FROM questions WHERE id = ANY($1::text[])',[ids]);
      const existing=new Set(existingRows.rows.map(r=>r.id));
      const values=[]; const params=[];
      for(let i=0;i<questions.length;i++){
        const q=questions[i], base=i*15;
        values.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15})`);
        params.push(q.id,q.subject,q.topic,q.subtopic,q.year,q.language,q.question_en,q.question_hi,JSON.stringify(q.options||[]),q.answer,q.explanation_en,q.explanation_hi,q.difficulty,q.source,JSON.stringify(q.metadata||{}));
        if(existing.has(q.id)) updated++; else inserted++;
      }
      await client.query(`INSERT INTO questions(id,subject,topic,subtopic,year,language,question_en,question_hi,options,answer,explanation_en,explanation_hi,difficulty,source,metadata)
        VALUES ${values.join(',')}
        ON CONFLICT(id) DO UPDATE SET subject=EXCLUDED.subject,topic=EXCLUDED.topic,subtopic=EXCLUDED.subtopic,year=EXCLUDED.year,language=EXCLUDED.language,question_en=EXCLUDED.question_en,question_hi=EXCLUDED.question_hi,options=EXCLUDED.options,answer=EXCLUDED.answer,explanation_en=EXCLUDED.explanation_en,explanation_hi=EXCLUDED.explanation_hi,difficulty=EXCLUDED.difficulty,source=EXCLUDED.source,metadata=EXCLUDED.metadata,updated_at=NOW()`,params);
    }
    if(testConfig?.test_id || testConfig?.title){
      if(testConfig?.test_id){
        const existingTest=await client.query('SELECT id FROM tests WHERE id=$1',[String(testConfig.test_id)]);
        if(!existingTest.rows[0]) throw new Error('Test not found for question mapping.');
        testId=existingTest.rows[0].id;
      }else{
        const title=String(testConfig.title).trim();
        const slug=String(testConfig.slug||title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')).slice(0,180);
        const t=await client.query(`INSERT INTO tests(slug,title,institution,category,year,sequence_no,access_type,duration_seconds,published,question_count,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10)
          ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,institution=EXCLUDED.institution,category=EXCLUDED.category,year=EXCLUDED.year,sequence_no=EXCLUDED.sequence_no,access_type=EXCLUDED.access_type,duration_seconds=EXCLUDED.duration_seconds,published=EXCLUDED.published,metadata=EXCLUDED.metadata,updated_at=NOW()
          RETURNING id`,[slug,title,testConfig.institution||null,testConfig.category||null,testConfig.year?Number(testConfig.year):null,testConfig.sequence_no?Number(testConfig.sequence_no):null,testConfig.access_type||'premium',Number(testConfig.duration_seconds||7200),testConfig.published!==false,JSON.stringify({created_via:'admin_question_bank'})]);
        testId=t.rows[0].id;
      }
      const offset=Math.max(0,Number(testConfig.sort_offset||0));
      for(let i=0;i<questions.length;i++){
        await client.query(`INSERT INTO test_questions(test_id,question_id,sort_order) VALUES($1,$2,$3) ON CONFLICT(test_id,question_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`,[testId,questions[i].id,offset+i+1]);
        mapped++;
      }
      await client.query(`UPDATE tests SET question_count=(SELECT COUNT(*) FROM test_questions WHERE test_id=$1),updated_at=NOW() WHERE id=$1`,[testId]);
    }
    await client.query('COMMIT');
    if(actor) await audit(actor,'question_bank_import',null,{inserted,updated,test_id:testId,mapped});
    return {inserted,updated,test_id:testId,mapped,classified,subject_counts,translated:0,translation_batches:0,translation_resumed:0};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:1}});
function csvRows(text){
  const rows=[]; let row=[], cell='', quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i]; if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);cell='';if(row.some(x=>x.trim()!==''))rows.push(row);row=[];}else cell+=c;}
  if(cell!==''||row.length){row.push(cell);if(row.some(x=>x.trim()!==''))rows.push(row)}
  if(!rows.length)return [];
  const headers=rows.shift().map(x=>x.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_'));
  return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]??'').trim()])));
}
function splitPdfBlocks(text){
  const cleaned=String(text||'').replace(/\u00a0/g,' ').replace(/\r/g,'').replace(/[ \t]+\n/g,'\n');
  return cleaned.split(/\n\s*(?=(?:Q(?:uestion)?\s*)?\d{1,4}[.)]\s+)/i).map(x=>x.trim()).filter(Boolean);
}
function parsePdfQuestionBlock(block,index){
  let s=block.replace(/^(?:Q(?:uestion)?\s*)?\d{1,4}[.)]\s*/i,'').trim();
  const answerMatch=s.match(/(?:^|\n)\s*(?:answer|ans|correct\s*answer)\s*[:\-]?\s*([ABCDE])\b/i);
  const explanationMatch=s.match(/(?:^|\n)\s*(?:explanation|solution)\s*[:\-]?\s*([\s\S]+)$/i);
  const answer=answerMatch?answerMatch[1].toUpperCase():null;
  if(answerMatch)s=s.slice(0,answerMatch.index).trim();
  let explanation=explanationMatch?explanationMatch[1].trim():null;
  if(explanationMatch)s=s.slice(0,explanationMatch.index).trim();
  const optRe=/(?:^|\n)\s*([A-E])[.)]\s+/gi, matches=[...s.matchAll(optRe)];
  if(matches.length<2)return null;
  const stem=s.slice(0,matches[0].index).trim();
  const options=matches.map((m,i)=>s.slice(m.index+m[0].length,i+1<matches.length?matches[i+1].index:s.length).trim()).filter(Boolean);
  if(!stem||options.length<2)return null;
  let question_type='mcq';
  if(/match\s+the\s+following|list\s*(i|1).*list\s*(ii|2)/i.test(stem)||/match\s+the\s+following/i.test(s))question_type='match';
  else if(/assertion\s*[:\-]|reason\s*[:\-]|assertion\s*\(a\).*reason\s*\(r\)/is.test(stem))question_type='assertion_reason';
  else if(/statement\s*[i1]|following\s+statements|which\s+of\s+the\s+statements/i.test(stem))question_type='statement';
  else if(/chronolog|arrange.*order|sequence/i.test(stem))question_type='sequence';
  const metadata={import_parser:'pdf-text',question_type,parse_confidence:answer?'high':'review'};
  const qbi=splitImportedBilingual(stem); const exi=splitImportedBilingual(explanation||''); if(qbi.en.includes('�')||exi.en.includes('�')) metadata.parse_confidence='review'; return {id:`PDF-${Date.now().toString(36)}-${index}-${crypto.randomBytes(3).toString('hex')}`,question_en:qbi.en,question_hi:qbi.hi||null,options:options.map(cleanImportedField),answer,explanation_en:exi.en||null,explanation_hi:exi.hi||null,source:'Admin PDF Import',metadata};
}
function splitTxtQuestionBlocks(text){
  const cleaned=String(text||'').replace(/^\uFEFF/,'').replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').trim();
  if(!cleaned)return [];
  const lines=cleaned.split('\n'); const starts=[];
  const qStart=/^\s*(?:Q(?:uestion)?\s*)?(\d{1,6})[.)\-:]\s*(.*)$/i;
  lines.forEach((line,i)=>{if(qStart.test(line.trim()))starts.push(i)});
  if(!starts.length)throw new Error('TXT parser could not find numbered questions. Use "1. Question", "Q1. Question" or "Question 1. Question" format.');
  const blocks=[]; for(let i=0;i<starts.length;i++){const a=starts[i],b=i+1<starts.length?starts[i+1]:lines.length;blocks.push(lines.slice(a,b).join('\n').trim())} return blocks.filter(Boolean);
}
function parseTxtQuestionBlock(block,index){
  const lines=String(block||'').replace(/\r/g,'').split('\n');
  const first=lines.shift()?.trim()||'';
  const m=first.match(/^(?:Q(?:uestion)?\s*)?(\d{1,6})[.)\-:]\s*(.*)$/i);
  if(!m)return null;
  const qLines=[]; const options=[]; let current=null; let answer=null; let explanation=[]; let inExplanation=false; let subject=null,topic=null,year=null,difficulty=null,source=null,id=null;
  const flush=()=>{if(current!==null){options.push(current.trim());current=null}};
  for(const rawLine of lines){
    const line=rawLine.trim(); if(!line)continue;
    let mm;
    if((mm=line.match(/^([A-E])[.)]\s*(.*)$/i))){flush();current=mm[2].trim();inExplanation=false;continue;}
    if((mm=line.match(/^(?:answer|ans|correct\s*answer)\s*[:\-]?\s*([A-E])\b/i))){flush();answer=mm[1].toUpperCase();inExplanation=false;continue;}
    if((mm=line.match(/^(?:explanation|solution)\s*[:\-]?\s*(.*)$/i))){flush();inExplanation=true;if(mm[1])explanation.push(mm[1].trim());continue;}
    if((mm=line.match(/^subject\s*[:\-]\s*(.*)$/i))){subject=mm[1].trim();inExplanation=false;continue;}
    if((mm=line.match(/^topic\s*[:\-]\s*(.*)$/i))){topic=mm[1].trim();inExplanation=false;continue;}
    if((mm=line.match(/^subtopic\s*[:\-]\s*(.*)$/i))){/* kept in metadata below */;continue;}
    if((mm=line.match(/^year\s*[:\-]\s*(\d{4})\b/i))){year=Number(mm[1]);inExplanation=false;continue;}
    if((mm=line.match(/^difficulty\s*[:\-]\s*(.*)$/i))){difficulty=mm[1].trim();inExplanation=false;continue;}
    if((mm=line.match(/^source\s*[:\-]\s*(.*)$/i))){source=mm[1].trim();inExplanation=false;continue;}
    if((mm=line.match(/^id\s*[:=]\s*([^\s]+)$/i))){id=mm[1].trim();inExplanation=false;continue;}
    if(inExplanation){explanation.push(line);continue;}
    if(current!==null)current+=' '+line; else qLines.push(line);
  }
  flush();
  const question=qLines.length?[m[2],...qLines].join(' ').replace(/\s+/g,' ').trim():m[2].trim();
  if(!question||options.length<2)return null;
  return {id,question_en:question,options,answer,explanation_en:explanation.join(' ').replace(/\s+/g,' ').trim()||null,subject,topic,year,difficulty,source,metadata:{import_parser:'txt-mcq',question_number:Number(m[1]),parse_confidence:answer?'high':'review'}};
}
function parseTxtQuestions(text){
  const blocks=splitTxtQuestionBlocks(text); const questions=[]; const held=[]; blocks.forEach((b,i)=>{try{const q=parseTxtQuestionBlock(b,i+1);if(q)questions.push(q);else held.push({index:i+1,raw:b.slice(0,2000)})}catch(e){held.push({index:i+1,raw:b.slice(0,2000),error:e.message})}}); return {questions,held,total_blocks:blocks.length,text_chars:String(text||'').length};
}
async function parseUploadedFile(file){
  const name=String(file.originalname||'').toLowerCase();
  if(name.endsWith('.json')){const data=JSON.parse(file.buffer.toString('utf8'));return Array.isArray(data)?data:(Array.isArray(data.questions)?data.questions:[])}
  if(name.endsWith('.csv'))return csvRows(file.buffer.toString('utf8'));
  if(name.endsWith('.txt'))return parseTxtQuestions(file.buffer.toString('utf8'));
  if(name.endsWith('.pdf')){
    const parsed=await pdfParse(file.buffer); const blocks=splitPdfBlocks(parsed.text); const out=[]; const held=[];
    blocks.forEach((b,i)=>{const q=parsePdfQuestionBlock(b,i+1);if(q)out.push(q);else held.push({index:i+1,raw:b.slice(0,2000)})});
    return {questions:out,held,total_blocks:blocks.length,pages:parsed.numpages,text_chars:parsed.text.length};
  }
  throw new Error('Unsupported file. Use TXT, JSON, CSV or PDF.');
}
app.post('/api/admin/questions/quality-preview',auth,admin,async(req,res)=>{
  try{
    const input=Array.isArray(req.body)?req.body:(Array.isArray(req.body?.questions)?req.body.questions:null);
    if(!input?.length)return res.status(400).json({error:'No questions supplied.'});
    const batch=normalizeImportBatch(input);
    if(batch.errors.length)return res.status(422).json({error:'Question validation failed.',errors:batch.errors.slice(0,50)});
    const qs=batch.normalized;
    const fps=qs.map(questionContentFingerprint);
    const dupLocal=new Map(); fps.forEach((f,i)=>{if(!dupLocal.has(f))dupLocal.set(f,[]);dupLocal.get(f).push(i)});
    const db=await pool.query('SELECT id,question_en,options,subject,year,source FROM questions WHERE id=ANY($1::text[]) OR question_en = ANY($2::text[])',[qs.map(q=>q.id),qs.map(q=>q.question_en)]);
    const existingIds=new Set(db.rows.map(r=>String(r.id)));
    const existingText=new Map(db.rows.map(r=>[String(r.question_en).trim().toLowerCase().replace(/\s+/g,' '),r]));
    const quality=qs.map((q,i)=>{const f=fps[i], local=(dupLocal.get(f)||[]).filter(j=>j!==i);const same=existingText.get(String(q.question_en).trim().toLowerCase().replace(/\s+/g,' '));return {...q,metadata:{...(q.metadata||{}),duplicate_in_upload:local.length>0,duplicate_existing:existingIds.has(q.id)||!!same,duplicate_existing_id:same?.id||null,detected_exam_year:q.year||inferExamYear(q)||null,detected_exam_name:inferExamName(q)}}});
    res.json({ok:true,total:quality.length,questions:quality});
  }catch(e){res.status(400).json({error:e.message||'Quality preview failed.'})}
});
app.post('/api/admin/questions/classify-preview',auth,admin,async(req,res)=>{
  try{
    const input=Array.isArray(req.body)?req.body:(Array.isArray(req.body?.questions)?req.body.questions:null);
    if(!input?.length)return res.status(400).json({error:'No questions supplied.'});
    if(input.length>10000)return res.status(400).json({error:'Maximum 10,000 questions per classification preview.'});
    const batch=normalizeImportBatch(input);
    if(batch.errors.length)return res.status(422).json({error:'Question validation failed before classification.',errors:batch.errors.slice(0,20)});
    const out=[];
    for(let i=0;i<batch.normalized.length;i+=AI_BATCH_SIZE){
      const part=batch.normalized.slice(i,i+AI_BATCH_SIZE);
      const classified=await classifyBpscBatch(part);
      out.push(...classified);
    }
    res.json({ok:true,total:out.length,questions:out,model:AI_MODEL,batch_size:AI_BATCH_SIZE});
  }catch(e){res.status(400).json({error:e.message||'BPSC classification failed.'})}
});
app.post('/api/admin/questions/parse-file',auth,admin,upload.single('file'),async(req,res)=>{
  try{
    if(!req.file)return res.status(400).json({error:'No file uploaded.'});
    const parsed=await parseUploadedFile(req.file);
    const questions=Array.isArray(parsed)?parsed:(parsed.questions||[]);
    if(!questions.length)return res.status(422).json({error:'No questions could be detected from this file.',held:parsed.held||[]});
    const batch=normalizeImportBatch(questions);
    const validation={total:questions.length,valid:batch.normalized.length,invalid:batch.errors.length,unicode_errors:batch.errors.filter(e=>/Unicode|mojibake|NUL|surrogate/i.test(e.error)).length,duplicate_ids:batch.errors.filter(e=>/Duplicate question ID/i.test(e.error)).length,hindi_content:batch.errors.filter(e=>/Hindi|Devanagari/i.test(e.error)).length,existing_matches:0};
    if(batch.errors.length)return res.status(422).json({ok:false,filename:req.file.originalname,total:questions.length,validation,errors:batch.errors,held:parsed.held||[],parser:{pages:parsed.pages||null,total_blocks:parsed.total_blocks||null,text_chars:parsed.text_chars||null}});
    const ids=batch.normalized.map(q=>q.id),texts=batch.normalized.map(q=>String(q.question_en).trim().toLowerCase().replace(/\s+/g,' '));
    if(ids.length){
      const db=await pool.query("SELECT id,question_en FROM questions WHERE id=ANY($1::text[]) OR lower(regexp_replace(trim(question_en),'\\s+',' ','g'))=ANY($2::text[])",[ids,texts]);
      const byId=new Set(db.rows.map(r=>String(r.id)));
      const byText=new Set(db.rows.map(r=>String(r.question_en||'').trim().toLowerCase().replace(/\s+/g,' ')));
      validation.existing_matches=batch.normalized.filter(q=>byId.has(q.id)||byText.has(String(q.question_en).trim().toLowerCase().replace(/\s+/g,' '))).length;
      batch.normalized.forEach(q=>{q.metadata={...(q.metadata||{}),existing_question_id:byId.has(q.id),existing_question_text:byText.has(String(q.question_en).trim().toLowerCase().replace(/\s+/g,' '))}});
    }
    res.json({ok:true,filename:req.file.originalname,total:batch.normalized.length,validation,questions:batch.normalized,held:parsed.held||[],parser:{pages:parsed.pages||null,total_blocks:parsed.total_blocks||null,text_chars:parsed.text_chars||null}});
  }catch(e){res.status(400).json({error:e.message||'File parsing failed.'})}
});

app.post('/api/admin/questions/import',auth,admin,async(req,res)=>{
  try{
    const input=Array.isArray(req.body)?req.body:(Array.isArray(req.body?.questions)?req.body.questions:null);
    if(!input?.length)return res.status(400).json({error:'No questions supplied.'});
    if(input.length>50000)return res.status(400).json({error:'Maximum 50,000 questions per import.'});
    const batch=normalizeImportBatch(input);
    if(batch.errors.length)return res.status(422).json({ok:false,total:input.length,validation:{total:input.length,valid:batch.normalized.length,invalid:batch.errors.length,unicode_errors:batch.errors.filter(e=>/Unicode|mojibake|NUL|surrogate/i.test(e.error)).length,duplicate_ids:batch.errors.filter(e=>/Duplicate question ID/i.test(e.error)).length},errors:batch.errors});
    const normalized=batch.normalized;
    const test=req.body?.test&&typeof req.body.test==='object'?{...req.body.test}:{};
    const result=await importQuestionsToDb(normalized,test,req.user);
    res.json({ok:true,total:normalized.length,...result});
  }catch(e){res.status(400).json({error:e.message||'Question import failed.'})}
});
app.get('/api/admin/questions/import-history',auth,admin,async(_req,res)=>{
  try{
    const r=await pool.query(`SELECT a.created_at, COALESCE(u.name,u.username,u.email,'Admin') AS actor_name,
      COALESCE((a.details->>'inserted')::int,0)+COALESCE((a.details->>'updated')::int,0) AS total,
      COALESCE((a.details->>'inserted')::int,0) AS inserted,
      COALESCE((a.details->>'updated')::int,0) AS updated,
      t.title AS test_id
      FROM audit_logs a
      LEFT JOIN users u ON u.id=a.actor_user_id
      LEFT JOIN tests t ON t.id=CASE WHEN COALESCE(a.details->>'test_id','')<>'' THEN (a.details->>'test_id')::uuid ELSE NULL END
      WHERE a.action='question_bank_import'
      ORDER BY a.created_at DESC LIMIT 15`);
    res.json({ok:true,imports:r.rows});
  }catch(e){res.status(500).json({error:e.message||'Unable to load import history.'})}
});
app.get('/api/admin/encoding-diagnostics',auth,admin,async(_req,res)=>{
  try{
    const enc=await pool.query("SELECT current_database() AS database, pg_encoding_to_char(encoding) AS server_encoding FROM pg_database WHERE datname=current_database()");
    const client=await pool.query("SHOW client_encoding");
    const cols=await pool.query("SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='questions' AND column_name IN ('question_en','question_hi','options','explanation_en','explanation_hi') ORDER BY ordinal_position");
    const counts=await pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE position(chr(65533) in coalesce(question_en,''))>0 OR position(chr(65533) in coalesce(question_hi,''))>0 OR position(chr(65533) in coalesce(explanation_en,''))>0 OR position(chr(65533) in coalesce(explanation_hi,''))>0 OR position(chr(65533) in coalesce(options::text,''))>0)::int AS replacement_character_rows,
      COUNT(*) FILTER (WHERE coalesce(question_en,'') ~ '(Ã.|Â.|à¤|à¦|â€|ðŸ)' OR coalesce(question_hi,'') ~ '(Ã.|Â.|à¤|à¦|â€|ðŸ)' OR coalesce(explanation_en,'') ~ '(Ã.|Â.|à¤|à¦|â€|ðŸ)' OR coalesce(explanation_hi,'') ~ '(Ã.|Â.|à¤|à¦|â€|ðŸ)')::int AS mojibake_rows
      FROM questions`);
    res.json({ok:true,database:enc.rows[0]||null,client_encoding:client.rows[0]?.client_encoding||null,question_columns:cols.rows,corruption:counts.rows[0]||null});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});
app.get('/api/admin/questions',auth,admin,async(req,res)=>{
  const p=[]; let where=[];
  if(req.query.subject){p.push(String(req.query.subject));where.push(`lower(q.subject)=lower($${p.length})`)}
  if(req.query.test_id){p.push(String(req.query.test_id));where.push(`EXISTS (SELECT 1 FROM test_questions tqf WHERE tqf.test_id=$${p.length} AND tqf.question_id=q.id)`)}
  if(req.query.search){p.push('%'+String(req.query.search).toLowerCase()+'%');where.push(`(lower(q.question_en) LIKE $${p.length} OR lower(coalesce(q.question_hi,'')) LIKE $${p.length} OR lower(coalesce(q.topic,'')) LIKE $${p.length} OR lower(coalesce(q.source,'')) LIKE $${p.length} OR lower(q.id) LIKE $${p.length})`)}
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const limit=Math.min(200,Math.max(1,Number(req.query.limit||100))); const offset=Math.max(0,Number(req.query.offset||0)); p.push(limit,offset);
  const q=await pool.query(`SELECT q.id,q.subject,q.topic,q.subtopic,q.year,q.language,q.question_en,q.question_hi,q.options,q.answer,q.explanation_en,q.explanation_hi,q.difficulty,q.source,q.metadata,q.created_at,q.updated_at,COALESCE((SELECT json_agg(json_build_object('id',t.id,'title',t.title) ORDER BY t.year DESC NULLS LAST,t.sequence_no ASC NULLS LAST,t.title) FROM test_questions tq2 JOIN tests t ON t.id=tq2.test_id WHERE tq2.question_id=q.id),'[]'::json) AS tests FROM questions q${clause} ORDER BY q.updated_at DESC LIMIT $${p.length-1} OFFSET $${p.length}`,p);
  const cP=[]; let cWhere=[];
  if(req.query.subject){cP.push(String(req.query.subject));cWhere.push(`lower(subject)=lower($${cP.length})`)}
  if(req.query.test_id){cP.push(String(req.query.test_id));cWhere.push(`EXISTS (SELECT 1 FROM test_questions tqf WHERE tqf.test_id=$${cP.length} AND tqf.question_id=questions.id)`)}
  if(req.query.search){cP.push('%'+String(req.query.search).toLowerCase()+'%');cWhere.push(`(lower(question_en) LIKE $${cP.length} OR lower(coalesce(question_hi,'')) LIKE $${cP.length} OR lower(coalesce(topic,'')) LIKE $${cP.length} OR lower(coalesce(source,'')) LIKE $${cP.length} OR lower(id) LIKE $${cP.length})`)}
  const c=await pool.query(`SELECT COUNT(*)::int count FROM questions${cWhere.length?' WHERE '+cWhere.join(' AND '):''}`,cP);
  res.json({questions:q.rows,total:c.rows[0].count});
});
app.get('/api/admin/question-bank/facets',auth,admin,async(_req,res)=>{const [s,y]=await Promise.all([pool.query("SELECT DISTINCT subject FROM questions WHERE subject IS NOT NULL AND trim(subject)<>'' ORDER BY subject"),pool.query("SELECT DISTINCT year FROM questions WHERE year IS NOT NULL ORDER BY year DESC")]);res.json({subjects:s.rows.map(r=>r.subject),years:y.rows.map(r=>r.year)});});
app.get('/api/admin/question-bank/tests',auth,admin,async(_req,res)=>{
  const q=await pool.query(`SELECT t.id,t.title,t.institution,t.category,t.year,t.sequence_no,t.duration_seconds,t.published,COUNT(tq.question_id)::int question_count FROM tests t LEFT JOIN test_questions tq ON tq.test_id=t.id GROUP BY t.id ORDER BY t.year DESC NULLS LAST,t.sequence_no ASC NULLS LAST,t.title`);
  res.json({tests:q.rows});
});
app.patch('/api/admin/questions/:id',auth,admin,async(req,res)=>{
  try{
    const existing=(await pool.query('SELECT * FROM questions WHERE id=$1',[req.params.id])).rows[0];
    if(!existing)return res.status(404).json({error:'Question not found'});
    const body={...(req.body||{})}; const legacyOptions=Array.isArray(body.options)?body.options:(Array.isArray(existing.options)?existing.options:[]); body.options=legacyOptions.map(o=>typeof o==='object'?String(o.en??o.text??o.label??''):String(o)); const normalized=normalizeImportedQuestion({...existing,...body,id:req.params.id,question_hi:undefined,explanation_hi:undefined,language:'english'},1);
    await pool.query(`UPDATE questions SET subject=$2,topic=$3,subtopic=$4,year=$5,language=$6,question_en=$7,question_hi=$8,options=$9,answer=$10,explanation_en=$11,explanation_hi=$12,difficulty=$13,source=$14,metadata=$15,updated_at=NOW() WHERE id=$1`,[normalized.id,normalized.subject,normalized.topic,normalized.subtopic,normalized.year,normalized.language,normalized.question_en,normalized.question_hi,JSON.stringify(normalized.options),normalized.answer,normalized.explanation_en,normalized.explanation_hi,normalized.difficulty,normalized.source,JSON.stringify(normalized.metadata||{})]);
    await audit(req.user,'question_bank_edit',req.params.id,{});
    const q=(await pool.query('SELECT * FROM questions WHERE id=$1',[req.params.id])).rows[0];
    res.json({ok:true,question:q});
  }catch(e){res.status(400).json({error:e.message||'Question update failed.'})}
});
app.delete('/api/admin/questions/:id',auth,admin,async(req,res)=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const exists=(await client.query('SELECT id FROM questions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!exists){await client.query('ROLLBACK');return res.status(404).json({error:'Question not found'})}
    await client.query('DELETE FROM questions WHERE id=$1',[req.params.id]);
    await client.query('COMMIT'); await audit(req.user,'question_bank_delete',req.params.id,{}); res.json({ok:true,deleted:1});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Question delete failed.'})}finally{client.release()}
});
app.post('/api/admin/questions/bulk-delete',auth,admin,async(req,res)=>{
  const ids=Array.isArray(req.body?.ids)?[...new Set(req.body.ids.map(String).filter(Boolean))]:[];
  if(!ids.length)return res.status(400).json({error:'No question IDs supplied.'});
  if(ids.length>50000)return res.status(400).json({error:'Maximum 50,000 questions per bulk delete.'});
  const client=await pool.connect();
  try{await client.query('BEGIN');const r=await client.query('DELETE FROM questions WHERE id = ANY($1::text[]) RETURNING id',[ids]);await client.query('COMMIT');await audit(req.user,'question_bank_bulk_delete',null,{requested:ids.length,deleted:r.rowCount});res.json({ok:true,deleted:r.rowCount,requested:ids.length});}
  catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Bulk delete failed.'})}finally{client.release()}
});
app.delete('/api/admin/tests/:id',auth,admin,async(req,res)=>{const testId=String(req.params.id),deleteUnused=!!req.body?.delete_unused_questions;const client=await pool.connect();try{await client.query('BEGIN');const t=(await client.query('SELECT id,title FROM tests WHERE id=$1 FOR UPDATE',[testId])).rows[0];if(!t){await client.query('ROLLBACK');return res.status(404).json({error:'Test not found'})}let removed=0;if(deleteUnused){const ids=(await client.query('SELECT question_id FROM test_questions WHERE test_id=$1',[testId])).rows.map(x=>x.question_id);if(ids.length){const r=await client.query(`DELETE FROM questions q WHERE q.id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM test_questions tq WHERE tq.question_id=q.id AND tq.test_id<>$2) RETURNING q.id`,[ids,testId]);removed=r.rowCount}}await client.query('DELETE FROM tests WHERE id=$1',[testId]);await client.query('COMMIT');await audit(req.user,'test_delete',null,{test_id:testId,test_title:t.title,unused_questions_deleted:removed});res.json({ok:true,deleted_test:testId,unused_questions_deleted:removed});}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Could not delete test.'})}finally{client.release()}});
app.delete('/api/admin/tests/:id/questions',auth,admin,async(req,res)=>{
  const testId=String(req.params.id); const client=await pool.connect();
  try{await client.query('BEGIN');const t=(await client.query('SELECT id,title FROM tests WHERE id=$1 FOR UPDATE',[testId])).rows[0];if(!t){await client.query('ROLLBACK');return res.status(404).json({error:'Test not found'})}
    const mapped=(await client.query('SELECT COUNT(*)::int count FROM test_questions WHERE test_id=$1',[testId])).rows[0].count;
    await client.query('DELETE FROM test_questions WHERE test_id=$1',[testId]);await client.query('UPDATE tests SET question_count=0,updated_at=NOW() WHERE id=$1',[testId]);await client.query('COMMIT');await audit(req.user,'test_question_mapping_delete',testId,{test_title:t.title,deleted_mappings:mapped});res.json({ok:true,test_id:testId,deleted_mappings:mapped});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Could not clear test questions.'})}finally{client.release()}
});

// Admin analytics and support
app.get('/api/admin/analytics',auth,admin,async(_req,res)=>{try{const [kpi,top,difficult]=await Promise.all([
 pool.query(`SELECT (SELECT COUNT(*) FROM users WHERE role='student') students,(SELECT COUNT(*) FROM tests WHERE published=TRUE) published_tests,(SELECT COUNT(*) FROM questions) questions,(SELECT COUNT(*) FROM test_attempts) attempts,(SELECT COALESCE(ROUND(AVG(score),2),0) FROM test_attempts) average_score,(SELECT COUNT(*) FROM support_threads WHERE status='open') open_support_tickets`),
 pool.query(`SELECT a.test_id,COALESCE(t.title,a.test_id) title,COUNT(*)::int attempts,ROUND(AVG(a.score),2)::numeric average_score,ROUND(MAX(a.score),2)::numeric best_score FROM test_attempts a LEFT JOIN tests t ON t.id::text=a.test_id GROUP BY a.test_id,t.title ORDER BY COUNT(*) DESC LIMIT 10`),
 pool.query(`SELECT q.id,q.subject,q.topic,COUNT(qa.*)::int attempts,ROUND(100*AVG(CASE WHEN qa.is_correct THEN 1 ELSE 0 END),1)::numeric accuracy,ROUND(AVG(qa.time_spent_seconds),1)::numeric avg_time FROM question_attempts qa JOIN questions q ON q.id=qa.question_id GROUP BY q.id,q.subject,q.topic HAVING COUNT(qa.*)>=2 ORDER BY AVG(CASE WHEN qa.is_correct THEN 1 ELSE 0 END) ASC,COUNT(qa.*) DESC LIMIT 20`)
]);res.json({kpis:kpi.rows[0],most_attempted_tests:top.rows,difficult_questions:difficult.rows});}catch(e){res.status(500).json({error:'Admin analytics unavailable'})}});
app.get('/api/admin/support/tickets',auth,admin,async(_req,res)=>{try{const q=await pool.query(`SELECT t.*,u.name,u.student_code,u.email,(SELECT COUNT(*)::int FROM support_messages m WHERE m.thread_id=t.id) message_count,(SELECT message FROM support_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC LIMIT 1) last_message FROM support_threads t JOIN users u ON u.id=t.user_id ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.updated_at DESC LIMIT 500`);res.json({tickets:q.rows});}catch(e){res.status(500).json({error:'Support inbox unavailable'})}});
app.get('/api/admin/support/tickets/:id',auth,admin,async(req,res)=>{try{const t=(await pool.query(`SELECT t.*,u.name,u.student_code,u.email FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=$1`,[req.params.id])).rows[0];if(!t)return res.status(404).json({error:'Ticket not found'});const m=(await pool.query(`SELECT m.*,u.name sender_name FROM support_messages m JOIN users u ON u.id=m.sender_id WHERE m.thread_id=$1 ORDER BY m.created_at ASC`,[t.id])).rows;await pool.query(`UPDATE support_messages SET read_at=COALESCE(read_at,NOW()) WHERE thread_id=$1 AND sender_role='student' AND read_at IS NULL`,[t.id]);res.json({ticket:t,messages:m});}catch(e){res.status(500).json({error:'Support ticket unavailable'})}});
app.post('/api/admin/support/tickets/:id/messages',auth,admin,async(req,res)=>{const message=String(req.body?.message||'').trim();if(!message)return res.status(400).json({error:'Message is required'});const c=await pool.connect();try{await c.query('BEGIN');const t=(await c.query('SELECT id FROM support_threads WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!t){await c.query('ROLLBACK');return res.status(404).json({error:'Ticket not found'})}await c.query(`INSERT INTO support_messages(thread_id,sender_id,sender_role,message) VALUES($1,$2,'admin',$3)`,[t.id,req.user.id,message]);await c.query(`UPDATE support_threads SET status='open',updated_at=NOW(),last_message_at=NOW() WHERE id=$1`,[t.id]);await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:'Could not send reply.'})}finally{c.release()}});
app.patch('/api/admin/support/tickets/:id',auth,admin,async(req,res)=>{const status=req.body?.status;if(!['open','closed'].includes(status))return res.status(400).json({error:'Invalid status'});const q=await pool.query(`UPDATE support_threads SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *`,[status,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Ticket not found'});res.json({ticket:q.rows[0]})});
app.get('/api/admin/stats',auth,admin,async(_req,res)=>{const q=await pool.query(`SELECT (SELECT COUNT(*) FROM users WHERE role='student') users,(SELECT COUNT(*) FROM users WHERE role='student' AND status='active') active_users,(SELECT COUNT(*) FROM users WHERE role='student' AND status='blocked') blocked_users,(SELECT COUNT(*) FROM users WHERE role='student' AND status='deactivated') deactivated_users,(SELECT COUNT(*) FROM tests) tests,(SELECT COUNT(*) FROM questions) questions,(SELECT COUNT(*) FROM test_attempts) attempts,(SELECT COALESCE(SUM(xp_amount),0) FROM xp_ledger) xp_awarded,(SELECT COUNT(*) FROM planner_tasks WHERE completed=FALSE) open_tasks`);res.json({stats:q.rows[0]})});
app.get('/api/admin/users',auth,admin,async(req,res)=>{const search=(req.query.search||'').trim();const status=req.query.status;const p=[];let s="SELECT id,student_code,email,name,username,role,status,target_exam,xp,level,streak_days,last_login_at,created_at FROM users WHERE role='student'";if(search){p.push('%'+search.toLowerCase()+'%');s+=` AND (lower(coalesce(name,'')) LIKE $${p.length} OR lower(coalesce(email,'')) LIKE $${p.length} OR lower(coalesce(username,'')) LIKE $${p.length} OR lower(coalesce(student_code,'')) LIKE $${p.length})`}if(status){p.push(status);s+=` AND status=$${p.length}`}s+=' ORDER BY created_at DESC LIMIT 500';res.json({users:(await pool.query(s,p)).rows})});
app.get('/api/admin/users/:id/activity',auth,admin,async(req,res)=>{const u=(await pool.query("SELECT id,student_code,email,name,username,status,last_login_at,created_at FROM users WHERE id=$1 AND role='student'",[req.params.id])).rows[0];if(!u)return res.status(404).json({error:'Student not found'});const logs=(await pool.query('SELECT action,details,created_at FROM audit_logs WHERE target_user_id=$1 ORDER BY created_at DESC LIMIT 500',[req.params.id])).rows;const attempts=(await pool.query('SELECT id,test_id,mode,score,total_questions,accuracy,submitted_at FROM test_attempts WHERE user_id=$1 ORDER BY submitted_at DESC LIMIT 100',[req.params.id])).rows;const battles=(await pool.query('SELECT id,status,subject,question_count,started_at,finished_at,winner_id FROM battle_rooms WHERE creator_id=$1 OR accepted_by=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows;res.json({user:u,activity:logs,attempts,battles})});
app.post('/api/admin/users',auth,admin,async(req,res)=>{const b=req.body||{};const name=(b.name||'New Student').trim();const email=b.email?.trim().toLowerCase()||null;const username=b.username?.trim()||null;const password=b.password?.trim()||makePassword();const code=b.student_code?.trim()||makeStudentCode();if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});try{const hash=await bcrypt.hash(password,12);const q=await pool.query(`INSERT INTO users(student_code,email,password_hash,name,username,target_exam,daily_target,role,status) VALUES($1,$2,$3,$4,$5,$6,$7,'student','active') RETURNING *`,[code,email,hash,name,username,b.target_exam||'BPSC Prelims',Number(b.daily_target||100)]);await audit(req.user,'create_student',q.rows[0].id,{student_code:code});res.status(201).json({user:publicUser(q.rows[0]),credentials:{student_code:code,username:username||null,email,password}})}catch(e){res.status(409).json({error:e.code==='23505'?'Student ID, email or username already exists':'Could not create student'})}});
app.patch('/api/admin/users/:id/status',auth,admin,async(req,res)=>{const target=(await pool.query('SELECT id,role FROM users WHERE id=$1',[req.params.id])).rows[0];if(!target||target.role!=='student')return res.status(404).json({error:'Student not found'});const status=req.body?.status;if(!['active','blocked','deactivated'].includes(status))return res.status(400).json({error:'Invalid status'});if(req.params.id===req.user.id&&status!=='active')return res.status(400).json({error:'You cannot disable your own admin account'});const q=await pool.query("UPDATE users SET status=$1,updated_at=NOW() WHERE id=$2 AND role='student' RETURNING id,student_code,name,status",[status,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Student not found'});await audit(req.user,'change_user_status',req.params.id,{status});res.json({user:q.rows[0]})});
app.post('/api/admin/users/:id/reset-password',auth,admin,async(req,res)=>{const target=(await pool.query('SELECT id,role FROM users WHERE id=$1',[req.params.id])).rows[0];if(!target||target.role!=='student')return res.status(404).json({error:'Student not found'});const password=req.body?.password?.trim()||makePassword();if(password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});const hash=await bcrypt.hash(password,12);const q=await pool.query("UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2 AND role='student' RETURNING id,student_code,name",[hash,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Student not found'});await audit(req.user,'reset_password',req.params.id,{});res.json({user:q.rows[0],temporary_password:password})});
app.get('/api/admin/attempts',auth,admin,async(req,res)=>{const q=await pool.query(`SELECT a.*,u.student_code,u.name,u.email FROM test_attempts a JOIN users u ON u.id=a.user_id ORDER BY a.submitted_at DESC LIMIT 500`);res.json({attempts:q.rows})});
app.get('/api/admin/audit',auth,admin,async(req,res)=>{const q=await pool.query(`SELECT a.*,au.name actor_name,tu.name target_name FROM audit_logs a LEFT JOIN users au ON au.id=a.actor_user_id LEFT JOIN users tu ON tu.id=a.target_user_id ORDER BY a.created_at DESC LIMIT 500`);res.json({logs:q.rows})});
app.get('/api/admin/planner',auth,admin,async(_req,res)=>{const q=await pool.query(`SELECT p.*,u.student_code,u.name FROM planner_tasks p JOIN users u ON u.id=p.user_id ORDER BY p.task_date DESC,p.created_at DESC LIMIT 500`);res.json({tasks:q.rows})});
app.post('/api/admin/tests',auth,admin,async(req,res)=>{const b=req.body||{};if(!b.slug||!b.title)return res.status(400).json({error:'slug and title are required'});try{const q=await pool.query(`INSERT INTO tests(slug,title,institution,category,year,sequence_no,access_type,duration_seconds,published,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[b.slug,b.title,b.institution||null,b.category||null,b.year||null,b.sequence_no||null,b.access_type||'premium',Number(b.duration_seconds||7200),b.published!==false,JSON.stringify(b.metadata||{})]);await audit(req.user,'create_test',null,{test_id:q.rows[0].id,title:b.title});res.status(201).json({test:q.rows[0]})}catch(e){res.status(409).json({error:'Could not create test: '+e.message})}});
app.patch('/api/admin/tests/:id/publish',auth,admin,async(req,res)=>{const published=Boolean(req.body?.published);const q=await pool.query('UPDATE tests SET published=$1,updated_at=NOW() WHERE id=$2 RETURNING id,title,published',[published,req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Test not found'});await audit(req.user,published?'test_publish':'test_unpublish',null,{test_id:req.params.id});res.json({test:q.rows[0]})});
app.post('/api/admin/import',auth,admin,async(req,res)=>{
  const data=req.body||{};
  if(!Array.isArray(data.questions)&&!Array.isArray(data.tests))return res.status(400).json({error:'Send tests/questions/testQuestions arrays'});
  const batch=normalizeImportBatch(Array.isArray(data.questions)?data.questions:[]);
  if(batch.errors.length)return res.status(422).json({ok:false,validation:{total:(data.questions||[]).length,valid:batch.normalized.length,invalid:batch.errors.length,unicode_errors:batch.errors.filter(e=>/Unicode|mojibake|NUL|surrogate/i.test(e.error)).length,duplicate_ids:batch.errors.filter(e=>/Duplicate question ID/i.test(e.error)).length},errors:batch.errors});
  const client=await pool.connect();let qc=0,tc=0,tqc=0;
  try{
    await client.query('BEGIN');
    for(const t of data.tests||[]){
      await client.query(`INSERT INTO tests(id,slug,title,institution,category,year,sequence_no,access_type,duration_seconds,published,question_count,metadata) VALUES(COALESCE($1::uuid,gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(slug) DO UPDATE SET title=EXCLUDED.title,institution=EXCLUDED.institution,category=EXCLUDED.category,year=EXCLUDED.year,sequence_no=EXCLUDED.sequence_no,duration_seconds=EXCLUDED.duration_seconds,published=EXCLUDED.published,question_count=EXCLUDED.question_count,metadata=EXCLUDED.metadata,updated_at=NOW()`,[t.id||null,t.slug,t.title,t.institution||null,t.category||null,t.year||null,t.sequence_no||null,t.access_type||'premium',Number(t.duration_seconds||7200),t.published!==false,Number(t.question_count||0),JSON.stringify(t.metadata||{})]);tc++;
    }
    for(const q of batch.normalized){
      await client.query(`INSERT INTO questions(id,subject,topic,subtopic,year,language,question_en,question_hi,options,answer,explanation_en,explanation_hi,difficulty,source,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(id) DO UPDATE SET subject=EXCLUDED.subject,topic=EXCLUDED.topic,subtopic=EXCLUDED.subtopic,year=EXCLUDED.year,language=EXCLUDED.language,question_en=EXCLUDED.question_en,question_hi=EXCLUDED.question_hi,options=EXCLUDED.options,answer=EXCLUDED.answer,explanation_en=EXCLUDED.explanation_en,explanation_hi=EXCLUDED.explanation_hi,difficulty=EXCLUDED.difficulty,source=EXCLUDED.source,metadata=EXCLUDED.metadata,updated_at=NOW()`,[q.id,q.subject,q.topic,q.subtopic,q.year,q.language,q.question_en,q.question_hi,JSON.stringify(q.options||[]),q.answer,q.explanation_en,q.explanation_hi,q.difficulty,q.source,JSON.stringify(q.metadata||{})]);qc++;
    }
    for(const x of data.testQuestions||[]){
      await client.query(`INSERT INTO test_questions(test_id,question_id,sort_order) VALUES($1,$2,$3) ON CONFLICT(test_id,question_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`,[x.test_id,x.question_id,Number(x.sort_order||1)]);tqc++;
    }
    await client.query(`UPDATE tests t SET question_count=(SELECT COUNT(*) FROM test_questions tq WHERE tq.test_id=t.id)`);
    await client.query('COMMIT');await audit(req.user,'import_content',null,{tests:tc,questions:qc,testQuestions:tqc});res.json({ok:true,tests:tc,questions:qc,testQuestions:tqc});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

// Admin notifications
app.post('/api/admin/notifications',auth,admin,async(req,res)=>{const b=req.body||{};if(!b.title||!b.message)return res.status(400).json({error:'Title and message are required'});const client=await pool.connect();try{await client.query('BEGIN');const n=await client.query(`INSERT INTO notifications(title,message,type,link,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *`,[String(b.title).trim(),String(b.message).trim(),b.type||'announcement',b.link||null,req.user.id]);let users=[];if(Array.isArray(b.user_ids)&&b.user_ids.length){const q=await client.query(`SELECT id FROM users WHERE role='student' AND status='active' AND id=ANY($1::uuid[])`,[b.user_ids]);users=q.rows}else{const q=await client.query(`SELECT id FROM users WHERE role='student' AND status='active'`);users=q.rows}for(const u of users)await client.query(`INSERT INTO notification_recipients(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[n.rows[0].id,u.id]);await client.query('COMMIT');await audit(req.user,'send_notification',null,{notification_id:n.rows[0].id,recipient_count:users.length});res.status(201).json({notification:n.rows[0],recipient_count:users.length})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.get('/api/admin/notifications',auth,admin,async(_req,res)=>{const q=await pool.query(`SELECT n.*,COUNT(r.user_id)::int recipient_count,COUNT(r.read_at)::int read_count FROM notifications n LEFT JOIN notification_recipients r ON r.notification_id=n.id GROUP BY n.id ORDER BY n.created_at DESC LIMIT 100`);res.json({notifications:q.rows})});
app.get('/api/admin/attempts',auth,admin,async(req,res)=>{const q=await pool.query(`SELECT a.*,u.student_code,u.name,u.email FROM test_attempts a JOIN users u ON u.id=a.user_id ORDER BY a.submitted_at DESC LIMIT 500`);res.json({attempts:q.rows})});

// Battle Arena: polling-based realtime foundation; server is authoritative for matchmaking and scoring.
app.post('/api/battles/challenge-everyone',auth,async(req,res)=>{
  if(req.user.role!=='student')return res.status(403).json({error:'Student challenges are available only to students.'});
  const body=req.body||{};
  const ids=Array.isArray(body.question_ids)?[...new Set(body.question_ids.map(String).filter(Boolean))]:[];
  if(ids.length<3||ids.length>150)return res.status(400).json({error:'A challenge must contain 3–150 questions.'});
  const answers=(body.answers&&typeof body.answers==='object')?body.answers:{};
  const existing=await pool.query(`SELECT id FROM battle_rooms WHERE creator_id=$1 AND mode='challenge_everyone' AND status='waiting' AND challenge_expires_at>NOW() LIMIT 1`,[req.user.id]);
  if(existing.rows[0])return res.status(409).json({error:'You already have an active Challenge Everyone. Wait for it to expire or be accepted.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const qs=(await client.query(`SELECT id,answer FROM questions WHERE id=ANY($1::text[])`,[ids])).rows;
    const byId=new Map(qs.map(q=>[String(q.id),q]));
    if(qs.length!==ids.length){await client.query('ROLLBACK');return res.status(400).json({error:'Some challenge questions are no longer available.'});}
    let correct=0;
    for(const id of ids){const sel=answers[id]==null?null:Number(answers[id]);if(sel!==null&&sel===Number(byId.get(id).answer))correct++;}
    const total=ids.length;
    const score=correct*100;
    const time=Math.max(0,Math.min(7200,Number(body.time_seconds||0)));
    const subject=body.subject?String(body.subject).slice(0,120):null;
    const title=body.title?String(body.title).slice(0,120):'BPSC Nexus Challenge';
    const room=(await client.query(`INSERT INTO battle_rooms(creator_id,mode,subject,question_count,seconds_per_question,status,challenge_total,creator_score,creator_correct,creator_time_seconds,challenge_expires_at,challenge_meta,updated_at) VALUES($1,'challenge_everyone',$2,$3,0,'waiting',$3,$4,$5,$6,NOW()+INTERVAL '15 minutes',$7::jsonb,NOW()) RETURNING *`,[req.user.id,subject,total,score,correct,time,JSON.stringify({title,source:String(body.source||'').slice(0,160)})])).rows[0];
    await client.query(`INSERT INTO battle_players(battle_id,user_id,score,correct,answered) VALUES($1,$2,$3,$4,$5)`,[room.id,req.user.id,score,correct,total]);
    for(let i=0;i<ids.length;i++)await client.query(`INSERT INTO battle_questions(battle_id,question_id,sort_order) VALUES($1,$2,$3)`,[room.id,ids[i],i]);
    // Only students currently present receive the broadcast. Presence is heartbeat-based.
    const recipients=(await client.query(`SELECT u.id FROM users u JOIN user_presence p ON p.user_id=u.id WHERE u.role='student' AND u.status='active' AND u.id<>$1 AND p.last_seen_at>NOW()-INTERVAL '90 seconds'`,[req.user.id])).rows;
    const n=(await client.query(`INSERT INTO notifications(title,message,type,link,created_by) VALUES($1,$2,'battle_challenge',$3,$4) RETURNING id`,['⚔ Challenge Everyone',`${req.user.name||'A student'} challenged everyone to a ${total}-question ${subject||'Mixed GS'} battle. First student to accept gets the match.`,String(room.id),req.user.id])).rows[0];
    for(const r of recipients)await client.query(`INSERT INTO notification_recipients(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[n.id,r.id]);
    await client.query('COMMIT');
    await audit(req.user,'battle_challenge_everyone',null,{battle_id:room.id,recipient_count:recipients.length,question_count:total});
    res.status(201).json({ok:true,battle:room,notified:recipients.length});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Could not create challenge.'})}finally{client.release()}
});

app.get('/api/battles/challenges/open',auth,async(req,res)=>{
  const q=await pool.query(`SELECT r.id,r.subject,r.question_count,r.creator_score,r.creator_correct,r.creator_time_seconds,r.created_at,r.challenge_expires_at,u.name creator_name,u.student_code creator_code,(r.challenge_meta->>'title') title FROM battle_rooms r JOIN users u ON u.id=r.creator_id WHERE r.status='waiting' AND r.mode='challenge_everyone' AND r.creator_id<>$1 AND r.challenge_expires_at>NOW() ORDER BY r.created_at DESC LIMIT 25`,[req.user.id]);
  res.json({challenges:q.rows});
});

app.post('/api/battles/:id/challenge-accept',auth,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const room=(await client.query(`UPDATE battle_rooms SET accepted_by=$1,status='active',started_at=NOW(),updated_at=NOW() WHERE id=$2 AND mode='challenge_everyone' AND status='waiting' AND creator_id<>$1 AND challenge_expires_at>NOW() RETURNING *`,[req.user.id,req.params.id])).rows[0];
    if(!room){await client.query('ROLLBACK');return res.status(409).json({error:'This challenge was already accepted, cancelled or expired.'});}
    await client.query(`INSERT INTO battle_players(battle_id,user_id,score,correct,answered) VALUES($1,$2,0,0,0) ON CONFLICT DO NOTHING`,[room.id,req.user.id]);
    await client.query(`INSERT INTO notifications(title,message,type,link,created_by) VALUES($1,$2,'battle_update',$3,$4)`,['⚔ Challenge accepted',`${req.user.name||'A student'} accepted your challenge. Their attempt is now live.`,String(room.id),req.user.id]);
    const creator=room.creator_id;
    const nid=(await client.query(`SELECT id FROM notifications WHERE type='battle_update' AND link=$1 ORDER BY created_at DESC LIMIT 1`,[String(room.id)])).rows[0];
    if(nid)await client.query(`INSERT INTO notification_recipients(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[nid.id,creator]);
    await client.query('COMMIT');
    res.json({ok:true,battle:room});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Could not accept challenge.'})}finally{client.release()}
});

app.get('/api/battles/:id/challenge',auth,async(req,res)=>{
  const b=(await pool.query(`SELECT r.*,cu.name creator_name,au.name accepted_name FROM battle_rooms r JOIN users cu ON cu.id=r.creator_id LEFT JOIN users au ON au.id=r.accepted_by WHERE r.id=$1 AND r.mode='challenge_everyone'`,[req.params.id])).rows[0];
  if(!b)return res.status(404).json({error:'Challenge not found'});
  if(b.creator_id!==req.user.id&&b.accepted_by!==req.user.id)return res.status(403).json({error:'Not a participant'});
  const q=await pool.query(`SELECT bq.sort_order,q.id,q.question_en,q.question_hi,q.options,q.answer,q.explanation_en,q.explanation_hi,q.subject,q.topic FROM battle_questions bq JOIN questions q ON q.id=bq.question_id WHERE bq.battle_id=$1 ORDER BY bq.sort_order`,[req.params.id]);
  const players=await pool.query(`SELECT bp.user_id,bp.score,bp.correct,bp.answered,u.name,u.student_code FROM battle_players bp JOIN users u ON u.id=bp.user_id WHERE bp.battle_id=$1`,[req.params.id]);
  res.json({battle:b,questions:q.rows,players:players.rows});
});

app.post('/api/battles/:id/challenge-submit',auth,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const b=(await client.query(`SELECT * FROM battle_rooms WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!b||b.mode!=='challenge_everyone')return res.status(404).json({error:'Challenge not found'});
    if(b.accepted_by!==req.user.id)return res.status(403).json({error:'Only the accepted challenger can submit this attempt.'});
    if(b.status!=='active')return res.status(409).json({error:'This challenge is not active.'});
    const answers=(req.body?.answers&&typeof req.body.answers==='object')?req.body.answers:{};
    const qs=(await client.query(`SELECT bq.question_id,q.answer FROM battle_questions bq JOIN questions q ON q.id=bq.question_id WHERE bq.battle_id=$1 ORDER BY bq.sort_order`,[b.id])).rows;
    let correct=0,answered=0;
    for(const q of qs){const raw=answers[String(q.question_id)];const sel=raw==null?null:Number(raw);const isCorrect=sel!==null&&sel===Number(q.answer);if(raw!=null)answered++;if(isCorrect)correct++;await client.query(`INSERT INTO battle_answers(battle_id,user_id,question_id,selected_option,is_correct,time_ms) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[b.id,req.user.id,q.question_id,sel,isCorrect,Math.max(0,Number(req.body?.time_ms||0))]);}
    const score=Math.max(0,correct*100);
    await client.query(`UPDATE battle_players SET score=$1,correct=$2,answered=$3 WHERE battle_id=$4 AND user_id=$5`,[score,correct,answered,b.id,req.user.id]);
    const creatorScore=Number(b.creator_score||0),creatorCorrect=Number(b.creator_correct||0);
    const winner=score>creatorScore?req.user.id:(score<creatorScore?b.creator_id:null);
    await client.query(`UPDATE battle_rooms SET status='completed',winner_id=$1,finished_at=NOW(),updated_at=NOW() WHERE id=$2`,[winner,b.id]);
    const winnerXp=winner?75:35;
    await client.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'battle_challenge',$2,$3)`,[req.user.id,b.id,winner===req.user.id?winnerXp:35]);
    await client.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'battle_challenge',$2,$3)`,[b.creator_id,b.id,winner===b.creator_id?winnerXp:35]);
    await client.query(`UPDATE users SET xp=xp+$1,level=GREATEST(1,((xp+$1)/500)::int+1),updated_at=NOW() WHERE id=$2`,[winner===req.user.id?winnerXp:35,req.user.id]);
    await client.query(`UPDATE users SET xp=xp+$1,level=GREATEST(1,((xp+$1)/500)::int+1),updated_at=NOW() WHERE id=$2`,[winner===b.creator_id?winnerXp:35,b.creator_id]);
    const msg=`Challenge complete: ${req.user.name||'Opponent'} scored ${score} vs your ${creatorScore}.`;
    const n=(await client.query(`INSERT INTO notifications(title,message,type,link,created_by) VALUES($1,$2,'battle_update',$3,$4) RETURNING id`,['⚔ Challenge complete',msg,String(b.id),req.user.id])).rows[0];
    await client.query(`INSERT INTO notification_recipients(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[n.id,b.creator_id]);
    await client.query('COMMIT');
    res.json({ok:true,score,correct,answered,creator_score:creatorScore,winner_id:winner,battle_id:b.id});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message||'Challenge submission failed.'})}finally{client.release()}
});

app.post('/api/battles',auth,async(req,res)=>{const b=req.body||{};const subject=b.subject?String(b.subject):null;const count=Math.min(20,Math.max(5,Number(b.question_count||20)));const seconds=Math.min(30,Math.max(10,Number(b.seconds_per_question||20)));const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query(`SELECT id FROM questions WHERE ($1::text IS NULL OR lower(subject)=lower($1)) ORDER BY random() LIMIT $2`,[subject,count]);if(q.rows.length<count){await client.query('ROLLBACK');return res.status(400).json({error:'Not enough questions for this battle.'})}const room=(await client.query(`INSERT INTO battle_rooms(creator_id,mode,subject,question_count,seconds_per_question,current_question_started_at) VALUES($1,'standard',$2,$3,$4,NULL) RETURNING *`,[req.user.id,subject,count,seconds])).rows[0];await client.query(`INSERT INTO battle_players(battle_id,user_id) VALUES($1,$2)`,[room.id,req.user.id]);for(let i=0;i<q.rows.length;i++)await client.query(`INSERT INTO battle_questions(battle_id,question_id,sort_order) VALUES($1,$2,$3)`,[room.id,q.rows[i].id,i]);await client.query('COMMIT');res.status(201).json({battle:room})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.get('/api/battles/open',auth,async(req,res)=>{const q=await pool.query(`SELECT r.id,r.subject,r.question_count,r.seconds_per_question,r.created_at,u.name creator_name,u.student_code creator_code FROM battle_rooms r JOIN users u ON u.id=r.creator_id WHERE r.status='waiting' AND r.creator_id<>$1 ORDER BY r.created_at ASC LIMIT 25`,[req.user.id]);res.json({battles:q.rows})});
app.post('/api/battles/:id/accept',auth,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const lock=await client.query(`UPDATE battle_rooms SET accepted_by=$1,status='active',started_at=NOW(),current_question_started_at=NOW(),updated_at=NOW() WHERE id=$2 AND status='waiting' AND creator_id<>$1 RETURNING *`,[req.user.id,req.params.id]);if(!lock.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'Battle was already accepted or is unavailable.'})}await client.query(`INSERT INTO battle_players(battle_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,[req.params.id,req.user.id]);await client.query('COMMIT');res.json({battle:lock.rows[0],accepted:true})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.get('/api/battles/:id',auth,async(req,res)=>{const b=(await pool.query(`SELECT r.*,cu.name creator_name,au.name accepted_name FROM battle_rooms r JOIN users cu ON cu.id=r.creator_id LEFT JOIN users au ON au.id=r.accepted_by WHERE r.id=$1`,[req.params.id])).rows[0];if(!b)return res.status(404).json({error:'Battle not found'});if(b.creator_id!==req.user.id&&b.accepted_by!==req.user.id)return res.status(403).json({error:'Not a participant'});const q=await pool.query(`SELECT bq.sort_order,q.id,q.question_en,q.question_hi,q.options,q.subject FROM battle_questions bq JOIN questions q ON q.id=bq.question_id WHERE bq.battle_id=$1 ORDER BY bq.sort_order`,[req.params.id]);const players=await pool.query(`SELECT bp.user_id,bp.score,bp.correct,bp.answered,u.name,u.student_code FROM battle_players bp JOIN users u ON u.id=bp.user_id WHERE bp.battle_id=$1`,[req.params.id]);res.json({battle:b,questions:q.rows,players:players.rows})});
app.post('/api/battles/:id/answer',auth,async(req,res)=>{const b=(await pool.query(`SELECT * FROM battle_rooms WHERE id=$1`,[req.params.id])).rows[0];if(!b||b.status!=='active')return res.status(400).json({error:'Battle is not active'});if(b.creator_id!==req.user.id&&b.accepted_by!==req.user.id)return res.status(403).json({error:'Not a participant'});if(b.current_question_started_at&&((Date.now()-new Date(b.current_question_started_at).getTime())/1000)>=Number(b.seconds_per_question))return res.status(409).json({error:'Question time has expired. Wait for the next question.'});const q=(await pool.query(`SELECT q.* FROM battle_questions bq JOIN questions q ON q.id=bq.question_id WHERE bq.battle_id=$1 AND bq.sort_order=$2`,[req.params.id,b.current_question])).rows[0];if(!q)return res.status(400).json({error:'Invalid battle question'});const sel=req.body?.selected_option==null?null:Number(req.body.selected_option);const isCorrect=sel!==null&&sel===q.answer;const timeMs=Math.max(0,Math.min(Number(b.seconds_per_question)*1000,b.current_question_started_at?Date.now()-new Date(b.current_question_started_at).getTime():0));const client=await pool.connect();try{await client.query('BEGIN');const ins=await client.query(`INSERT INTO battle_answers(battle_id,user_id,question_id,selected_option,is_correct,time_ms) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,[req.params.id,req.user.id,q.id,sel,isCorrect,timeMs]);if(!ins.rows[0]){await client.query('ROLLBACK');return res.status(409).json({error:'Already answered'})}const bonus=isCorrect?100+Math.max(0,20-Math.floor(timeMs/1000)):0;await client.query(`UPDATE battle_players SET score=score+$1,correct=correct+$2,answered=answered+1 WHERE battle_id=$3 AND user_id=$4`,[bonus,isCorrect?1:0,req.params.id,req.user.id]);const answered=(await client.query(`SELECT COUNT(*)::int c FROM battle_answers WHERE battle_id=$1 AND question_id=$2`,[req.params.id,q.id])).rows[0].c;if(answered>=2){const next=b.current_question+1;if(next>=b.question_count){const scores=(await client.query(`SELECT user_id,score FROM battle_players WHERE battle_id=$1 ORDER BY score DESC`,[req.params.id])).rows;const winner=scores[0]?.user_id||null;await client.query(`UPDATE battle_rooms SET status='completed',current_question=$1,winner_id=$2,finished_at=NOW(),updated_at=NOW() WHERE id=$3`,[next,winner,req.params.id]);for(const sp of scores){const xp=sp.user_id===winner?50:20;await client.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'battle',$2,$3)`,[sp.user_id,req.params.id,xp]);await client.query(`UPDATE users SET xp=xp+$1,level=GREATEST(1,((xp+$1)/500)::int+1),updated_at=NOW() WHERE id=$2`,[xp,sp.user_id])}}else await client.query(`UPDATE battle_rooms SET current_question=$1,current_question_started_at=NOW(),updated_at=NOW() WHERE id=$2 AND current_question=$3`,[next,req.params.id,b.current_question])}await client.query('COMMIT');res.json({ok:true,is_correct:isCorrect,score_bonus:bonus})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.post('/api/battles/:id/timeout',auth,async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const b=(await client.query(`SELECT * FROM battle_rooms WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];if(!b)return res.status(404).json({error:'Battle not found'});if(b.creator_id!==req.user.id&&b.accepted_by!==req.user.id)return res.status(403).json({error:'Not a participant'});if(b.status!=='active'){await client.query('ROLLBACK');return res.json({ok:true,status:b.status})}const elapsed=b.current_question_started_at?((Date.now()-new Date(b.current_question_started_at).getTime())/1000):0;if(elapsed < Number(b.seconds_per_question)){await client.query('ROLLBACK');return res.status(409).json({error:'Question timer has not expired'});}const q=(await client.query(`SELECT question_id FROM battle_questions WHERE battle_id=$1 AND sort_order=$2`,[b.id,b.current_question])).rows[0];if(q){const players=(await client.query(`SELECT user_id FROM battle_players WHERE battle_id=$1`,[b.id])).rows;for(const pl of players){const ins=await client.query(`INSERT INTO battle_answers(battle_id,user_id,question_id,selected_option,is_correct,time_ms) VALUES($1,$2,$3,NULL,FALSE,$4) ON CONFLICT DO NOTHING RETURNING user_id`,[b.id,pl.user_id,q.question_id,Number(b.seconds_per_question)*1000]);if(ins.rows[0])await client.query(`UPDATE battle_players SET answered=answered+1 WHERE battle_id=$1 AND user_id=$2 AND answered < $3`,[b.id,pl.user_id,b.question_count]);}}const next=Number(b.current_question)+1;if(next>=Number(b.question_count)){const scores=(await client.query(`SELECT user_id,score FROM battle_players WHERE battle_id=$1 ORDER BY score DESC,answered ASC`,[b.id])).rows;const winner=scores[0]?.user_id||null;await client.query(`UPDATE battle_rooms SET status='completed',current_question=$1,winner_id=$2,finished_at=NOW(),updated_at=NOW() WHERE id=$3`,[next,winner,b.id]);for(const sp of scores){const xp=sp.user_id===winner?50:20;await client.query(`INSERT INTO xp_ledger(user_id,action,source_id,xp_amount) VALUES($1,'battle',$2,$3)`,[sp.user_id,b.id,xp]);await client.query(`UPDATE users SET xp=xp+$1,level=GREATEST(1,((xp+$1)/500)::int+1),updated_at=NOW() WHERE id=$2`,[xp,sp.user_id]);}}else{await client.query(`UPDATE battle_rooms SET current_question=$1,current_question_started_at=NOW(),updated_at=NOW() WHERE id=$2`,[next,b.id]);}await client.query('COMMIT');res.json({ok:true,advanced:true})}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}});
app.post('/api/battles/:id/cancel',auth,async(req,res)=>{const q=await pool.query(`UPDATE battle_rooms SET status='cancelled',updated_at=NOW() WHERE id=$1 AND creator_id=$2 AND status='waiting' RETURNING id`,[req.params.id,req.user.id]);res.json({ok:!!q.rows[0]})});
app.get('/api/battles/history',auth,async(req,res)=>{const q=await pool.query(`SELECT r.id,r.status,r.subject,r.question_count,r.started_at,r.finished_at,r.winner_id,cu.name creator_name,au.name opponent_name,p.score FROM battle_rooms r JOIN battle_players p ON p.battle_id=r.id AND p.user_id=$1 JOIN users cu ON cu.id=r.creator_id LEFT JOIN users au ON au.id=CASE WHEN r.creator_id=$1 THEN r.accepted_by ELSE r.creator_id END WHERE r.status='completed' ORDER BY r.finished_at DESC LIMIT 50`,[req.user.id]);res.json({battles:q.rows})});

attachNexusV53Routes(app,pool,auth,admin);

app.use(async(req,res)=>res.status(404).sendFile(path.join(__dirname,'public',await hasValidSession(req)?'index.html':'login.html')));
const port=process.env.PORT||3000;
async function initializeDatabase(){
  const dbEnc=await pool.query("SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname=current_database()");
  if(dbEnc.rows[0]?.encoding!=='UTF8')throw new Error(`PostgreSQL database encoding must be UTF8; current encoding is ${dbEnc.rows[0]?.encoding||'unknown'}`);
  await pool.query("SET client_encoding TO 'UTF8'");
  const schemaPath=path.join(__dirname,'schema.sql');
  const schema=fs.readFileSync(schemaPath,'utf8');
  await pool.query(schema);
  await pool.query(`CREATE TABLE IF NOT EXISTS hindi_translation_cache (question_id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, question_hi TEXT NOT NULL, options_hi JSONB NOT NULL DEFAULT '[]'::jsonb, explanation_hi TEXT, translation_model TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const qcols=await pool.query("SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='questions' AND column_name IN ('question_en','question_hi','options','answer','explanation_en','explanation_hi')");
  const qmap=Object.fromEntries(qcols.rows.map(r=>[r.column_name,r]));
  for(const c of ['question_en','question_hi','explanation_en','explanation_hi'])if(qmap[c]&&!['text','character varying'].includes(qmap[c].data_type))throw new Error(`questions.${c} must be TEXT/VARCHAR; found ${qmap[c].data_type}`);
  if(qmap.options&&qmap.options.udt_name!=='jsonb')throw new Error(`questions.options must be JSONB; found ${qmap.options.data_type}`);

  // Production compatibility migrations. Older DHYEYA databases may already
  // contain these tables with an earlier column set. CREATE TABLE IF NOT EXISTS
  // does not add missing columns, so explicitly reconcile them before APIs run.
  const hasColumn = async (table, column) => {
    const r = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2 LIMIT 1`, [table, column]);
    return r.rowCount > 0;
  };
  const addColumn = async (table, column, definition) => {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
  };

  // Notifications compatibility. This fixes legacy databases where the
  // notifications table existed before type/link/created_by were introduced.
  if (await hasColumn('notifications','id')) {
    await addColumn('notifications','type',"TEXT NOT NULL DEFAULT 'announcement'");
    await addColumn('notifications','link','TEXT');
    await addColumn('notifications','created_by','UUID');
    await addColumn('notifications','created_at','TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  }
  if (await hasColumn('notification_recipients','notification_id')) {
    await addColumn('notification_recipients','user_id','UUID');
    await addColumn('notification_recipients','read_at','TIMESTAMPTZ');
  }

  // Presence compatibility.
  if (await hasColumn('user_presence','user_id')) {
    await addColumn('user_presence','last_seen_at','TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  }

  // Challenge Everyone compatibility.
  if (await hasColumn('battle_rooms','id')) {
    await addColumn('battle_rooms','challenge_total','INTEGER');
    await addColumn('battle_rooms','creator_score','INTEGER');
    await addColumn('battle_rooms','creator_correct','INTEGER');
    await addColumn('battle_rooms','creator_time_seconds','INTEGER');
    await addColumn('battle_rooms','challenge_expires_at','TIMESTAMPTZ');
    await addColumn('battle_rooms','challenge_meta',"JSONB NOT NULL DEFAULT '{}'::jsonb");
  }

  // Battle compatibility.
  if (await hasColumn('battle_rooms','id')) {
    await addColumn('battle_rooms','creator_id','UUID');
    await addColumn('battle_rooms','accepted_by','UUID');
    await addColumn('battle_rooms','status',"TEXT NOT NULL DEFAULT 'waiting'");
    await addColumn('battle_rooms','mode',"TEXT NOT NULL DEFAULT 'standard'");
    await addColumn('battle_rooms','subject','TEXT');
    await addColumn('battle_rooms','question_count','INTEGER NOT NULL DEFAULT 20');
    await addColumn('battle_rooms','seconds_per_question','INTEGER NOT NULL DEFAULT 20');
    await addColumn('battle_rooms','current_question','INTEGER NOT NULL DEFAULT 0');
    await addColumn('battle_rooms','started_at','TIMESTAMPTZ');
    await addColumn('battle_rooms','finished_at','TIMESTAMPTZ');
    await addColumn('battle_rooms','winner_id','UUID');
    await addColumn('battle_rooms','created_at','TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn('battle_rooms','updated_at','TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    await addColumn('battle_rooms','current_question_started_at','TIMESTAMPTZ');
  }
  if (await hasColumn('battle_players','battle_id')) {
    await addColumn('battle_players','user_id','UUID');
    await addColumn('battle_players','score','INTEGER NOT NULL DEFAULT 0');
    await addColumn('battle_players','correct','INTEGER NOT NULL DEFAULT 0');
    await addColumn('battle_players','answered','INTEGER NOT NULL DEFAULT 0');
  }
  if (await hasColumn('battle_questions','battle_id')) {
    await addColumn('battle_questions','question_id','TEXT');
    await addColumn('battle_questions','sort_order','INTEGER NOT NULL DEFAULT 0');
  }
  if (await hasColumn('battle_answers','battle_id')) {
    await addColumn('battle_answers','user_id','UUID');
    await addColumn('battle_answers','question_id','TEXT');
    await addColumn('battle_answers','selected_option','INTEGER');
    await addColumn('battle_answers','is_correct','BOOLEAN NOT NULL DEFAULT FALSE');
    await addColumn('battle_answers','time_ms','INTEGER NOT NULL DEFAULT 0');
    await addColumn('battle_answers','answered_at','TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  }

  // Legacy battle question IDs were sometimes UUID typed. If there are no
  // battle rows yet, safely normalize those columns to TEXT because the
  // canonical questions.id is TEXT.
  for (const table of ['battle_questions','battle_answers']) {
    if (await hasColumn(table,'question_id')) {
      const typ = await pool.query(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='question_id'`,[table]);
      if (typ.rows[0]?.data_type === 'uuid') {
        const cnt = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
        if (cnt.rows[0].c === 0) await pool.query(`ALTER TABLE ${table} ALTER COLUMN question_id TYPE TEXT USING question_id::text`);
      }
    }
  }

  // Legacy-safe indexes: create only after all compatibility ALTER TABLE
  // statements have completed, and only when the referenced columns exist.
  if (await hasColumn('test_questions','test_id') && await hasColumn('test_questions','sort_order')) {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_test_questions_order ON test_questions(test_id,sort_order)');
  }
  if (await hasColumn('test_questions','test_id') && await hasColumn('test_questions','question_id')) {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_test_questions_pair ON test_questions(test_id,question_id) WHERE test_id IS NOT NULL AND question_id IS NOT NULL');
  }
  if (await hasColumn('question_attempts','user_id') && await hasColumn('question_attempts','question_id')) {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_question_attempts_user_question ON question_attempts(user_id,question_id)');
  }
  if (await hasColumn('battle_answers','battle_id') && await hasColumn('battle_answers','question_id')) {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_battle_answers_room ON battle_answers(battle_id,question_id)');
  }
  // Support messaging schema: use the legacy-compatible support_threads model.
  // Some existing DHYEYA databases already contain support_threads/support_messages
  // from the earlier support build, so do not create a second incompatible ticket schema.
  await pool.query(`CREATE TABLE IF NOT EXISTS support_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL DEFAULT 'General Support',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_role TEXT NOT NULL CHECK (sender_role IN ('student','admin')),
    message TEXT NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_support_thread_user ON support_threads(user_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_support_threads_status_time ON support_threads(status,last_message_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_support_messages_thread_time ON support_messages(thread_id,created_at ASC)');
  console.log('Database schema initialized/verified');
}
await import('./niva-addon.mjs').then(m=>m.attachNivaRoutes(app));

app.listen(port,async()=>{
  try{
    await initializeDatabase();
    await ensureNexusV53(pool);
    await bootstrapAdmin();
    await import('./vault-seed.mjs').then(m=>m.seedBundledVault(pool,__dirname));
    console.log('DHYEYA running on :'+port);
  }catch(e){
    console.error('Startup initialization failed:',e);
    process.exit(1);
  }
});;
