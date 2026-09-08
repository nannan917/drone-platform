import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Management } from '../src/management.js';
import { pointsFor, checkRoute } from '../src/planning.js';

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'management-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const m=new Management({dataDir:dir,bootstrapPassword:'test-password-123'});
  const {user:admin}=m.login('admin','test-password-123');
  const station=m.put(admin,'organizations',{name:'测试检查站'});
  const station2=m.put(admin,'organizations',{name:'另一检查站'});
  const createUser=(name,roleId,orgId)=>m.principal(m.get(admin,'users',m.put(admin,'users',{name,username:name,roleId,orgId,password:'test-password-123'}).id));
  const pilot=createUser('pilot1','pilot',station.id), reviewer=createUser('reviewer1','reviewer',station.id), hqReviewer=createUser('reviewer2','reviewer','hq');
  const asset=m.put(admin,'assets',{name:'测试机',kind:'无人机',serial:'test-001',droneId:'real-23',orgId:station.id});
  const person=m.put(admin,'pilots',{name:'飞手',orgId:station.id,grade:''});
  const route=m.put(admin,'routes',{name:'测试航线',orgId:station.id,mode:'waypoints',points:[[113,22],[113.001,22.001]],altitude:60,speed:5});
  const makePlan=()=>m.put(pilot,'plans',{name:'测试计划',assetId:asset.id,pilotId:person.id,routeId:route.id,startAt:'2030-01-01T00:00:00Z',endAt:'2030-01-01T01:00:00Z'});
  return {m,dir,admin,station,station2,createUser,pilot,reviewer,hqReviewer,asset,person,route,makePlan};
}

