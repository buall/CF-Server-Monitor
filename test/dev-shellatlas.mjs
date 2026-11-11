// Isolated, loopback-only integration fixture. Runs the real bundled Worker, D1
// and Durable Object. Only the Cloudflare Access edge and metrics source are fixtures.
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = process.env.SHELLATLAS_FIXTURE_DIR || '/tmp/shellatlas-monitor-runtime';
const themeDir = process.env.SHELLATLAS_THEME_FIXTURE || '/tmp/cfsm-shellatlas-analysis-20261111/lumina/dist';
await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
const issuer = 'https://local-test.cloudflareaccess.com';
const audience = 'local-shellatlas-test';
const clientId = 'local-shellatlas.access';
let savedCredentials;
try { savedCredentials=JSON.parse(await readFile(path.join(runtimeDir,'cfsm-fixture.json'),'utf8')); } catch {}
const clientSecret = savedCredentials?.clientSecret || randomBytes(24).toString('hex');
const agentSecret = savedCredentials?.agentSecret || randomBytes(24).toString('hex');
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = {...await exportJWK(publicKey), kid:'local-test',alg:'RS256'};
const contentType = file => ({'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.webp':'image/webp'}[path.extname(file)] || 'application/octet-stream');
async function fileResponse(directory, name) {
  const target = path.resolve(directory, name);
  if (!target.startsWith(`${path.resolve(directory)}${path.sep}`)) return new Response('Not found',{status:404});
  try { return new Response(await readFile(target),{headers:{'Content-Type':contentType(target)}}); }
  catch { return new Response('Not found',{status:404}); }
}
const mf = new Miniflare({
  modules:true, script:await readFile(path.join(root,'.wrangler/shellatlas-build/index.js'),'utf8'), compatibilityDate:'2024-12-01', compatibilityFlags:['nodejs_compat'],
  d1Databases:{DB:'shellatlas-local'}, durableObjects:{METRICS_BROADCASTER:{className:'MetricsBroadcaster',useSQLite:true}},
  d1Persist:path.join(runtimeDir,'cfsm-d1'), durableObjectsPersist:path.join(runtimeDir,'cfsm-do'),
  bindings:{ API_SECRET:agentSecret, SHELLATLAS_ACCESS_TEAM_DOMAIN:issuer, SHELLATLAS_ACCESS_AUD:audience, SHELLATLAS_ACCESS_CLIENT_ID:clientId, SHELLATLAS_EMBED_THEME:'luminaplus' },
  serviceBindings:{ASSETS:request => fileResponse(path.join(root,'dist'),new URL(request.url).pathname.slice(1))},
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.origin===issuer && url.pathname==='/cdn-cgi/access/certs') return Response.json({keys:[jwk]});
    if (url.hostname==='raw.githubusercontent.com' && url.pathname.startsWith('/volcano-1025/CFSM-Theme-LuminaPlus/')) {
      return fileResponse(themeDir,url.pathname.split('/').slice(4).join('/'));
    }
    return new Response('External network disabled in local integration fixture',{status:503});
  }
});
await mf.ready;
const assertion = () => new SignJWT({sub:'',common_name:clientId}).setProtectedHeader({alg:'RS256',kid:'local-test'})
  .setIssuedAt().setIssuer(issuer).setAudience(audience).setExpirationTime('10m').sign(privateKey);
const authorized = request => request.headers['cf-access-client-id']===clientId && request.headers['cf-access-client-secret']===clientSecret;
async function dispatch(request,body) {
  const headers = new Headers();
  for(const [key,value] of Object.entries(request.headers)) if(value && !['host','connection','content-length','cf-access-jwt-assertion'].includes(key)) headers.set(key,Array.isArray(value)?value.join(','):value);
  if(authorized(request)) headers.set('Cf-Access-Jwt-Assertion',await assertion());
  return mf.dispatchFetch(`http://127.0.0.1:8890${request.url}`,{method:request.method,headers,...(body?.length?{body}:{} )});
}
const server=createServer(async(request,response)=>{
  try {
    if(request.url.startsWith('/integrations/')&&!authorized(request)){response.writeHead(401);response.end('Local fixture service credentials required');return;}
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const upstream=await dispatch(request,Buffer.concat(chunks));
    response.writeHead(upstream.status,Object.fromEntries(upstream.headers));response.end(Buffer.from(await upstream.arrayBuffer()));
  }catch(error){console.error('Fixture request failed:',error.message);response.writeHead(500);response.end('Fixture error');}
});
const sockets=new WebSocketServer({noServer:true});
server.on('upgrade',async(request,socket,head)=>{
  try {
    if(!authorized(request)){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
    const upstream=await dispatch(request);
    if(upstream.status!==101||!upstream.webSocket){socket.end(`HTTP/1.1 ${upstream.status} Rejected\r\n\r\n`);return;}
    const worker=upstream.webSocket;worker.accept();
    sockets.handleUpgrade(request,socket,head,client=>{
      client.on('message',(data,binary)=>worker.send(binary?data:data.toString()));
      worker.addEventListener('message',event=>client.send(event.data));
      client.on('close',()=>{try{worker.close();}catch{}});
      worker.addEventListener('close',()=>{try{client.close();}catch{}});
      worker.addEventListener('error',()=>client.close());
    });
  }catch{socket.end('HTTP/1.1 500 Fixture Error\r\n\r\n');}
});
await new Promise(resolve=>server.listen(8890,'127.0.0.1',resolve));
await writeFile(path.join(runtimeDir,'cfsm-fixture.json'),JSON.stringify({baseUrl:'http://127.0.0.1:8890',clientId,clientSecret,agentSecret}),{mode:0o600});
// Initialize the real Worker database using its existing initialization endpoint.
await mf.dispatchFetch('http://127.0.0.1:8890/api/config');
console.log('Real CFSM Worker + D1 + DO running behind local Access fixture at http://127.0.0.1:8890');
console.log(`Fixture credentials saved privately in ${runtimeDir}/cfsm-fixture.json`);
process.on('SIGTERM',()=>{server.close();void mf.dispose().then(()=>process.exit(0));});
