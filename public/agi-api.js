// agi-api.js — AGI Glass API Client v2
(function(){
'use strict';

const BASE = '';
const TOK_KEY = 'agi_token';
let _token = localStorage.getItem(TOK_KEY);

async function api(path, opts={}){
  const headers = {'Content-Type':'application/json'};
  if(_token) headers['Authorization'] = 'Bearer '+_token;
  const res = await fetch(BASE+path, {...opts, headers:{...headers,...(opts.headers||{})}});
  const text = await res.text();
  let data;
  try{ data=JSON.parse(text); }catch{ data={error:text}; }
  if(res.status===401){ clearToken(); window.dispatchEvent(new Event('agi:logout')); throw new Error('Session expired'); }
  if(!res.ok) throw Object.assign(new Error(data.error||'API error '+res.status),{status:res.status,data});
  return data;
}
const GET  = p     => api(p);
const POST = (p,b) => api(p,{method:'POST',  body:JSON.stringify(b)});
const PUT  = (p,b) => api(p,{method:'PUT',   body:JSON.stringify(b)});
const PTCH  = (p,b) => api(p,{method:'PATCH', body:JSON.stringify(b)});
const PATCH = PTCH;
const DEL  = p     => api(p,{method:'DELETE'});

function setToken(t){ _token=t; if(t) localStorage.setItem(TOK_KEY,t); else localStorage.removeItem(TOK_KEY); }
function clearToken(){ setToken(null); }
function getToken(){ return _token; }

const Auth = {
  async login(email,password){
    const d = await POST('/api/auth/login',{email,password});
    setToken(d.token);
    return d.worker;
  },
  async me(){ return GET('/api/auth/me'); },
  logout(){ clearToken(); }
};

const Customers = {
  list(search){ return GET('/api/customers'+(search?'?search='+encodeURIComponent(search):'')); },
  get(id){ return GET('/api/customers/'+id); },
  create(d){ return POST('/api/customers',d); },
  update(id,d){ return PUT('/api/customers/'+id,d); },
  delete(id){ return DEL('/api/customers/'+id); }
};

const Orders = {
  list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/orders'+(qs?'?'+qs:'')); },
  get(id){ return GET('/api/orders/'+id); },
  create(d){ return POST('/api/orders',d); },
  update(id,d){ return PUT('/api/orders/'+id,d); },
  setStatus(id,status){ return PTCH('/api/orders/'+id+'/status',{status}); },
  delete(id){ return DEL('/api/orders/'+id); }
};

const Workers = {
  list()                 { return GET('/api/workers'); },
  get(id)                { return GET('/api/workers/'+id); },
  create(d)              { return POST('/api/workers',d); },
  update(id,d)           { return PUT('/api/workers/'+id,d); },
  delete(id)             { return DEL('/api/workers/'+id); },
  payroll(id,month)      { return GET('/api/workers/'+id+'/payroll'+(month?'?month='+month:'')); },
  addDocument(id,doc)    { return api('/api/workers/'+id+'/documents',{method:'POST',body:JSON.stringify(doc)}); },
  deleteDocument(id,idx) { return api('/api/workers/'+id+'/documents/'+idx,{method:'DELETE'}); }
};

const Labels = {
  list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/labels'+(qs?'?'+qs:'')); },
  pending(processes=[]){ return GET('/api/labels/pending'+(processes.length?'?processes='+processes.join(','):'')); },
  scanlog(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/labels/scanlog'+(qs?'?'+qs:'')); },
  get(uid){ return GET('/api/labels/'+encodeURIComponent(uid)); },
  upsert(arr){ return POST('/api/labels', Array.isArray(arr)?arr:[arr]); },
  scan(pieceUid,process,action){ return POST('/api/labels/scan',{pieceUid,process,action}); },
  history(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/labels/scan/history'+(qs?'?'+qs:'')); }
};

const RawSheets = {
  list(){ return GET('/api/rawsheets'); },
  create(d){ return POST('/api/rawsheets',d); },
  update(id,d){ return PUT('/api/rawsheets/'+id,d); },
  delete(id){ return DEL('/api/rawsheets/'+id); }
};

const OptFiles = {
  list(){ return GET('/api/optfiles'); },
  get(id){ return GET('/api/optfiles/'+id); },
  create(d){ return POST('/api/optfiles',d); },
  update(id,d){ return PUT('/api/optfiles/'+id,d); },
  delete(id){ return DEL('/api/optfiles/'+id); }
};

const Reports = {
  productivity(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/reports/productivity'+(qs?'?'+qs:'')); },
  workers(){ return GET('/api/reports/workers'); },
  orders(){ return GET('/api/reports/orders'); },
  tracking(orderId){ return GET('/api/reports/tracking/'+orderId); }
};

const Config = {
  get(){ return GET('/api/config'); },
  update(d){ return PUT('/api/config',d); }
};

const health = () => GET('/api/health');

const Purchases = {
  list(){ return GET('/api/purchases'); },
  create(d){ return POST('/api/purchases',d); },
  delete(id){ return DEL('/api/purchases/'+id); }
};

const Attendance = {
  list(p={})        { const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/attendance'+(qs?'?'+qs:'')); },
  today()           { return GET('/api/attendance/today'); },
  summary(p={})     { const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/attendance/summary'+(qs?'?'+qs:'')); },
  punchIn()         { return POST('/api/attendance/punch-in',{}); },
  punchOut()        { return POST('/api/attendance/punch-out',{}); },
  log(type,note)    { return POST('/api/attendance',{type,note}); },
  override(id,d)    { return PTCH('/api/attendance/'+id+'/override',d); },
  adminCreate(d)    { return POST('/api/attendance/admin',d); },
  setDayType(id,t)  { return PTCH('/api/attendance/'+id+'/day-type',{day_type:t}); }
};

const HR = {
  schedule:   { get(){ return GET('/api/hr/schedule'); }, update(d){ return PUT('/api/hr/schedule',d); } },
  overtime:   {
    list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/hr/overtime'+(qs?'?'+qs:'')); },
    submit(d)  { return POST('/api/hr/overtime',d); },
    review(id,status){ return PATCH('/api/hr/overtime/'+id,{status}); }
  },
  leave: {
    list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/hr/leave'+(qs?'?'+qs:'')); },
    submit(d)  { return POST('/api/hr/leave',d); },
    review(id,status){ return PATCH('/api/hr/leave/'+id,{status}); }
  },
  payroll(month){ return GET('/api/hr/payroll'+(month?'?month='+month:'')); },
  vacation: {
    list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v)).toString(); return GET('/api/hr/vacation'+(qs?'?'+qs:'')); },
    update(id,d){ return PTCH('/api/hr/vacation/'+id,d); },
    accrue(){ return POST('/api/hr/vacation/accrue',{}); }
  }
};

const Remnants = {
  list(p={}){ const qs=new URLSearchParams(Object.entries(p).filter(([,v])=>v!=null&&v!=='')).toString(); return GET('/api/remnants'+(qs?'?'+qs:'')); },
  fit(w,h,t){ return GET('/api/remnants/fit?w='+w+'&h='+h+'&thickness='+t); },
  stats(){ return GET('/api/remnants/stats'); },
  get(id){ return GET('/api/remnants/'+id); },
  create(d){ return POST('/api/remnants',d); },
  update(id,d){ return PUT('/api/remnants/'+id,d); },
  use(id,d){ return POST('/api/remnants/'+id+'/use',d); },
  discard(id){ return DEL('/api/remnants/'+id); },
  log(id){ return GET('/api/remnants/'+id+'/log'); },
  slots:{
    list(){ return GET('/api/remnants/slots'); },
    create(d){ return POST('/api/remnants/slots',d); },
    update(id,d){ return PUT('/api/remnants/slots/'+id,d); },
    delete(id){ return DEL('/api/remnants/slots/'+id); }
  }
};

const FpFields = {
  list(){ return GET('/api/fpfields'); },
  add(d){ return POST('/api/fpfields',d); },
  update(id,d){ return PUT('/api/fpfields/'+id,d); },
  delete(id){ return DEL('/api/fpfields/'+id); }
};

const FinalProducts = {
  list(){ return GET('/api/finalproducts'); },
  stats(){ return GET('/api/finalproducts/stats'); },
  create(d){ return POST('/api/finalproducts',d); },
  update(id,d){ return PUT('/api/finalproducts/'+id,d); },
  delete(id){ return DEL('/api/finalproducts/'+id); }
};

const GlassFamilies = {
  list(){ return GET('/api/glassfamilies'); },
  create(d){ return POST('/api/glassfamilies',d); },
  update(id,d){ return PUT('/api/glassfamilies/'+id,d); },
  delete(id){ return DEL('/api/glassfamilies/'+id); }
};

window.AGI = {
  Auth, Customers, Orders, Workers, Labels,
  RawSheets, OptFiles, Reports, Config, Purchases, Attendance, GlassFamilies, FinalProducts, FpFields, Remnants, HR, health,
  getToken, setToken, clearToken, api
};

console.log('[AGI] API client ready');
})();
