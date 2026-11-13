import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HostServices } from '../src/service.ts';
import { createHostServicesHandler } from '../src/server.ts';
import { equalSecret, referenceSignature } from '../src/crypto.ts';
import { requireThat, ServiceError } from '../src/errors.ts';

const secret=()=>randomBytes(32).toString('base64url');
const bearer=request=>/^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(request.headers.authorization??'')?.[1];
async function jsonBody(request){
 requireThat((request.headers['content-type']??'').split(';')[0]==='application/json','invalid_content_type','Use application/json',415);
 const chunks=[];let length=0;
 for await(const chunk of request){length+=chunk.length;requireThat(length<=262144,'body_too_large','Body exceeds 256 KiB',413);chunks.push(chunk);}
 let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{throw new ServiceError('invalid_json','Invalid JSON request');}
 requireThat(value&&typeof value==='object'&&!Array.isArray(value),'invalid_request','JSON object required');return value;
}
const publicOrder=order=>{const {launch,...value}=order;return value;};

/** Explicit local fixture: demo principals/reference money only. Never include this in a production gateway. */
export function createDemoBusinessServer({controlToken,packRoot,hostAppId='host-demo',tenantId='tenant-demo',publisherId='publisher-demo',appId='host-services-demo',environment='develop',allowedOrigins=[]}={}){
 requireThat(typeof controlToken==='string'&&controlToken.length>=32,'demo_configuration','HOST_DEMO_CONTROL_TOKEN requires at least 32 characters');
 requireThat(typeof packRoot==='string'&&/^[a-f0-9]{64}$/.test(packRoot),'demo_configuration','Set the compiled demo pack root');
 const clientSecret=secret(),callbackSecret=secret(),clientId='demo-business-backend';
 const application={hostAppId,tenantId,publisherId,appId,environment,version:'1',packRoot};
 // Existing native demo clients use v1; this fixture does not claim v2 revocation guarantees.
 const service=new HostServices({issuerSecret:secret(),identitySecret:secret(),applications:[{miniAppId:appId,publisherId,identityProtocol:'1.0',hostAppId,tenantId,environment,clientId,clientSecret,trustedPackRoots:[packRoot],allowedPaymentChannels:['reference'],authorizationPolicies:{profile:{purpose:'在此小程序展示您的昵称和头像',permissionVersion:'1'},phone:{purpose:'在此小程序关联您的已验证手机号',permissionVersion:'1'}}}],payments:{reference:{callbackSecret}}});
 const core=createHostServicesHandler(service),sessions=new Map();
 const business=token=>{const value=sessions.get(token);requireThat(value&&value.expiresAt>Date.now(),'invalid_business_session','Business session expired',401);service.session(value.accessToken);return value;};
 const server=createServer(async(request,response)=>{
  const send=(status,value)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(JSON.stringify(value));};
  try{
   const port=server.address()?.port,hosts=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
   requireThat(hosts.includes(request.headers.host),'demo_host_rejected','Loopback Host required',403);
   const origin=request.headers.origin;
   requireThat(!origin||allowedOrigins.includes(origin),'demo_origin_rejected','Origin is not allowed',403);
   if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
   if(request.method==='OPTIONS'){
    requireThat(Boolean(origin),'demo_origin_rejected','Origin required for preflight',403);
    response.writeHead(204,{'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'0'});response.end();return;
   }
   const path=new URL(request.url,'http://localhost').pathname;
   if(!path.startsWith('/demo/'))return await core(request,response);
   if(path==='/demo/host'&&request.method==='POST'){
    requireThat(equalSecret(bearer(request),controlToken),'invalid_demo_control','Native demo control credential required',401);
    const input=await jsonBody(request);requireThat(['demo-A','demo-B'].includes(input.principalId),'invalid_demo_principal','Use demo-A or demo-B');
    const issued=service.issueHostSession({hostAppId,tenantId,environment,principalId:input.principalId,principalEpoch:input.principalEpoch,profile:{nickName:`Local ${input.principalId}`},phone:'+8613800000000'});
    return send(201,{...issued,application,account:{principalId:input.principalId,epoch:issued.principalEpoch},referenceOnly:true});
   }
   if(path==='/demo/reference-confirm'&&request.method==='POST'){
    requireThat(equalSecret(bearer(request),controlToken),'invalid_demo_control','Native demo control credential required',401);
    const input=await jsonBody(request),order=service.launchForHost(input.hostAccessToken,input.orderId,input.selection);
    requireThat(order.channel==='reference'&&order.product==='app'&&order.launch?.kind==='reference','invalid_reference_order','Only an explicit reference order can be confirmed',403);
    const raw=JSON.stringify({eventId:`demo-${order.orderId}`,merchantOrderId:order.merchantOrderId,miniAppId:appId,transactionId:`demo-transaction-${order.orderId}`,amount:order.amount,currency:order.currency,status:'paid'}),timestamp=String(Math.floor(Date.now()/1000));
    service.notification('reference',{'x-reference-timestamp':timestamp,'x-reference-signature':referenceSignature(callbackSecret,timestamp,raw)},raw);
    return send(200,{orderId:order.orderId,referenceOnly:true,status:'paid'});
   }
   if(path==='/demo/login'&&request.method==='POST'){
    const input=await jsonBody(request),app=service.exchangeLogin(clientId,clientSecret,input.code),businessSession=secret();
    for(const [id,value] of sessions)if(value.expiresAt<=Date.now())sessions.delete(id);
    requireThat(sessions.size<4096,'demo_session_limit','Local demo session limit reached',503);
    sessions.set(businessSession,{accessToken:app.accessToken,expiresAt:Date.now()+app.expiresIn*1000});
    return send(200,{businessSession,appUserId:app.appUserId,expiresIn:app.expiresIn});
   }
   if(request.method==='GET'&&/^\/demo\/orders\/[A-Za-z0-9-]+$/.test(path)){
    const session=business(bearer(request));return send(200,publicOrder(service.getOrder(session.accessToken,path.split('/').at(-1))));
   }
   const input=await jsonBody(request),session=business(input.businessSession);
   if(path==='/demo/orders'&&request.method==='POST'){
    requireThat(input.productId==='reference-item','unknown_demo_product','Use the reference-item product');
    return send(201,publicOrder(await service.createOrder(session.accessToken,{channel:'reference',product:'app',amount:1,currency:'CNY',description:'Local reference item; no actual money',idempotencyKey:input.idempotencyKey})));
   }
   if(path==='/demo/phone'&&request.method==='POST')return send(200,service.exchangePhone(clientId,clientSecret,input.code,session.accessToken));
   if(path==='/demo/logout'&&request.method==='POST'){service.logoutApp(session.accessToken);sessions.delete(input.businessSession);return send(200,{loggedOut:true});}
   return send(404,{error:'not_found',message:'Unknown demo endpoint'});
  }catch(error){const known=error instanceof ServiceError;if(!response.headersSent)send(known?error.status:500,{error:known?error.code:'internal_error',message:known?error.message:'Internal demo error'});else response.end();}
 });
 server.requestTimeout=20000;server.headersTimeout=10000;server.on('close',()=>service.close());
 return {server,application};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const {server,application}=createDemoBusinessServer({controlToken:process.env.HOST_DEMO_CONTROL_TOKEN,packRoot:process.env.HOST_DEMO_PACK_ROOT,hostAppId:process.env.HOST_DEMO_HOST_APP_ID,tenantId:process.env.HOST_DEMO_TENANT_ID,publisherId:process.env.HOST_DEMO_PUBLISHER_ID,appId:process.env.HOST_DEMO_APP_ID,environment:process.env.HOST_DEMO_ENVIRONMENT,allowedOrigins:(process.env.HOST_DEMO_ALLOWED_ORIGINS??'').split(',').filter(Boolean)});
 const port=Number(process.env.HOST_DEMO_PORT??8787);requireThat(Number.isInteger(port)&&port>0&&port<65536,'demo_configuration','Invalid demo port');
 server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({referenceOnly:true,origin:`http://127.0.0.1:${port}`,application})));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close());
}
