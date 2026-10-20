// Capa de adaptación para la versión web (GitHub Pages) del panel «Altima Jira».
// En claude.ai el panel usa window.claude.use('mcp' | 'db' | 'sample' | 'downloads' | 'files').
// Fuera de claude.ai no existe window.claude: este archivo lo crea con la MISMA interfaz, de modo que
// dashboard-artifact.html no cambia y su función call(tool, input) sigue igual; lo que cambia es quién atiende
// mcp.callTool(servidor, herramienta, entrada):
//   'Atlassian MCP'   -> API REST de Jira Cloud en api.atlassian.com con OAuth 2.0 (3LO)
//   'Google Calendar' -> Calendar API v3 con Google Identity Services (token en el navegador)
//   'Gmail'           -> Gmail API v1 (users.messages.send)
// y cada respuesta se devuelve con la forma que daban las herramientas MCP (issues.nodes, customFields, …).
// Se carga solo en la web: si window.claude ya existe (claude.ai), no hace nada.
'use strict';
(() => {
if(window.claude) return;
const CFG = window.ALTIMA_WEB || {};
const API = `https://api.atlassian.com/ex/jira/${CFG.cloudId}`;
const JIRA = CFG.jiraViaProxy ? `${CFG.proxyUrl}/jira` : API;   // por si algún POST no admitiera CORS directo
const LS = 'altima.web.';
const lsGet = (k) => { try{ return JSON.parse(localStorage.getItem(LS + k)); }catch{ return null; } };
const lsSet = (k, v) => { try{ v == null ? localStorage.removeItem(LS + k) : localStorage.setItem(LS + k, JSON.stringify(v)); }catch{} };
const fail = (code, message, extra) => Object.assign({code, message}, extra);

// ---------- Atlassian: OAuth 2.0 (3LO) ----------
// El intercambio de código y la renovación necesitan el client secret, que vive en el proxy (worker/oauth-proxy.js).
// Atlassian solo admite el flujo de código y rota el refresh token en cada uso: se guarda siempre el último.
const SCOPES = ['offline_access','read:jira-work','write:jira-work','read:jira-user','manage:jira-project',
  'read:board-scope:jira-software','read:sprint:jira-software','write:sprint:jira-software'];
function atlLogin(){
  const state = crypto.randomUUID(); sessionStorage.setItem(LS + 'state', state);
  const q = new URLSearchParams({audience:'api.atlassian.com', client_id:CFG.atlassianClientId, scope:SCOPES.join(' '),
    redirect_uri:CFG.redirectUri, state, response_type:'code', prompt:'consent'});
  location.assign('https://auth.atlassian.com/authorize?' + q);
}
async function tokenCall(body){
  const r = await fetch(`${CFG.proxyUrl}/oauth/token`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  if(!r.ok) throw fail('needs_reauth', 'Atlassian rechazó la sesión (' + r.status + ')');
  const t = await r.json();
  const tok = {access:t.access_token, refresh:t.refresh_token, exp:Date.now() + (t.expires_in - 60) * 1000};
  lsSet('atl', tok); return tok;
}
async function handleCallback(){   // vuelta de auth.atlassian.com con ?code=…&state=…
  const u = new URL(location.href), code = u.searchParams.get('code');
  if(!code) return;
  const ok = u.searchParams.get('state') === sessionStorage.getItem(LS + 'state');
  history.replaceState(null, '', u.pathname);
  if(ok) await tokenCall({grant_type:'authorization_code', code, redirect_uri:CFG.redirectUri});
}
let refreshing = null;
async function atlToken(){
  const t = lsGet('atl');
  if(!t?.refresh) throw fail('needs_reauth', 'Sin sesión de Atlassian');
  if(Date.now() < t.exp) return t.access;
  refreshing ??= tokenCall({grant_type:'refresh_token', refresh_token:t.refresh}).finally(() => { refreshing = null; });
  try{ return (await refreshing).access; }catch(e){ lsSet('atl', null); throw e; }
}
async function http(url, {method = 'GET', body, token, retry = true} = {}){
  const r = await fetch(url, {method, headers:{Authorization:'Bearer ' + token, Accept:'application/json', ...(body ? {'Content-Type':'application/json'} : {})}, body:body ? JSON.stringify(body) : undefined});
  if(r.status === 204) return {};
  const txt = await r.text(), data = txt ? (() => { try{ return JSON.parse(txt); }catch{ return {raw:txt}; } })() : {};
  if(r.ok) return data;
  const msg = [...(data.errorMessages || []), ...Object.values(data.errors || {})].join(' · ') || data.message || r.statusText;
  if(r.status === 401) throw fail('needs_reauth', msg);
  if(r.status === 429) throw fail('rate_limited', msg, {retryable:true, retryAfterMs:1000 * (+r.headers.get('Retry-After') || 3)});
  if(r.status >= 500) throw fail('server_unavailable', msg, {retryable:true});
  throw fail('tool_error', msg, {status:r.status});
}
const jira = async (path, opt) => http(JIRA + path, {...opt, token:await atlToken()});
const enc = encodeURIComponent;

// Los campos personalizados se devuelven también como hacía el MCP: fields.customFields[nombre] = {id, value}
function withCustom(issue, names = {}){
  const f = issue.fields || {}, cf = {};
  for(const [id, v] of Object.entries(f)) if(id.startsWith('customfield_') && v != null) cf[names[id] || id] = {id, value:v};
  return {...issue, fields:{...f, customFields:cf}};
}
const asSearch = (r) => ({
  issues:{nodes:(r.issues || []).map(i => withCustom(i, r.names)), pageInfo:{hasNextPage:!r.isLast && !!r.nextPageToken, endCursor:r.nextPageToken || null}},
  nextPageToken:r.nextPageToken || null, isLast:r.isLast !== false,
});
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// Herramienta MCP -> llamada REST (se usa la API v2 para que descripción y comentarios sean texto y no ADF)
const JIRA_TOOLS = {
  async atlassianUserInfo(){ const m = await jira('/rest/api/2/myself'); return {accountId:m.accountId, name:m.displayName, email:m.emailAddress}; },
  async searchJiraIssuesUsingJql({jql, maxResults = 50, fields, nextPageToken}){
    return asSearch(await jira('/rest/api/2/search/jql', {method:'POST', body:{jql, maxResults, fields, nextPageToken, expand:'names'}}));
  },
  async getJiraIssue({issueIdOrKey}){ const i = await jira(`/rest/api/2/issue/${enc(issueIdOrKey)}?expand=names`); return {issues:{nodes:[withCustom(i, i.names)]}}; },
  async listJiraIssueComments({issueIdOrKey, maxResults, orderBy}){ return jira(`/rest/api/2/issue/${enc(issueIdOrKey)}/comment?` + qs({maxResults, orderBy})); },
  async addOrEditJiraIssueComment({issueIdOrKey, commentBody, commentId, jsmCommentType}){
    const body = {body:commentBody, ...(jsmCommentType ? {properties:[{key:'sd.public.comment', value:{internal:jsmCommentType === 'internalNote'}}]} : {})};
    const base = `/rest/api/2/issue/${enc(issueIdOrKey)}/comment`;
    return commentId ? jira(`${base}/${enc(commentId)}`, {method:'PUT', body}) : jira(base, {method:'POST', body});
  },
  async editJiraIssue({issueIdOrKey, fields}){ await jira(`/rest/api/2/issue/${enc(issueIdOrKey)}`, {method:'PUT', body:{fields}}); return {ok:true}; },
  async createJiraIssue({projectKey, issueType, summary, description}){
    return jira('/rest/api/2/issue', {method:'POST', body:{fields:{project:{key:projectKey}, issuetype:{name:issueType}, summary, ...(description ? {description} : {})}}});
  },
  async transitionJiraIssue({issueIdOrKey, transitionId, fields, sprintId}){
    if(sprintId){ await jira(`/rest/agile/1.0/sprint/${enc(sprintId)}/issue`, {method:'POST', body:{issues:[issueIdOrKey]}}); return {ok:true}; }
    await jira(`/rest/api/2/issue/${enc(issueIdOrKey)}/transitions`, {method:'POST', body:{transition:{id:String(transitionId)}, ...(fields ? {fields} : {})}}); return {ok:true};
  },
  async listJiraIssueTransitions({issueIdOrKey}){ return jira(`/rest/api/2/issue/${enc(issueIdOrKey)}/transitions`); },
  async listJiraIssueWorklogs({issueIdOrKey, startedAfter, startedBefore, startAt, maxResults}){
    return jira(`/rest/api/2/issue/${enc(issueIdOrKey)}/worklog?` + qs({startedAfter, startedBefore, startAt, maxResults}));
  },
  async addOrEditJiraIssueWorklog({issueIdOrKey, worklogId, timeSpent, started, comment}){
    const body = {timeSpent, ...(started ? {started} : {}), ...(comment ? {comment} : {})}, base = `/rest/api/2/issue/${enc(issueIdOrKey)}/worklog`;
    return worklogId ? jira(`${base}/${enc(worklogId)}`, {method:'PUT', body}) : jira(base, {method:'POST', body});
  },
  async getJiraBoardSprintData({boardId}){
    const r = await jira(`/rest/agile/1.0/board/${enc(boardId)}/sprint?state=active`);
    return {resolvedSprint:(r.values || [])[0] || null};
  },
  async getJiraProjectVersions({projectIdOrKey, query, maxResults}){ return jira(`/rest/api/2/project/${enc(projectIdOrKey)}/version?` + qs({query, maxResults})); },
  async manageJiraProjectVersion({action, projectIdOrKey, name, startDate, releaseDate}){
    if(action !== 'create') throw fail('tool_error', 'Acción de versión no disponible en la web: ' + action);
    const p = await jira(`/rest/api/2/project/${enc(projectIdOrKey)}`);
    return jira('/rest/api/2/version', {method:'POST', body:{projectId:+p.id, name, startDate, releaseDate}});
  },
  async search(){ throw fail('tool_error', 'La búsqueda semántica de Rovo solo está disponible en claude.ai.'); },
};
// executeRead / executeWrite / executeDestructive {name, inputs} envuelven otra herramienta y devuelven {data}
for(const k of ['executeRead','executeWrite','executeDestructive'])
  JIRA_TOOLS[k] = async ({name, inputs}) => { const f = JIRA_TOOLS[name]; if(!f) throw fail('tool_error', 'Herramienta no disponible en la web: ' + name); return {data:await f(inputs || {})}; };

// ---------- Google: Identity Services (token de acceso en el navegador, sin secreto) ----------
const G_SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/gmail.send';
let gTok = null, gClient = null;
function gToken(){
  if(gTok && Date.now() < gTok.exp) return Promise.resolve(gTok.access);
  if(!window.google?.accounts?.oauth2) return Promise.reject(fail('server_not_connected', 'Google Identity Services no se ha cargado'));
  return new Promise((ok, ko) => {
    gClient = google.accounts.oauth2.initTokenClient({client_id:CFG.googleClientId, scope:G_SCOPES, hint:lsGet('gHint') || undefined,
      callback:(r) => { if(r.error) return ko(fail('approval_required', r.error)); gTok = {access:r.access_token, exp:Date.now() + (r.expires_in - 60) * 1000}; ok(gTok.access); },
      error_callback:(e) => ko(fail(e.type === 'popup_closed' ? 'cancelled' : 'approval_required', e.message || e.type))});
    gClient.requestAccessToken({prompt:''});
  });
}
const gapi = async (url, opt) => http(url, {...opt, token:await gToken()});
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const local = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };

const GOOGLE_TOOLS = {
  // suggest_time: freeBusy de todos los asistentes y huecos comunes calculados aquí
  async suggest_time({attendeeEmails, startTime, endTime, durationMinutes, preferences = {}}){
    const from = new Date(startTime), to = new Date(endTime);
    const fb = await gapi('https://www.googleapis.com/calendar/v3/freeBusy', {method:'POST', body:{timeMin:from.toISOString(), timeMax:to.toISOString(), timeZone:tz, items:attendeeEmails.map(id => ({id}))}});
    const busy = Object.values(fb.calendars || {}).flatMap(c => c.busy || []).map(b => [Date.parse(b.start), Date.parse(b.end)]);
    const [h0, m0] = (preferences.startHour || '09:00').split(':').map(Number), [h1, m1] = (preferences.endHour || '18:00').split(':').map(Number);
    const dur = durationMinutes * 60000, step = 30 * 60000, out = [];
    for(let t = from.getTime(); t + dur <= to.getTime() && out.length < (preferences.pageSize || 8); t += step){
      const a = new Date(t), z = new Date(t + dur), wd = a.getDay();
      if(preferences.excludeWeekends && (wd === 0 || wd === 6)) continue;
      if(a.getHours() * 60 + a.getMinutes() < h0 * 60 + m0 || z.getHours() * 60 + z.getMinutes() > h1 * 60 + m1 || z.getDate() !== a.getDate()) continue;
      if(busy.some(([s, e]) => s < t + dur && e > t)) continue;
      out.push({startTime:local(a), endTime:local(z)});
    }
    return {timeSlots:out};
  },
  async create_event({summary, startTime, endTime, attendees, addGoogleMeetUrl, description, notificationLevel, overrideReminders}){
    const body = {summary, description, attendees, start:{dateTime:startTime, timeZone:tz}, end:{dateTime:endTime, timeZone:tz},
      ...(overrideReminders ? {reminders:{useDefault:false, overrides:overrideReminders}} : {}),
      ...(addGoogleMeetUrl ? {conferenceData:{createRequest:{requestId:crypto.randomUUID(), conferenceSolutionKey:{type:'hangoutsMeet'}}}} : {})};
    const q = qs({conferenceDataVersion:addGoogleMeetUrl ? 1 : 0, sendUpdates:notificationLevel === 'NONE' ? 'none' : 'all'});
    return gapi('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + q, {method:'POST', body});
  },
  // send_message: MIME multipart (texto + HTML) en base64url. La firma de Gmail no se añade (pediría otro permiso).
  async send_message({to, cc, bcc, subject, body = '', htmlBody}){
    const list = (x) => [].concat(x || []).join(', '), b = 'altima' + Date.now();
    const h = (s) => /^[\x00-\x7f]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
    const part = (type, s) => [`--${b}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', b64(s)];
    const head = [`To: ${list(to)}`, cc && `Cc: ${list(cc)}`, bcc && `Bcc: ${list(bcc)}`, `Subject: ${h(subject)}`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`].filter(Boolean);
    const mime = [...head, '', ...part('text/plain', body), ...(htmlBody ? part('text/html', htmlBody) : []), `--${b}--`].join('\r\n');
    return gapi('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {method:'POST', body:{raw:b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}});
  },
};
function b64(s){ const u = new TextEncoder().encode(s); let x = ''; for(const c of u) x += String.fromCharCode(c); return btoa(x); }

const SERVERS = {'Atlassian MCP':JIRA_TOOLS, 'Google Calendar':GOOGLE_TOOLS, 'Gmail':GOOGLE_TOOLS};
const mcp = {
  async callTool(server, tool, input){
    const f = SERVERS[server]?.[tool];
    if(!f) throw fail('not_in_manifest', `${server}/${tool} no está disponible en la versión web`);
    return {payload:await f(input || {})};
  },
};

// ---------- db: lista del pase y vacaciones en propiedades de una incidencia de Jira ----------
// Cada colección es una propiedad de CFG.storeIssue: 'vacaciones' -> altima.vacaciones,
// 'semanas/2026-10-19/items' -> altima.semanas.2026-10-19.items, 'config' (equipo y destinatarios) -> altima.config,
// con valor {docs:{id: datos}} (máx. 32 KB).
// Escribir exige permiso de edición sobre esa incidencia. No hay tiempo real: se relee cada POLL_MS.
const POLL_MS = 20000;
const propKey = (col) => 'altima.' + col.replace(/\//g, '.');
const propUrl = (col) => `/rest/api/2/issue/${enc(CFG.storeIssue)}/properties/${enc(propKey(col))}`;
async function readCol(col){ try{ return (await jira(propUrl(col))).value?.docs || {}; }catch(e){ if(e.status === 404) return {}; throw dbFail(e); } }
const dbFail = (e) => e.status === 403 ? fail('invalid_argument', e.message) : e.code === 'needs_reauth' ? fail('revoked', e.message) : fail('unavailable', e.message);
const watchers = new Map();   // colección -> Set(refrescar)
async function writeCol(col, change){   // leer, cambiar y escribir; luego avisar a quien escuche
  const docs = await readCol(col); change(docs);
  try{ await jira(propUrl(col), {method:'PUT', body:{docs}}); }catch(e){ throw dbFail(e); }
  watchers.get(col)?.forEach(f => f());
}
const split = (path) => { const i = path.lastIndexOf('/'); return [path.slice(0, i), path.slice(i + 1)]; };
function collection(col, order){
  return {
    orderBy:(field) => collection(col, field),
    add:async (data) => { const id = crypto.randomUUID(); await writeCol(col, d => { d[id] = data; }); return {id}; },
    onSnapshot(next, error){
      let live = true;
      const tick = async () => {
        try{
          const docs = Object.entries(await readCol(col)).map(([id, v]) => ({id, data:() => v}));
          if(order) docs.sort((a, b) => (a.data()[order] ?? 0) - (b.data()[order] ?? 0));
          if(live) next({docs});
        }catch(e){ if(live) error?.(e); }
      };
      if(!watchers.has(col)) watchers.set(col, new Set());
      watchers.get(col).add(tick); tick();
      const t = setInterval(tick, POLL_MS);
      return () => { live = false; clearInterval(t); watchers.get(col).delete(tick); };
    },
  };
}
const db = {
  collection:(col) => collection(col),
  doc:(path) => { const [col, id] = split(path); return {
    get:async () => { const v = (await readCol(col))[id]; return {id, exists:v !== undefined, data:() => v}; },
    set:(data) => writeCol(col, d => { d[id] = data; }),
    delete:() => writeCol(col, d => { delete d[id]; }),
  }; },
};

// ---------- descargas: enlace con atributo download ----------
const downloads = {
  async save({filename, data}){ const u = URL.createObjectURL(data), a = Object.assign(document.createElement('a'), {href:u, download:filename}); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 10000); },
};

// ---------- window.claude de sustitución ----------
// 'sample' (resúmenes con Claude) y 'files' (carpeta del proyecto) devuelven null: el panel ya oculta
// el botón de resumir y pide las plantillas Word con un selector de archivo.
const ready = handleCallback().catch(() => {});
window.claude = {
  async use(cap){
    await ready;
    if(cap === 'mcp'){ if(!lsGet('atl')?.refresh){ loginBar(); return null; } return mcp; }
    if(cap === 'db') return CFG.storeIssue ? db : null;
    if(cap === 'downloads') return downloads;
    return null;
  },
};
function loginBar(){
  if(document.getElementById('altimaLogin')) return;
  const d = document.createElement('div'); d.id = 'altimaLogin';
  d.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;z-index:9999;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:12px 16px;border-radius:10px;background:#0c66e4;color:#fff;font:14px system-ui';
  if(!CFG.atlassianClientId || !CFG.proxyUrl){   // publicada antes de dar de alta la app de Atlassian y el Worker
    d.innerHTML = '<span>Esta versión web aún no está conectada a Jira: falta dar de alta la app de Atlassian y el proxy (ver ARQUITECTURA.md, apartado 6). Mientras tanto, usa el panel en claude.ai.</span>';
    d.style.background = '#a54800'; document.body.append(d); return;
  }
  d.innerHTML = '<span>Inicia sesión con tu cuenta de Atlassian para ver tus tickets.</span><button style="font:inherit;padding:6px 14px;border-radius:6px;border:0;cursor:pointer">Entrar con Atlassian</button>';
  d.querySelector('button').onclick = atlLogin;
  document.body.append(d);
}
window.altimaLogout = () => { lsSet('atl', null); gTok = null; location.reload(); };
})();
