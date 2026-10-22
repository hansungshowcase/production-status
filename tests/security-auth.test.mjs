import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authEnabled, authRequired, requireAuth, requireWorkerAction, resolveActor } from '../api/_lib/auth.js';
import { enforceAccessPolicy } from '../api/_lib/accessPolicy.js';
import { createPasswordCredential, verifyPasswordCredential } from '../api/_lib/authCredentialSchema.js';
import { decryptPrivateConfigRow, encryptPrivateConfigValue } from '../api/_lib/privateConfig.js';
import statusHandler from '../api/auth/status.js';
import salesHandler from '../api/auth/sales.js';
import adminHandler from '../api/auth/admin.js';
import workerHandler from '../api/auth/worker.js';
function response() { return { headers: {}, statusCode: 200, body: null, setHeader(k,v) { this.headers[k]=v; }, status(v) { this.statusCode=v; return this; }, json(v) { this.body=v; return this; } }; }

test('all users remain passwordless even when old authentication environment values exist', async () => {
  const keys=['AUTH_DISABLED','AUTH_REQUIRED','SALES_PASSWORD','ADMIN_PASSWORD','POSTGRES_URL'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try { process.env.AUTH_DISABLED='false';process.env.AUTH_REQUIRED='true';process.env.SALES_PASSWORD='old-setting';process.env.ADMIN_PASSWORD='old-setting';delete process.env.POSTGRES_URL;
    assert.equal(authEnabled(),false);assert.equal(authRequired(),false);
    for(const headers of [{},{authorization:'Bearer expired-session'},{cookie:'production_status_auth=expired-session'}]) {
      const r=response();const result=await requireAuth({headers,body:{actor:'신은철'}},r,{roles:['admin']});assert.equal(result._bypass,true);assert.equal(result.actor,'신은철');assert.equal(r.statusCode,200);
    }
    for(const [path,method,handler] of [['status','GET',statusHandler],['sales','POST',salesHandler],['admin','POST',adminHandler],['worker','POST',workerHandler]]) {
      const r=response();await handler({url:`/api/auth/${path}`,method,headers:{},body:{}},r);assert.equal(r.statusCode,200);assert.deepEqual(r.body,{enabled:false});assert.equal(r.headers['Set-Cookie'],undefined);
    }
  } finally {for(const key of keys) {if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
});

test('worker selection supplies the actor without a password or stale session restriction', async () => {
  const req={headers:{},body:{actor:'이먼'},auth:{role:'worker',actor:'거니'}};const r=response();const actor=await requireWorkerAction(req,r);assert.equal(actor.actor,'이먼');assert.equal(actor.role,'worker');assert.equal(r.statusCode,200);
  const missing=response();assert.equal(await requireWorkerAction({headers:{},body:{}},missing),null);assert.equal(missing.statusCode,400);
  assert.equal((await requireWorkerAction({headers:{},body:{assigned_worker:'이먼'}},response())).actor,'이먼');
});

test('passwordless audit actors preserve the selected salesperson, reporter and uploader', () => {
  assert.equal(resolveActor({body:{sales_person:'황보민수'}}),'황보민수');assert.equal(resolveActor({body:{reported_by:'이먼'}}),'이먼');assert.equal(resolveActor({body:{uploaded_by:'거니'}}),'거니');assert.equal(resolveActor({body:{actor:'김보수 팀장'}}),'김보수 팀장');assert.equal(resolveActor({body:{}}),'시스템');
});

test('normal read and mutation routes require no login while cron test-send remains disabled', async () => {
  for(const [method,url] of [['GET','/api/orders'],['GET','/api/stats'],['PATCH','/api/orders/10'],['POST','/api/photos'],['POST','/api/auth/worker'],['GET','/api/admin/risk']])assert.equal(await enforceAccessPolicy({method,url,headers:{}},response()),true);
  const r=response();assert.equal(await enforceAccessPolicy({method:'POST',url:'/api/cron/test-send',headers:{}},r),false);assert.equal(r.statusCode,404);
});

test('stored credential utilities retain independent salts without enabling login requirements', async () => {
  const a=await createPasswordCredential('abcdefghijklmnop'),b=await createPasswordCredential('abcdefghijklmnop');assert.notEqual(a.salt,b.salt);assert.equal(await verifyPasswordCredential('abcdefghijklmnop',{salt:a.salt,password_hash:a.passwordHash}),true);assert.equal(await verifyPasswordCredential('wrong-password-value',{salt:a.salt,password_hash:a.passwordHash}),false);assert.equal(authEnabled(),false);
});

test('encrypted webhook configuration retains fresh IV and key-bound authentication', () => {
  const prev=process.env.POSTGRES_URL;process.env.POSTGRES_URL='postgresql://app:wrapping-password@localhost/example';try{const a=encryptPrivateConfigValue('sheets.webhook_secret','sensitive-value'),b=encryptPrivateConfigValue('sheets.webhook_secret','sensitive-value');assert.notEqual(a.iv,b.iv);const row={key:a.key,ciphertext:a.ciphertext,iv:a.iv,auth_tag:a.authTag,key_version:a.keyVersion};assert.equal(decryptPrivateConfigRow(row),'sensitive-value');assert.throws(()=>decryptPrivateConfigRow({...row,key:'different.key'}));}finally{if(prev===undefined)delete process.env.POSTGRES_URL;else process.env.POSTGRES_URL=prev;}
});
