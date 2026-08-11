import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync(process.argv[2],'utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/^"|"$/g,'')]}));
const sql=neon(env.DATABASE_URL);
const snap=async()=>{const r=await sql`SELECT count(*) FILTER (WHERE status='pending')::int p, count(*) FILTER (WHERE status='synced')::int s, coalesce(sum(attempts),0)::int t FROM sheet_shipping_sync_jobs`;return r[0]};
let prev=await snap();
console.log(`t=0분  대기 ${prev.p}  완료 ${prev.s}  누적시도 ${prev.t}`);
for(let i=1;i<=12;i++){
  await new Promise(r=>setTimeout(r,60000));
  const c=await snap();
  console.log(`t=${i}분  대기 ${c.p}  완료 ${c.s}(+${c.s-prev.s})  누적시도 ${c.t}(+${c.t-prev.t})`);
  prev=c;
  if(c.p===0){console.log('>>> 큐 전부 비었음');break}
}
const left=await sql`SELECT order_id, attempts, left(coalesce(last_error,''),50) e FROM sheet_shipping_sync_jobs WHERE status<>'synced' ORDER BY created_at`;
console.log('남은:',left.length?JSON.stringify(left):'없음');
