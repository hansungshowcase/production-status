import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync(process.argv[2],'utf8').split('\n').filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/^"|"$/g,'')]}));
const sql=neon(env.DATABASE_URL);
for(let i=0;i<6;i++){
  await new Promise(r=>setTimeout(r,60000));
  const r=await sql`SELECT j.order_id, j.status, j.attempts, j.last_error, o.client_name
    FROM sheet_shipping_sync_jobs j JOIN orders o ON o.id=j.order_id WHERE j.status<>'synced' ORDER BY j.attempts`;
  const [s]=await sql`SELECT count(*)::int c FROM sheet_shipping_sync_jobs WHERE status='synced'`;
  console.log(`\n[${i+1}분] 기입완료 ${s.c}건 / 미완료 ${r.length}건`);
  r.forEach(x=>console.log(`   주문 ${x.order_id} ${x.client_name} | ${x.status} 시도 ${x.attempts} | ${x.last_error||'-'}`));
}
