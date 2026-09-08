import { randomBytes, scryptSync, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pointsFor, checkRoute, geometry, coordinate } from './planning.js';

export const PERMISSIONS = ['view','assets.write','plans.write','plans.approve','plans.execute','routes.write','pilots.write','media.write','alerts.write','traffic.write','templates.write','schedules.write','identity.write','integrations.write','control'];
const TYPES = ['assets','pilots','plans','routes','fences','media','alerts','traffic','templates','schedules','organizations','roles','users','grants','integrations'];
const ADMIN_TYPES = new Set(['organizations','roles','users','grants','integrations']);
const PERM = { fences:'routes.write', organizations:'identity.write',roles:'identity.write',users:'identity.write',grants:'identity.write' };
const now = () => new Date().toISOString();
export function fail(message, status=400) { throw Object.assign(new Error(message),{status}); }
function hashPassword(password, salt=randomBytes(16).toString('hex')) { return salt+':'+scryptSync(password,salt,64).toString('hex'); }
function passwordMatches(password, stored) {
  const [salt,hash]=String(stored).split(':');
  const actual=scryptSync(String(password),salt,64), expected=Buffer.from(hash,'hex');
  return expected.length===actual.length && timingSafeEqual(expected,actual);
}
function text(value,max=500) { return String(value??'').trim().slice(0,max); }
function required(value,label) { const result=text(value); if(!result)fail(label+'不能为空'); return result; }
export class Management {
  constructor(opts={}) {
    this.dir=opts.dataDir || process.env.DRONE_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)),'..','data');
    mkdirSync(this.dir,{recursive:true}); this.file=join(this.dir,'management.json');
    this.sessions=new Map(); this.attempts=new Map(); this.onChange=opts.onChange||(()=>{});
    if(existsSync(this.file)) this.data=JSON.parse(readFileSync(this.file,'utf8'));
    else {
      this.data=Object.fromEntries(TYPES.map((k)=>[k,[]])); this.data.audit=[]; this.data.flights=[];
      this.data.organizations=[{id:'hq',name:'深圳总站',parentId:null}];
      this.data.roles=[{id:'admin',name:'管理员',permissions:PERMISSIONS},{id:'pilot',name:'飞手',permissions:['view','plans.write','plans.execute','media.write']},{id:'reviewer',name:'审批员',permissions:['view','plans.approve']},{id:'viewer',name:'观察员',permissions:['view']}];
      const password=opts.bootstrapPassword||randomBytes(15).toString('base64url');
      this.data.users=[{id:'admin',username:'admin',name:'总站管理员',orgId:'hq',roleId:'admin',active:true,passwordHash:hashPassword(password)}];
      writeFileSync(join(this.dir,'bootstrap-admin.txt'),`平台地址：http://127.0.0.1:4000/\n用户名：admin（请输入英文 admin）\n密码：${password}\n请登录后在账号设置修改密码。此文件包含初始密码，请妥善保管。\n`,{mode:0o600});
      this.data.integrations=['视频回传','云台控制','气象','OCR','匿名客车流计数','火情检测','机场控制','喊话设备','通知终端'].map((name)=>({id:randomUUID(),name,status:'待接入',orgId:'hq',url:'',note:'未提供服务接口；当前仅支持本地记录。'}));
      this.data.templates=[{id:randomUUID(),name:'安全提醒',orgId:'hq',content:'请注意安全，保持通道畅通，服从现场工作人员指引。',createdAt:now()}];
      this.save();
    }
  }
  save(){ const tmp=this.file+'.tmp'; writeFileSync(tmp,JSON.stringify(this.data,null,2),{mode:0o600}); renameSync(tmp,this.file); }
  principal(user){ if(!user?.active)return null; const role=this.data.roles.find(x=>x.id===user.roleId); return {id:user.id,username:user.username,name:user.name,orgId:user.orgId,roleId:user.roleId,permissions:role?.permissions||[]}; }
  login(username,password,key='local') {
    const bucket=this.attempts.get(key)||{count:0,until:Date.now()+60000};
    if(Date.now()>bucket.until){bucket.count=0;bucket.until=Date.now()+60000;}
    if(bucket.count>=8)fail('尝试次数过多，请一分钟后重试',429);
    const user=this.data.users.find(u=>u.username===username&&u.active);
    if(!user||!passwordMatches(password,user.passwordHash)){bucket.count++;this.attempts.set(key,bucket);fail('账号或密码错误',401);}
    this.attempts.delete(key);const token=randomBytes(32).toString('hex');this.sessions.set(token,{userId:user.id,expires:Date.now()+8*3600000});
    this.audit(this.principal(user),'login','user',user.id);return {token,user:this.principal(user)};
  }
  session(token){const session=this.sessions.get(token); if(!session||session.expires<Date.now()){this.sessions.delete(token);return null;}return this.principal(this.data.users.find(u=>u.id===session.userId));}
  require(user,perm='view'){if(!user)fail('请先登录',401);if(!user.permissions.includes(perm))fail('没有此操作权限',403);}
  canSee(user,record){return !!user&&(user.orgId==='hq'||record.orgId===user.orgId||this.data.grants.some(g=>!g.archived&&g.assetId===record.id&&g.orgId===user.orgId&&Date.parse(g.expiresAt)>Date.now()));}
  applicableFences(user){return this.data.fences.filter(f=>f.orgId==='hq'||this.canSee(user,f));}
  canSeeDrone(user,id){return user?.orgId==='hq'||this.data.assets.some(a=>!a.archived&&a.droneId===id&&this.canSee(user,a));}
  canControlDrone(user,id){return user?.orgId==='hq'||this.data.assets.some(a=>!a.archived&&a.droneId===id&&a.orgId===user?.orgId);}
  audit(user,action,type,id,details={}){this.data.audit.push({id:randomUUID(),at:now(),actorId:user?.id||'system',actor:user?.name||'系统',orgId:user?.orgId||'hq',action,type,recordId:id,details});this.save();this.onChange();}
  publicRecord(type,r){const {passwordHash,contentBase64,...safe}=r;return safe;}
  list(user,type){this.require(user);if(!TYPES.includes(type))fail('未知资源',404);if(ADMIN_TYPES.has(type)){this.require(user,type==='integrations'?'integrations.write':'identity.write');if(user.orgId!=='hq')fail('仅总站可管理',403);}return this.data[type].filter(r=>!r.archived&&(ADMIN_TYPES.has(type)||(type==='fences'&&r.orgId==='hq')||this.canSee(user,r))).map(r=>this.publicRecord(type,type==='routes'?{...r,check:checkRoute(r,this.applicableFences(user))}:r));}
  get(user,type,id){this.require(user);if(!TYPES.includes(type))fail('未知资源',404);if(ADMIN_TYPES.has(type)){this.require(user,type==='integrations'?'integrations.write':'identity.write');if(user.orgId!=='hq')fail('仅总站可管理',403);}const r=this.data[type].find(r=>r.id===id&&!r.archived);if(!r||(!ADMIN_TYPES.has(type)&&!(type==='fences'&&r.orgId==='hq')&&!this.canSee(user,r)))fail('记录不存在或不在授权范围',404);return r;}
  authorizeWrite(user,type){this.require(user,PERM[type]||type+'.write');if(ADMIN_TYPES.has(type)&&user.orgId!=='hq')fail('仅总站可管理',403);}
  importFences(user,body){
    this.authorizeWrite(user,'fences');
    if(!Array.isArray(body.features)||!body.features.length||body.features.length>100)fail('一次导入 1–100 个 GeoJSON 要素');
    // Validate the complete batch before writing any records.
    const records=body.features.map((feature,i)=>{
      const properties=feature.properties||{};
      const r=this.validate(user,'fences',{name:properties.name||'导入围栏 '+(i+1),orgId:body.orgId,kind:properties.kind||'禁飞区',ceiling:properties.ceiling||0,enabled:properties.enabled!==false,geometry:feature});
      return {...r,id:randomUUID(),version:1,createdAt:now(),updatedAt:now()};
    });
    this.data.fences.push(...records);this.audit(user,'gis.import','fences',records.map(r=>r.id).join(','),{count:records.length});
    return {count:records.length,records};
  }
  validate(user,type,b,old={}) {
    const orgId=user.orgId==='hq'?text(b.orgId||old.orgId||'hq'):user.orgId;
    if(!this.data.organizations.some(o=>o.id===orgId&&!o.archived))fail('所属单位不存在');
    const r={...old,orgId,name:required(b.name??old.name,'名称')};
    const take=(fields)=>{for(const key of fields)if(b[key]!==undefined)r[key]=typeof b[key]==='string'?text(b[key],4000):b[key];};
    const ref=(collection,id)=>{const v=this.get(user,collection,id);if(v.orgId!==orgId&&user.orgId!=='hq'&&!this.canSee(user,v))fail('引用对象不在授权范围');return v;};
    if(type==='assets'){
      take(['kind','brand','model','serial','droneId','status','purchasedAt','specifications','lat','lon','videoUrl']);
      if(!['无人机','自动机场','摄像头','通知终端'].includes(r.kind))fail('设备类型无效');
      r.serial=required(r.serial,'设备序列号');if(this.data.assets.some(a=>!a.archived&&a.id!==old.id&&(a.serial===r.serial||(r.droneId&&a.droneId===r.droneId))))fail('序列号或飞控绑定已存在');
      r.status=r.status||'在用';if(!['入库','在用','维护','报废'].includes(r.status))fail('生命周期状态无效');
      if(r.lat!==undefined&&r.lat!==''&&r.lat!==null){r.lat=Number(r.lat);r.lon=Number(r.lon);if(!coordinate([r.lon,r.lat]))fail('设备坐标无效');}
      if(r.videoUrl&&!/^https?:\/\//i.test(r.videoUrl))fail('视频地址仅支持 HTTP(S)');
    }else if(type==='pilots') {take(['certificate','certificateExpires','training','grade','assessmentNote']);if(r.grade&&!text(r.assessmentNote))fail('人工评级需填写依据');}
    else if(type==='plans'){
      if(old.status&&!['draft','rejected'].includes(old.status))fail('仅草稿或退回的计划可修改',409);
      take(['assetId','pilotId','routeId','startAt','endAt','purpose','attachmentId']);
      if(!r.assetId||!r.pilotId||!r.routeId)fail('请选择设备、飞手和航线');
      const asset=ref('assets',r.assetId);if(asset.kind!=='无人机'||asset.status!=='在用')fail('请选择在用无人机');
      ref('pilots',r.pilotId);ref('routes',r.routeId);
      if(!Number.isFinite(Date.parse(r.startAt))||!(Date.parse(r.endAt)>Date.parse(r.startAt)))fail('任务起止时间无效');
      if(r.attachmentId)ref('media',r.attachmentId);
      r.status='draft';r.creatorId=old.creatorId||user.id;r.history=old.history||[];
    }else if(type==='routes'){
      take(['mode','points','center','radius','spacing','altitude','speed']);r.altitude=Number(r.altitude);r.speed=Number(r.speed);
      if(!(r.altitude>0&&r.altitude<=1000&&r.speed>0&&r.speed<=50))fail('高度需 0–1000 米，速度需 0–50 米/秒');
      r.generatedPoints=pointsFor(r);if(!r.generatedPoints.every(coordinate))fail('航线生成坐标越界');
      r.check=checkRoute(r,this.applicableFences(user));
    }else if(type==='fences'){
      take(['kind','ceiling','enabled','geometry']);r.geometry=geometry(r.geometry);if(!['禁飞区','限飞区'].includes(r.kind))fail('围栏类型无效');r.ceiling=Number(r.ceiling||0);if(!Number.isFinite(r.ceiling)||r.ceiling<0)fail('高度限制无效');
    }else if(type==='media'){
      take(['kind','planId','description','filename','mime','contentBase64']);if(r.planId)ref('plans',r.planId);
      if(!['审批扫描件','影像','日志','其他'].includes(r.kind))fail('资料类型无效');
      const allowed=['application/pdf','image/png','image/jpeg','text/plain','video/mp4'];if(!allowed.includes(r.mime))fail('支持 PDF、PNG、JPG、TXT、MP4');
      r.contentBase64=b.contentBase64||old.contentBase64;
      if(!r.contentBase64||! /^[A-Za-z0-9+/]*={0,2}$/.test(r.contentBase64))fail('文件内容无效');
      const bytes=Buffer.from(r.contentBase64,'base64');if(!bytes.length||bytes.length>10*1024*1024)fail('单文件最大 10MB');
      r.size=bytes.length;r.sha256=createHash('sha256').update(bytes).digest('hex');r.ocrStatus=r.kind==='审批扫描件'?'待接入 OCR，可人工登记':null;
    }else if(type==='alerts'){
      take(['category','severity','description','lat','lon','assetId']);if(!['设备异常','火情','客车流超限','人工事件'].includes(r.category))fail('事件类型无效');
      if(r.assetId)ref('assets',r.assetId);r.status=old.status||'new';r.history=old.history||[];
    }else if(type==='traffic'){
      take(['people','vehicles','peopleLimit','vehicleLimit','observedAt','source']);for(const k of ['people','vehicles','peopleLimit','vehicleLimit']){r[k]=Number(r[k]);if(!Number.isInteger(r[k])||r[k]<0)fail('流量及阈值需为非负整数');}
      r.source='人工录入汇总';r.observedAt=r.observedAt||now();r.exceeded=r.people>r.peopleLimit||r.vehicles>r.vehicleLimit;
    }else if(type==='templates'){take(['content']);r.content=required(r.content,'喊话内容');}
    else if(type==='schedules'){
      take(['assetId','routeId','intervalMinutes','enabled','nextAt','contingency']);const a=ref('assets',r.assetId);if(a.kind!=='自动机场')fail('巡控需关联自动机场');ref('routes',r.routeId);
      r.intervalMinutes=Number(r.intervalMinutes);if(!Number.isInteger(r.intervalMinutes)||r.intervalMinutes<5)fail('间隔至少 5 分钟');if(!Number.isFinite(Date.parse(r.nextAt)))fail('下次时间无效');
      r.executionStatus='待机场控制接口接入';
    }else if(type==='organizations'){if(old.id==='hq')r.parentId=null;else r.parentId='hq';}
    else if(type==='roles'){take(['permissions']);if(!Array.isArray(r.permissions)||r.permissions.some(p=>!PERMISSIONS.includes(p)))fail('权限配置无效');if(old.id==='admin')fail('内置管理员角色不可修改');}
    else if(type==='users'){
      take(['username','roleId','active']);r.username=required(r.username,'用户名');if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(r.username))fail('用户名使用 3–40 位字母数字');
      if(this.data.users.some(u=>u.id!==old.id&&u.username===r.username))fail('用户名已存在');if(!this.data.roles.some(x=>x.id===r.roleId&&!x.archived))fail('角色不存在');
      if(!old.id||b.password){if(String(b.password||'').length<12)fail('密码至少 12 位');r.passwordHash=hashPassword(b.password);}r.active=r.active!==false;
      if(old.id===user.id&&(!r.active||r.orgId!==user.orgId||r.roleId!==user.roleId))fail('不可停用或改变当前账号权限');
    }else if(type==='grants'){
      take(['assetId','expiresAt']);this.get(user,'assets',r.assetId);if(!(Date.parse(r.expiresAt)>Date.now()))fail('授权有效期须晚于当前时间');
    }else if(type==='integrations'){take(['url','note']);if(r.url&&!/^https?:\/\//i.test(r.url))fail('服务地址需为 HTTP(S)');r.status=r.url?'已登记地址，待适配联调':'待接入';}
    return r;
  }
  put(user,type,b,id){
    if(!TYPES.includes(type))fail('未知资源',404);this.authorizeWrite(user,type);const old=id?this.get(user,type,id):{};
    if(id&&user.orgId!=='hq'&&old.orgId!==user.orgId)fail('跨单位授权仅允许查看，不可修改归属单位记录',403);
    if(id&&b.version!==undefined&&b.version!==old.version)fail('记录已更新，请刷新后重试',409);
    const record=this.validate(user,type,b,old);record.id=id||randomUUID();record.createdAt=old.createdAt||now();record.updatedAt=now();record.version=(old.version||0)+1;
    if(id)this.data[type][this.data[type].indexOf(old)]=record;else this.data[type].push(record);
    if(type==='traffic'&&record.exceeded&&!this.data.alerts.some(a=>a.sourceId===record.id)){this.data.alerts.push({id:randomUUID(),name:record.name+'流量超限',orgId:record.orgId,category:'客车流超限',severity:'中',description:`人数 ${record.people}/${record.peopleLimit}，车辆 ${record.vehicles}/${record.vehicleLimit}`,status:'new',createdAt:now(),history:[],sourceId:record.id});}
    const changes={};for(const key of Object.keys(record)){if(['passwordHash','contentBase64'].includes(key))continue;if(JSON.stringify(old[key])!==JSON.stringify(record[key]))changes[key]={before:old[key]??null,after:record[key]};}
    this.audit(user,id?'update':'create',type,record.id,{changes});return this.publicRecord(type,record);
  }
  remove(user,type,id){this.authorizeWrite(user,type);const r=this.get(user,type,id);if(['admin','hq'].includes(id))fail('内置记录不可删除');
    if(user.orgId!=='hq'&&r.orgId!==user.orgId)fail('跨单位授权仅允许查看',403);
    if(type==='plans'&&!['draft','rejected','completed','cancelled'].includes(r.status))fail('进行中的计划不可归档',409);
    const refs={assets:'assetId',pilots:'pilotId',routes:'routeId',media:'attachmentId'};
    if(refs[type]&&this.data.plans.some(p=>!p.archived&&!['completed','cancelled','rejected'].includes(p.status)&&p[refs[type]]===id))fail('仍被未结束计划引用',409);
    if(['assets','routes'].includes(type)&&this.data.schedules.some(p=>!p.archived&&p[refs[type]]===id))fail('仍被巡控预案引用',409);
    if(type==='organizations'&&TYPES.some(t=>this.data[t].some(r=>!r.archived&&r.orgId===id)))fail('单位仍有用户或业务记录');
    if(type==='roles'&&this.data.users.some(u=>!u.archived&&u.roleId===id))fail('角色仍被用户使用');
    if(type==='users'){if(id===user.id)fail('不能删除当前账号');r.active=false;}
    r.archived=true;this.audit(user,'archive',type,id);return {ok:true};}
  planAction(user,id,action,body={}){
    const p=this.get(user,'plans',id);this.require(user,action==='approve'||action==='reject'?'plans.approve':action==='submit'?'plans.write':'plans.execute');
    if(body.version!==undefined&&body.version!==p.version)fail('审批记录已变化，请刷新',409);
    const before=p.status;let target;
    if(action==='submit'&&['draft','rejected'].includes(before)){
      const route=this.get(user,'routes',p.routeId);const check=checkRoute(route,this.applicableFences(user));if(!check.passed)fail('航线存在围栏冲突，请先调整');target='station_review';
    }else if(['approve','reject'].includes(action)&&['station_review','hq_review'].includes(before)){
      if(user.id===p.creatorId)fail('提交人不能审批自己的计划',403);if(before==='station_review'&&user.orgId!==p.orgId)fail('首级审批需由计划所属单位审批员完成',403);if(before==='hq_review'&&user.orgId!=='hq')fail('需总站审批',403);
      if(action==='reject'&&!text(body.comment))fail('请填写退回原因');target=action==='reject'?'rejected':before==='station_review'?'hq_review':'approved';
    }else if(action==='start'&&before==='approved'){
      const route=this.get(user,'routes',p.routeId);if(!checkRoute(route,this.applicableFences(user)).passed)fail('最新围栏校验不通过');
      const asset=this.get(user,'assets',p.assetId);if(asset.status!=='在用')fail('设备不在用');target='running';p.executionStartedAt=now();
    }else if(action==='complete'&&before==='running'){target='completed';p.completedAt=now();}
    else if(action==='cancel'&&['draft','approved'].includes(before))target='cancelled';
    else fail('当前状态不允许此操作',409);
    p.status=target;p.version=(p.version||0)+1;p.updatedAt=now();p.history.push({at:now(),actor:user.name,from:before,to:target,comment:text(body.comment)});
    this.audit(user,'plan.'+action,'plans',id,{from:before,to:target});return p;
  }
  alertAction(user,id,body){this.require(user,'alerts.write');const a=this.get(user,'alerts',id);const next={new:'handling',handling:'closed'}[a.status];if(!next)fail('事件已关闭');const note=required(body.note,'处置记录');a.history.push({at:now(),actor:user.name,note,status:next});a.status=next;this.audit(user,'alert.'+next,'alerts',id);return a;}
  password(user,body){if(!passwordMatches(body.currentPassword,this.data.users.find(u=>u.id===user.id).passwordHash))fail('当前密码不正确',403);if(String(body.password||'').length<12)fail('新密码至少 12 位');this.data.users.find(u=>u.id===user.id).passwordHash=hashPassword(body.password);for(const [k,v]of this.sessions)if(v.userId===user.id)this.sessions.delete(k);this.audit(user,'password.change','users',user.id);return {ok:true};}
  snapshot(user){this.require(user);const collections={};for(const t of TYPES){try{collections[t]=this.list(user,t);}catch{collections[t]=[];}}
    if(!collections.organizations.length)collections.organizations=this.data.organizations.filter(o=>o.id===user.orgId).map(o=>({id:o.id,name:o.name}));
    const plans=collections.plans, flights=this.data.flights.filter(f=>this.canSee(user,f));
    return {user,permissions:PERMISSIONS,collections,flights,audit:this.data.audit.filter(a=>this.canSee(user,a)).slice(-200).reverse(),summary:{assets:collections.assets.length,pending:plans.filter(p=>['station_review','hq_review'].includes(p.status)).length,running:plans.filter(p=>p.status==='running').length,openAlerts:collections.alerts.filter(a=>a.status!=='closed').length},capabilities:{video:'待接口接入',weather:'待接口接入',ocr:'待接口接入',dock:'待接口接入',anonymousCounts:'支持汇总录入，图像计数服务待接入',identity:'仅人工核验记录，不提供人脸身份识别'},updatedAt:now()};
  }
  observeDrone(d){
    const asset=this.data.assets.find(a=>!a.archived&&a.droneId===d.droneId);if(!asset)return;
    const active=this.data.flights.find(f=>f.droneId===d.droneId&&!f.endedAt);
    if(d.armed&&!active){const plan=this.data.plans.find(p=>p.assetId===asset.id&&p.status==='running');this.data.flights.push({id:randomUUID(),orgId:asset.orgId,droneId:d.droneId,pilotId:plan?.pilotId||null,planId:plan?.id||null,startedAt:now(),basis:'飞控解锁时段',durationSeconds:0});this.save();}
    if(!d.armed&&active){active.endedAt=now();active.durationSeconds=Math.max(0,Math.round((Date.now()-Date.parse(active.startedAt))/1000));this.save();}
  }
}
