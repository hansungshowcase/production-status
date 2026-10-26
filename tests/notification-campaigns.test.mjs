import assert from 'node:assert/strict';
import test from 'node:test';
import { handleNotificationCampaigns } from '../api/notification-campaigns.js';
import { listNotificationCampaigns, saveNotificationCampaign, validateCampaignInput } from '../api/_lib/notificationCampaigns.js';

const input = (overrides = {}) => ({ audience: 'customer', name: '포장 후 리뷰 안내', subject: '리뷰 안내', text: '{고객명}님, {거래처명}에서 주문하신 제품의 리뷰 참여를 안내드립니다. 납기 {납기일}', trigger: 'packing_completed', delayDays: 3, ...overrides });
function fakeDb() {
 const rows = new Map(), queries = [];
 return { rows, queries, async execute(query) {
  queries.push(query);const a=query.args;
  if(query.sql.startsWith('SELECT')) return {rows: query.sql.includes('key LIKE') ? [...rows.values()].filter(row=>row.key.startsWith('sms.campaign.')).map(row=>({...row})) : rows.has(a[0]) ? [{...rows.get(a[0])}] : []};
  if(query.sql.startsWith('INSERT')) {const [key,ciphertext,iv,auth_tag,key_version]=a;assert.ok(key.startsWith('sms.campaign.'));rows.set(key,{key,ciphertext,iv,auth_tag,key_version});return {rows:[{key}]};}
  if(query.sql.startsWith('UPDATE')) {const [ciphertext,iv,auth_tag,key_version,key,expected]=a;if(rows.get(key)?.ciphertext!==expected)return {rows:[]};rows.set(key,{key,ciphertext,iv,auth_tag,key_version});return {rows:[{key}]};}
  throw Error('Unexpected database operation');
 } };
}
const response=()=>({statusCode:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(c){this.statusCode=c;return this},json(body){this.body=body;return this}});
const request=(method,body,query={})=>({method,body,query,url:'/api/notification-campaigns',headers:{origin:'https://production-status.vercel.app',host:'production-status.vercel.app','x-forwarded-proto':'https'}});

test('registration validates allowed audience, conditions and complete known placeholders',()=>{
 assert.equal(validateCampaignInput(input()).delayDays,3);
 for(const changes of [{status:'active'},{enabled:true},{key:'repairs.activation_at'},{trigger:'ship_orders'},{audience:'employee'},{delayDays:31},{text:'{전화번호}'},{text:'{고객명'},{text:'x'.repeat(2001)},{subject:''}])assert.throws(()=>validateCampaignInput(input(changes)));
 assert.equal(validateCampaignInput(input({audience:'employee',trigger:'manual',delayDays:0})).trigger,'manual');
});

test('shared encrypted draft registration and CAS edits preserve other settings and detect stale versions',async()=>{
 const old=process.env.POSTGRES_URL;process.env.POSTGRES_URL='postgres://test:unit-password@example.invalid/test';
 try{
  const db=fakeDb();db.rows.set('repairs.activation_at',{key:'repairs.activation_at',ciphertext:'untouched'});
  const saved=await saveNotificationCampaign(db,input());assert.equal(saved.status,'draft');assert.equal(saved.revision,1);
  assert.doesNotMatch(db.rows.get('sms.campaign.'+saved.id).ciphertext,/고객명|리뷰|unit-password/);
  assert.equal((await listNotificationCampaigns(db,'customer'))[0].text,input().text);assert.deepEqual(await listNotificationCampaigns(db,'employee'),[]);
  const attempts=await Promise.allSettled([saveNotificationCampaign(db,input({name:'수정 A',revision:1}),{id:saved.id}),saveNotificationCampaign(db,input({name:'수정 B',revision:1}),{id:saved.id})]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.status,409);
  const [current]=await listNotificationCampaigns(db);assert.equal(current.revision,2);assert.equal(db.rows.get('repairs.activation_at').ciphertext,'untouched');
  await assert.rejects(saveNotificationCampaign(db,input({revision:2}),{id:'blog'}),/ID/);
  assert.ok(db.queries.every(q=>!q.sql.includes('notification_log')&&!q.sql.includes('orders')));
 }finally{if(old===undefined)delete process.env.POSTGRES_URL;else process.env.POSTGRES_URL=old;}
});

test('API rejects cross-site writes and never accepts activation fields',async()=>{
 const db=fakeDb(),cross=request('POST',input());cross.headers.origin='https://untrusted.example';const denied=response();
 await handleNotificationCampaigns(cross,denied,{db,rateLimitCheck:()=>true});assert.equal(denied.statusCode,403);assert.equal(db.queries.length,0);
 const activation=response();await handleNotificationCampaigns(request('POST',input({status:'active'})),activation,{db,rateLimitCheck:()=>true});assert.equal(activation.statusCode,400);assert.equal(db.rows.size,0);
 const get=response();await handleNotificationCampaigns(request('GET'),get,{db,rateLimitCheck:()=>true});assert.equal(get.statusCode,200);assert.deepEqual(get.body.capabilities,{canRegister:true,canActivate:false});assert.equal(get.headers['Cache-Control'],'no-store');
 const del=response();await handleNotificationCampaigns(request('DELETE'),del,{db});assert.equal(del.statusCode,405);
});
