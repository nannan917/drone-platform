import { fail } from './management.js';
export function sameOrigin(req){if(!req.headers.origin)return true;try{return new URL(req.headers.origin).host===req.headers.host;}catch{return false;}}
export function sessionToken(req){return (req.headers.authorization||'').replace(/^Bearer /,'') || /(?:^|;\s*)platform_session=([^;]+)/.exec(req.headers.cookie||'')?.[1] || '';}
export async function jsonBody(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>15*1024*1024)fail('请求超过 15MB',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail('无效 JSON');}}
export async function managementRoute(req,res,path,m,user){
  const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  try{
    if(!['GET','HEAD'].includes(req.method)&&!sameOrigin(req))fail('跨站请求被拒绝',403);
    if(path==='/api/v2/login'&&req.method==='POST'){
      const b=await jsonBody(req);const r=m.login(b.username,b.password,req.socket.remoteAddress);
      res.setHeader('set-cookie',`platform_session=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
      return send(200,{user:r.user});
    }
    m.require(user);
    if(path==='/api/v2/session')return send(200,{user});
    if(path==='/api/v2/logout'&&req.method==='POST'){m.sessions.delete(sessionToken(req));res.setHeader('set-cookie','platform_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
    if(path==='/api/v2/password'&&req.method==='POST')return send(200,m.password(user,await jsonBody(req)));
    if(path==='/api/v2/snapshot'&&req.method==='GET')return send(200,m.snapshot(user));
    if(path==='/api/v2/fences/import'&&req.method==='POST')return send(201,m.importFences(user,await jsonBody(req)));
    let match=path.match(/^\/api\/v2\/plans\/([^/]+)\/(submit|approve|reject|start|complete|cancel)$/);
    if(match&&req.method==='POST')return send(200,m.planAction(user,match[1],match[2],await jsonBody(req)));
    match=path.match(/^\/api\/v2\/alerts\/([^/]+)\/process$/);
    if(match&&req.method==='POST')return send(200,m.alertAction(user,match[1],await jsonBody(req)));
    match=path.match(/^\/api\/v2\/media\/([^/]+)\/content$/);
    if(match&&req.method==='GET'){const r=m.get(user,'media',match[1]);const disposition=new URL(req.url,'http://local').searchParams.get('preview')==='1'?'inline':'attachment';res.writeHead(200,{'content-type':r.mime,'content-disposition':`${disposition}; filename*=UTF-8''${encodeURIComponent(r.filename||'download')}`,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(Buffer.from(r.contentBase64,'base64'));return;}
    match=path.match(/^\/api\/v2\/(templates|schedules|integrations)\/([^/]+)\/(dispatch|execute|connect)$/);
    if(match&&req.method==='POST'){m.authorizeWrite(user,match[1]);m.get(user,match[1],match[2]);fail('设备接口尚未接入，未发送控制或通知。可先保存本地预案。',409);}
    match=path.match(/^\/api\/v2\/([a-z]+)(?:\/([^/]+))?$/);
    if(match){const [,type,id]=match;if(req.method==='GET')return send(200,id?m.publicRecord(type,m.get(user,type,id)):m.list(user,type));if(req.method==='POST'&&!id)return send(201,m.put(user,type,await jsonBody(req)));if(req.method==='PUT'&&id)return send(200,m.put(user,type,await jsonBody(req),id));if(req.method==='DELETE'&&id)return send(200,m.remove(user,type,id));}
    fail('接口不存在',404);
  }catch(e){return send(e.status||500,{error:e.message});}
}
