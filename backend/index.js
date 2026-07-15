import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const AI_KEY = process.env.OPENAI_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const DATA_DIR = process.env.DATA_DIR || process.env.RENDER_DISK_MOUNT_PATH || '/tmp/liferpg-data';
const DATA_FILE = path.join(DATA_DIR, 'progress.json');
const aiHits = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 }) : null;
let dbReady = false;
async function initDb() { if (!pool) return; await pool.query(`CREATE TABLE IF NOT EXISTS progress (user_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`); dbReady = true; }
function readStore() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; } }
function writeStore(store) { const tmp = `${DATA_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, DATA_FILE); }
async function getState(userId) { const id = String(userId); if (dbReady) { const r = await pool.query('SELECT state FROM progress WHERE user_id=$1', [id]); return r.rows[0]?.state || null; } return readStore()[id] || null; }
async function saveState(userId, state) { const id = String(userId); if (dbReady) { await pool.query('INSERT INTO progress(user_id,state,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=NOW()', [id, state]); return; } const store = readStore(); store[id] = state; writeStore(store); }
function json(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS'}); res.end(JSON.stringify(body)); }
function tokenFor(payload) { const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'); const p=Buffer.from(JSON.stringify({...payload,exp:Math.floor(Date.now()/1000)+86400})).toString('base64url'); const s=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${p}`).digest('base64url'); return `${h}.${p}.${s}`; }
function verifyToken(token) { try { const [h,p,s]=String(token||'').split('.'); if(!h||!p||!s)return null; const expected=crypto.createHmac('sha256',JWT_SECRET).update(`${h}.${p}`).digest('base64url'); if(s.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(s),Buffer.from(expected)))return null; const data=JSON.parse(Buffer.from(p,'base64url')); return data.exp>Date.now()/1000?data:null; } catch { return null; } }
function verifyTelegram(initData) { try { if(!BOT_TOKEN||!initData)return null; const params=new URLSearchParams(initData); const hash=params.get('hash'); params.delete('hash'); const check=Array.from(params.entries()).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n'); const secret=crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest(); const calc=crypto.createHmac('sha256',secret).update(check).digest('hex'); if(!hash||hash.length!==calc.length||!crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(calc)))return null; const user=JSON.parse(params.get('user')||'{}'); return user.id?user:null; } catch { return null; } }
async function body(req) { let raw=''; for await(const chunk of req)raw+=chunk; if(raw.length>300000)throw new Error('payload too large'); return raw?JSON.parse(raw):{}; }
function auth(req) { return verifyToken(req.headers.authorization?.replace(/^Bearer\s+/i,'')); }
function rateOk(userId) { const now=Date.now(), hits=(aiHits.get(String(userId))||[]).filter(x=>now-x<3600000); if(hits.length>=12)return false; hits.push(now); aiHits.set(String(userId),hits); return true; }
async function generate(b) { if(!AI_KEY)throw Object.assign(new Error('AI key is not configured'),{code:'config'}); const prompt=`Create 3 safe, concrete life-RPG quests as a JSON array. User story: ${String(b.narrative).slice(0,3500)} Goal: ${String(b.goal).slice(0,300)} Area: ${b.area||'growth'} Obstacles: ${(b.obstacles||[]).join(', ')} Minutes/day: ${b.minutesPerDay||20} Energy: ${b.energy||'normal'} Difficulty: ${b.difficulty||'normal'} Return only JSON objects with title, why, details, xpReward.`; const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${AI_KEY}`},body:JSON.stringify({model:MODEL,instructions:'Return only valid JSON without markdown.',input:prompt,store:false})}); if(r.status===429)throw Object.assign(new Error('AI rate limit'),{code:'limit'}); if(!r.ok)throw Object.assign(new Error(`AI ${r.status}`),{code:'upstream'}); const d=await r.json(); const text=d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||''; const a=text.indexOf('['), z=text.lastIndexOf(']'); if(a<0||z<a)throw Object.assign(new Error('Invalid AI JSON'),{code:'invalid'}); return JSON.parse(text.slice(a,z+1)).slice(0,3).map((q,i)=>({title:String(q.title||'Следующий шаг').slice(0,120),why:String(q.why||'Конкретный шаг к цели.').slice(0,220),details:String(q.details||'Сделай действие и отметь результат.').slice(0,320),xpReward:Math.max(10,Math.min(50,Number(q.xpReward)||15+i*5)),id:`ai-${Date.now()}-${i}`})); }
const server=http.createServer(async(req,res)=>{ if(req.method==='OPTIONS')return json(res,204,{}); try {
  if(req.url==='/health')return json(res,200,{ok:true,ai:!!AI_KEY,persistence:dbReady,database:dbReady});
  if(req.method==='POST'&&req.url==='/auth/telegram'){const b=await body(req),u=verifyTelegram(b.initData); if(!u)return json(res,401,{error:'Telegram auth failed'}); return json(res,200,{token:tokenFor({userId:u.id,name:u.first_name||''})});}
  const user=auth(req); if(!user&&(req.url.startsWith('/state')||req.url.startsWith('/journal')||req.url.startsWith('/campaign')))return json(res,401,{error:'Unauthorized'});
  if(req.method==='GET'&&req.url==='/state')return json(res,200,{state:await getState(user.userId)});
  if(req.method==='PUT'&&req.url==='/state'){const b=await body(req); if(!b.state||typeof b.state!=='object')return json(res,400,{error:'state is required'}); const state={...b.state,serverUpdatedAt:new Date().toISOString()}; await saveState(user.userId,state); return json(res,200,{ok:true,state});}
  if(req.method==='POST'&&req.url==='/journal'){const b=await body(req); if(typeof b.text!=='string'||!b.text.trim())return json(res,400,{error:'text is required'}); const current=await getState(user.userId)||{},log=Array.isArray(current.log)?current.log:[],entry={type:String(b.type||'Дневник').slice(0,40),text:b.text.trim().slice(0,1000),at:Date.now()}; log.push(entry); await saveState(user.userId,{...current,log:log.slice(-200),serverUpdatedAt:new Date().toISOString()}); return json(res,201,{ok:true,entry});}
  if(req.method==='POST'&&req.url==='/campaign/generate'){if(!rateOk(user.userId))return json(res,429,{error:'Слишком много AI-запросов. Попробуй через час.',retryAfter:3600}); const b=await body(req); if(typeof b.narrative!=='string'||b.narrative.trim().length<20||typeof b.goal!=='string'||!b.goal.trim())return json(res,400,{error:'Narrative and goal are required'}); const difficulty=['easy','normal','hard'].includes(b.difficulty)?b.difficulty:'normal'; try {const quests=await generate({...b,difficulty}); return json(res,201,{campaign:{title:'Твоя личная кампания',area:b.area||'growth',goal:b.goal,cadenceMinutes:b.minutesPerDay||20,difficulty},quests});} catch(e) {return json(res,e.code==='limit'?429:e.code==='config'?503:502,{error:e.code==='limit'?'AI временно ограничен. Попробуй позже.':'Не удалось создать персональные ветки. Попробуй позже.'});}}
  return json(res,404,{error:'Not found'});
 } catch(e) { console.error(e); return json(res,e.message==='payload too large'?413:400,{error:e.message==='payload too large'?'Payload too large':'Invalid request'}); } });
await initDb().catch(e=>console.error('Database init failed:',e.message));
server.listen(PORT,()=>console.log(`LifeRPG backend listening on ${PORT}; database=${dbReady}`));
