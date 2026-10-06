import fs from 'node:fs';
import path from 'node:path';

function parsePart(file){
  const raw=fs.readFileSync(file,'utf8');
  const m=raw.match(/window\.__BPSC_RECORD_PARTS\[\d+\]=([\s\S]*);?\s*$/);
  if(!m) return [];
  try{return JSON.parse(m[1].replace(/;\s*$/,''));}catch(e){console.error('Vault parse failed',file,e.message);return []}
}
function mapSubject(label, chapter=''){
  const s=String(label||'').toLowerCase(); const c=String(chapter||'').toLowerCase();
  if(/science/.test(s)) return 'General Science';
  if(/bihar/.test(s)) return 'Bihar Special';
  if(/history/.test(s)||/ancient|medieval|modern/.test(s)) return s.includes('modern')?'Modern Indian History':s.includes('ancient')?'Ancient Indian History':s.includes('medieval')?'Medieval Indian History':'History';
  if(/polity|governance|constitution/.test(s)) return 'Indian Polity';
  if(/geography/.test(s)) return 'Geography';
  if(/economic|economy/.test(s)) return 'Indian Economy';
  if(/environment|ecology/.test(s)) return 'Environment & Ecology';
  if(/current/.test(s)) return 'Current Affairs';
  if(/polity|governance|constitution/.test(c)) return 'Indian Polity';
  return label||'General Studies';
}
export async function seedBundledVault(pool,root){
  if(!process.env.DATABASE_URL) return;
  try{
    const count=Number((await pool.query('SELECT COUNT(*)::int AS c FROM questions')).rows[0].c||0);
    if(count>0){console.log(`Question DB already populated (${count}); bundled vault seed skipped.`);return;}
    const files=fs.readdirSync(root).filter(x=>/^records-\d+\.js$/.test(x)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
    const all=files.flatMap(f=>parsePart(path.join(root,f)));
    if(!all.length){console.warn('No bundled question records found; seed skipped.');return;}
    const client=await pool.connect();
    try{await client.query('BEGIN');
      const chunk=250;
      for(let i=0;i<all.length;i+=chunk){
        const part=all.slice(i,i+chunk), vals=[], rows=[];
        for(let j=0;j<part.length;j++){
          const d=part[j]?.data||{}; const id=String(d.id||`${part[j].sourceIndex}-${part[j].originalIndex}`);
          const opts=Array.isArray(d.options)?d.options.map(o=>typeof o==='object'?String(o.en??o.text??o.label??''):String(o)):[];
          const answer=Number.isInteger(d.correct)?d.correct:null;
          const base=j*15;
          rows.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15})`);
          vals.push(id,mapSubject(part[j].sourceLabel,d.chapter),String(d.chapter||'').slice(0,500),String(d.subtopic||'').slice(0,500),Number.isFinite(Number(d.year))?Number(d.year):null,'english',String(d.question||''),null,JSON.stringify(opts),answer,String(d.explanation||''),null,null,String(part[j].sourceLabel||'BPSC Nexus Vault'),JSON.stringify({bundled:true,sourceFile:part[j].sourceFile||null,sourceIndex:part[j].sourceIndex,originalIndex:part[j].originalIndex,examInfo:d.examInfo||null}));
        }
        await client.query(`INSERT INTO questions(id,subject,topic,subtopic,year,language,question_en,question_hi,options,answer,explanation_en,explanation_hi,difficulty,source,metadata) VALUES ${rows.join(',')} ON CONFLICT(id) DO NOTHING`,vals);
        if((i/chunk)%10===0) console.log(`Vault seed: ${Math.min(i+part.length,all.length)}/${all.length}`);
      }
      await client.query('COMMIT'); console.log(`Bundled vault seeded: ${all.length} source records.`);
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }catch(e){console.error('Bundled vault seed failed:',e.message)}
}