test('two-stage review, self-review denial, execution record and persistence',t=>{
  const {m,dir,pilot,reviewer,hqReviewer,makePlan}=setup(t);const p=makePlan();
  assert.throws(()=>m.planAction(pilot,p.id,'start'),{status:409});
  assert.equal(m.planAction(pilot,p.id,'submit').status,'station_review');
  assert.throws(()=>m.planAction({...pilot,permissions:['view','plans.approve']},p.id,'approve'),{status:403});
  assert.equal(m.planAction(reviewer,p.id,'approve').status,'hq_review');
  assert.throws(()=>m.planAction(reviewer,p.id,'approve'),{status:403});
  assert.equal(m.planAction(hqReviewer,p.id,'approve').status,'approved');
  assert.equal(m.planAction(pilot,p.id,'start').status,'running');
  assert.equal(m.planAction(pilot,p.id,'complete').status,'completed');
  const restored=new Management({dataDir:dir});assert.equal(restored.data.plans[0].status,'completed');assert.equal(restored.data.plans[0].history.length,5);
});
test('unit scopes, admin item endpoints, expiring read-only grants and archive protection',t=>{
  const {m,admin,station2,createUser,asset}=setup(t);
  const other=createUser('otheruser','admin',station2.id);
  assert.equal(m.list(other,'assets').length,0);assert.throws(()=>m.get(other,'assets',asset.id),{status:404});
  assert.throws(()=>m.get(other,'users','admin'),{status:403});assert.throws(()=>m.get(other,'integrations',m.data.integrations[0].id),{status:403});
  const grant=m.put(admin,'grants',{name:'协作查看',assetId:asset.id,orgId:station2.id,expiresAt:'2030-01-01T00:00:00Z'});
  assert.equal(m.list(other,'assets').length,1);assert.equal(m.canSeeDrone(other,'real-23'),true);
  assert.equal(m.canControlDrone(other,'real-23'),false);
  assert.throws(()=>m.put(other,'assets',{name:'篡改'},asset.id),{status:403});assert.throws(()=>m.remove(other,'assets',asset.id),{status:403});
  m.get(admin,'grants',grant.id).expiresAt='2000-01-01T00:00:00Z';assert.equal(m.canSeeDrone(other,'real-23'),false);
});
test('password changes invalidate sessions; public snapshots never expose password hashes or file bytes',t=>{
  const {m,admin}=setup(t);const login=m.login('admin','test-password-123');
  assert.ok(!JSON.stringify(m.snapshot(admin)).includes('passwordHash'));
  m.password(admin,{currentPassword:'test-password-123',password:'replacement-password'});
  assert.equal(m.session(login.token),null);assert.throws(()=>m.login('admin','test-password-123'),{status:401});
  assert.ok(m.login('admin','replacement-password').token);
});
test('media preserves full file, validates data and keeps upload metadata',t=>{
  const {m,admin}=setup(t);const bytes=Buffer.alloc(8000,65);
  const media=m.put(admin,'media',{name:'扫描件',kind:'审批扫描件',filename:'scan.txt',mime:'text/plain',contentBase64:bytes.toString('base64')});
  assert.equal(media.size,8000);assert.equal(media.contentBase64,undefined);assert.match(media.ocrStatus,/待接入/);
  assert.deepEqual(Buffer.from(m.get(admin,'media',media.id).contentBase64,'base64'),bytes);
  assert.throws(()=>m.put(admin,'media',{name:'坏文件',kind:'其他',mime:'text/plain',contentBase64:bytes.toString('base64')+'@'}),/无效/);
});
test('archive preserves history and cannot orphan active plans or schedules',t=>{
  const {m,admin,asset,route,makePlan}=setup(t);makePlan();
  assert.throws(()=>m.remove(admin,'assets',asset.id),{status:409});assert.throws(()=>m.remove(admin,'routes',route.id),{status:409});
  const dock=m.put(admin,'assets',{name:'测试机场',kind:'自动机场',serial:'dock-1'});
  m.put(admin,'schedules',{name:'巡控预案',assetId:dock.id,routeId:route.id,nextAt:'2030-01-01T00:00:00Z',intervalMinutes:30});
  assert.throws(()=>m.remove(admin,'assets',dock.id),{status:409});
  const disposable=m.put(admin,'assets',{name:'报废机',kind:'无人机',serial:'old1'});m.remove(admin,'assets',disposable.id);
  assert.ok(m.data.assets.find(x=>x.id===disposable.id).archived);assert.ok(m.data.audit.some(a=>a.action==='archive'&&a.recordId===disposable.id));
});
test('threshold alerts are deduplicated and require two recorded handling steps',t=>{
  const {m,admin}=setup(t);const r=m.put(admin,'traffic',{name:'汇总区域',people:11,peopleLimit:10,vehicles:2,vehicleLimit:3});
  m.put(admin,'traffic',{name:'汇总区域'},r.id);assert.equal(m.data.alerts.length,1);const a=m.data.alerts[0];
  assert.throws(()=>m.alertAction(admin,a.id,{note:''}),/不能为空/);
  assert.equal(m.alertAction(admin,a.id,{note:'人工确认'}).status,'handling');assert.equal(m.alertAction(admin,a.id,{note:'现场办结'}).status,'closed');assert.equal(a.history.length,2);
});
test('GeoJSON import is atomic and route checks catch a segment crossing a polygon',t=>{
  const {m,admin}=setup(t);const polygon={type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]};
  assert.throws(()=>m.importFences(admin,{features:[polygon,{type:'Point',coordinates:[0,0]}]}));assert.equal(m.data.fences.length,0);
  m.importFences(admin,{features:[polygon]});
  const route={points:[[-1,.5],[2,.5]],altitude:30};assert.equal(checkRoute(route,m.data.fences).passed,false);
  m.data.fences[0].kind='限飞区';m.data.fences[0].ceiling=30;assert.equal(checkRoute(route,m.data.fences).passed,true);route.altitude=31;assert.equal(checkRoute(route,m.data.fences).passed,false);
  assert.equal(pointsFor({mode:'orbit',center:[113,22],radius:100}).length,37);
  assert.ok(pointsFor({mode:'grid',points:[[113,22],[113.001,22.001]],spacing:50}).length>=4);
});
test('changed fences block previously approved execution',t=>{
  const {m,admin,pilot,reviewer,hqReviewer,makePlan}=setup(t);const p=makePlan();m.planAction(pilot,p.id,'submit');m.planAction(reviewer,p.id,'approve');m.planAction(hqReviewer,p.id,'approve');
  m.importFences(admin,{features:[{type:'Polygon',coordinates:[[[112,21],[114,21],[114,23],[112,23],[112,21]]]}]});
  assert.throws(()=>m.planAction(pilot,p.id,'start'),/围栏/);assert.equal(m.get(pilot,'plans',p.id).status,'approved');
});
test('telemetry records one armed interval with plan and pilot association',t=>{
  const {m,pilot,reviewer,hqReviewer,person,makePlan}=setup(t);const p=makePlan();m.planAction(pilot,p.id,'submit');m.planAction(reviewer,p.id,'approve');m.planAction(hqReviewer,p.id,'approve');m.planAction(pilot,p.id,'start');
  m.observeDrone({droneId:'real-23',armed:true});m.observeDrone({droneId:'real-23',armed:true});assert.equal(m.data.flights.length,1);assert.equal(m.data.flights[0].pilotId,person.id);
  m.observeDrone({droneId:'real-23',armed:false});assert.ok(m.data.flights[0].endedAt);assert.equal(m.data.flights[0].basis,'飞控解锁时段');
});
