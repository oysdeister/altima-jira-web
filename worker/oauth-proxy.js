// Proxy mínimo para la versión web del panel (Cloudflare Workers, plan gratuito).
// Hace dos cosas:
//   POST /oauth/token  -> añade el client secret de Atlassian al intercambio de código o a la renovación
//   ANY  /jira/<ruta>  -> reenvía a api.atlassian.com/ex/jira/<cloudId>/<ruta> (solo si ALTIMA_WEB.jiraViaProxy = true)
// No guarda tokens ni datos: el navegador conserva su refresh token y lo envía al renovar.
// Variables del Worker:  ALLOWED_ORIGIN (p. ej. https://<usuario>.github.io), ATLASSIAN_CLIENT_ID, CLOUD_ID
// Secreto del Worker:    ATLASSIAN_CLIENT_SECRET  (wrangler secret put ATLASSIAN_CLIENT_SECRET)
export default {
  async fetch(req, env){
    const origin = req.headers.get('Origin') || '';
    const cors = {'Access-Control-Allow-Origin':env.ALLOWED_ORIGIN, 'Access-Control-Allow-Headers':'Authorization, Content-Type', 'Access-Control-Allow-Methods':'GET, POST, PUT, DELETE', 'Vary':'Origin'};
    if(req.method === 'OPTIONS') return new Response(null, {status:204, headers:cors});
    if(origin !== env.ALLOWED_ORIGIN) return new Response('Origen no permitido', {status:403});
    const url = new URL(req.url);

    if(url.pathname === '/oauth/token' && req.method === 'POST'){
      const b = await req.json().catch(() => ({}));
      const body = b.grant_type === 'authorization_code' ? {grant_type:'authorization_code', code:b.code, redirect_uri:b.redirect_uri}
        : b.grant_type === 'refresh_token' ? {grant_type:'refresh_token', refresh_token:b.refresh_token} : null;
      if(!body) return new Response('grant_type no válido', {status:400, headers:cors});
      const r = await fetch('https://auth.atlassian.com/oauth/token', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...body, client_id:env.ATLASSIAN_CLIENT_ID, client_secret:env.ATLASSIAN_CLIENT_SECRET})});
      return new Response(r.body, {status:r.status, headers:{...cors, 'Content-Type':'application/json', 'Cache-Control':'no-store'}});
    }

    if(url.pathname.startsWith('/jira/')){
      const target = `https://api.atlassian.com/ex/jira/${env.CLOUD_ID}/${url.pathname.slice(6)}${url.search}`;
      const r = await fetch(target, {method:req.method, headers:{Authorization:req.headers.get('Authorization') || '', Accept:'application/json', 'Content-Type':'application/json'},
        body:['GET', 'HEAD'].includes(req.method) ? undefined : await req.text()});
      const h = new Headers(cors); for(const k of ['Content-Type', 'Retry-After']) if(r.headers.get(k)) h.set(k, r.headers.get(k));
      return new Response(r.body, {status:r.status, headers:h});
    }
    return new Response('No encontrado', {status:404, headers:cors});
  },
};
