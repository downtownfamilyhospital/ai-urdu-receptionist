// =========================================================
//  chatweb.js — Zainab web chat with inline Form Cards
//  Modern healthcare chat UI (theme #2563EB / #10B981),
//  dynamic Form Renderer driven by AI show_form commands.
//  Served at /chat by server.js.
// =========================================================

export function chatApp() {
  return `<!doctype html><html lang="ur"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Downtown Family Hospital — Zainab</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--p:#2563EB;--s:#10B981;--bg:#ffffff;--card:#F8FAFC;--txt:#0F172A;--mut:#64748B;--err:#EF4444;--rad:16px}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,-apple-system,sans-serif;background:linear-gradient(180deg,#F1F5F9,#fff);height:100dvh;display:flex;flex-direction:column;color:var(--txt)}
.urdu{font-family:"Noto Nastaliq Urdu",Inter,sans-serif;line-height:2}
header{background:var(--p);color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px;box-shadow:0 2px 12px #2563EB33}
header .av{width:42px;height:42px;border-radius:50%;background:#fff2;display:flex;align-items:center;justify-content:center;font-size:20px}
header h1{font-size:16px;font-weight:600}header p{font-size:12px;opacity:.85}
#chat{flex:1;overflow-y:auto;padding:18px 14px 8px;max-width:760px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:10px}
.msg{max-width:82%;padding:11px 15px;border-radius:var(--rad);font-size:14.5px;animation:up .28s ease;word-wrap:break-word}
.bot{background:var(--card);border:1px solid #E2E8F0;align-self:flex-start;border-bottom-left-radius:4px;direction:rtl;text-align:right}
.me{background:var(--p);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.msg b,.msg strong{font-weight:700}
@keyframes up{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.typing{display:inline-flex;gap:4px;padding:14px 18px}.typing i{width:7px;height:7px;border-radius:50%;background:#94A3B8;animation:bl 1.1s infinite}.typing i:nth-child(2){animation-delay:.18s}.typing i:nth-child(3){animation-delay:.36s}
@keyframes bl{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-4px)}}
/* --- Form Card --- */
.fcard{align-self:flex-start;width:min(94%,420px);background:#fff;border:1px solid #E2E8F0;border-radius:20px;box-shadow:0 10px 30px #0F172A14;padding:20px;animation:pop .35s cubic-bezier(.2,.9,.3,1.2)}
@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:none}}
.fcard h3{font-size:15px;font-weight:700;margin-bottom:4px;color:var(--p)}
.fcard .sub{font-size:12.5px;color:var(--mut);margin-bottom:14px}
.fld{margin-bottom:13px}
.fld label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;color:#334155}
.fld label .req{color:var(--err)}
.fld input,.fld textarea,.fld select{width:100%;padding:12px 14px;border:1.5px solid #E2E8F0;border-radius:12px;font-size:14px;font-family:inherit;outline:none;transition:border .18s,box-shadow .18s;background:#fff;min-height:44px}
.fld textarea{min-height:76px;resize:vertical}
.fld input:focus,.fld textarea:focus,.fld select:focus{border-color:var(--p);box-shadow:0 0 0 3px #2563EB22}
.fld.err input,.fld.err textarea,.fld.err select{border-color:var(--err)}
.fld .emsg{font-size:11.5px;color:var(--err);margin-top:4px;display:none}
.fld.err .emsg{display:block;animation:up .2s}
.radios{display:flex;gap:8px;flex-wrap:wrap}
.radios label{flex:1;min-width:80px;border:1.5px solid #E2E8F0;border-radius:12px;padding:11px;text-align:center;font-size:13.5px;cursor:pointer;transition:all .15s;font-weight:500}
.radios input{display:none}
.radios label.on{border-color:var(--p);background:#2563EB0F;color:var(--p);font-weight:700}
.fbtn{width:100%;padding:14px;border:none;border-radius:12px;background:var(--p);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:transform .12s,box-shadow .2s;margin-top:4px;min-height:48px}
.fbtn:hover{box-shadow:0 6px 18px #2563EB55;transform:translateY(-1px)}
.fbtn:active{transform:scale(.98)}
.fbtn.loading{pointer-events:none;opacity:.8}
.fbtn .spin{display:inline-block;width:16px;height:16px;border:2px solid #fff8;border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite;vertical-align:-3px;margin-left:8px}
@keyframes sp{to{transform:rotate(360deg)}}
.done{align-self:flex-start;display:flex;align-items:center;gap:10px;background:#10B9811A;border:1px solid #10B98144;color:#047857;padding:12px 16px;border-radius:14px;font-size:13.5px;font-weight:600;animation:pop .3s}
.done .ck{width:22px;height:22px;border-radius:50%;background:var(--s);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;animation:pop .45s .1s both}
/* composer */
#bar{max-width:760px;width:100%;margin:0 auto;padding:10px 14px 16px;display:flex;gap:10px}
#inp{flex:1;padding:13px 18px;border:1.5px solid #E2E8F0;border-radius:24px;font-size:14.5px;outline:none;font-family:inherit;transition:border .2s,box-shadow .2s;direction:rtl}
#inp:focus{border-color:var(--p);box-shadow:0 0 0 3px #2563EB22}
#send{width:48px;height:48px;border:none;border-radius:50%;background:var(--p);color:#fff;font-size:18px;cursor:pointer;transition:transform .12s}
#send:active{transform:scale(.92)}
</style></head><body>
<header>
  <div class="av">🏥</div>
  <div><h1>Downtown Family Hospital</h1><p>زینب — آن لائن معاون • Online</p></div>
</header>
<div id="chat"></div>
<div id="bar">
  <input id="inp" placeholder="اپنا پیغام لکھیں..." autocomplete="off">
  <button id="send">➤</button>
</div>
<script>
// ---------- Form definitions (add a new form in <5 min: just add config) ----------
const FORMS = {
  appointment: { title: "Patient Information", sub: "ہسپتال اپائنٹمنٹ کے لیے فارم مکمل کریں", fields: [
    { id:"name", label:"Full Name", type:"text", req:true, ph:"آپ کا پورا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"doctor", label:"Doctor / مسئلہ", type:"text", req:true, ph:"کس ڈاکٹر کو دکھانا ہے یا کیا مسئلہ ہے" },
    { id:"time", label:"Preferred Visit Time", type:"text", req:true, ph:"مثلاً کل صبح 11 بجے (AM/PM)" } ] },
  online: { title: "Online Video Consultation", sub: "فیس Rs. 750 (50% رعایت)", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"age", label:"Age", type:"tel", req:true, ph:"عمر" },
    { id:"gender", label:"Gender", type:"radio", req:true, opts:["Male","Female"] } ] },
  pharmacy: { title: "Medicine Delivery", sub: "گھر پر دوائی منگوائیں", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"medicine", label:"Medicine Name", type:"textarea", req:true, ph:"دوائیوں کے نام" },
    { id:"qty", label:"Quantity", type:"text", req:true, ph:"مثلاً 2 پتے" },
    { id:"address", label:"Delivery Address", type:"textarea", req:true, ph:"مکمل پتہ" } ] },
  lab: { title: "Lab Booking", sub: "لیب ٹیسٹ بُک کریں", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"tests", label:"Test Required", type:"textarea", req:true, ph:"کون سے ٹیسٹ" },
    { id:"home", label:"Home Sample Collection", type:"radio", req:true, opts:["Yes","No"] },
    { id:"address", label:"Address (if home collection)", type:"textarea", req:false, ph:"مکمل پتہ" } ] },
  physio: { title: "Home Physiotherapy", sub: "گھر پر فزیوتھراپی", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"address", label:"Address", type:"textarea", req:true, ph:"مکمل پتہ" },
    { id:"problem", label:"Problem / Required Therapy", type:"text", req:true, ph:"مثلاً کمر درد، فالج بحالی" },
    { id:"time", label:"Visit Time", type:"text", req:true, ph:"مثلاً کل صبح 11 بجے" } ] },
  nursing: { title: "Home Services", sub: "گھر پر نرسنگ سروس", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"whatsapp", label:"WhatsApp Number", type:"tel", req:true, ph:"03XXXXXXXXX" },
    { id:"address", label:"Address", type:"textarea", req:true, ph:"مکمل پتہ" },
    { id:"service", label:"Required Service", type:"text", req:true, ph:"مثلاً ڈرپ، انجکشن، دیکھ بھال" } ] },
  feedback: { title: "Feedback", sub: "آپ کی رائے ہمارے لیے قیمتی ہے", fields: [
    { id:"name", label:"Name", type:"text", req:true, ph:"آپ کا نام" },
    { id:"rating", label:"Rating", type:"radio", req:true, opts:["⭐","⭐⭐","⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐⭐"] },
    { id:"comments", label:"Comments", type:"textarea", req:false, ph:"اپنی رائے لکھیں" } ] },
};

const chat = document.getElementById("chat");
const inp = document.getElementById("inp");
let session = localStorage.getItem("dfh_sess") || (Date.now()+"-"+Math.random().toString(36).slice(2,8));
localStorage.setItem("dfh_sess", session);
let busy=false;

function esc(s){return (s||"").replace(/[<>&]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;"}[c]));}
function md(s){return esc(s).replace(/\\*([^*\\n]+)\\*/g,"<b>$1</b>").replace(/\\n/g,"<br>");}
function add(cls, html){const d=document.createElement("div");d.className="msg "+cls+(cls==="bot"?" urdu":"");d.innerHTML=html;chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d;}
function typing(){const d=document.createElement("div");d.className="msg bot typing";d.innerHTML="<i></i><i></i><i></i>";chat.appendChild(d);chat.scrollTop=chat.scrollHeight;return d;}

// ---------- Form Renderer ----------
function renderForm(formId){
  const f = FORMS[formId]; if(!f) return;
  const card=document.createElement("div");card.className="fcard";
  let h='<h3>'+esc(f.title)+'</h3><div class="sub urdu">'+esc(f.sub)+'</div>';
  for(const fl of f.fields){
    h+='<div class="fld" data-id="'+fl.id+'" data-req="'+(fl.req?1:0)+'"><label>'+esc(fl.label)+(fl.req?' <span class="req">*</span>':'')+'</label>';
    if(fl.type==="textarea") h+='<textarea placeholder="'+esc(fl.ph||"")+'"></textarea>';
    else if(fl.type==="radio"){h+='<div class="radios">'+fl.opts.map(o=>'<label onclick="pick(this)"><input type="radio" name="'+fl.id+'" value="'+esc(o)+'">'+esc(o)+'</label>').join("")+'</div>';}
    else h+='<input type="'+(fl.type==="tel"?"tel":"text")+'" placeholder="'+esc(fl.ph||"")+'">';
    h+='<div class="emsg">یہ خانہ ضروری ہے</div></div>';
  }
  h+='<button class="fbtn">Continue</button>';
  card.innerHTML=h;
  chat.appendChild(card);chat.scrollTop=chat.scrollHeight;
  const first=card.querySelector("input,textarea"); if(first) setTimeout(()=>first.focus(),350);
  card.querySelector(".fbtn").onclick=()=>submitForm(card, formId);
}
window.pick=(lb)=>{lb.parentElement.querySelectorAll("label").forEach(x=>x.classList.remove("on"));lb.classList.add("on");lb.querySelector("input").checked=true;};

function submitForm(card, formId){
  const data={};let ok=true;
  card.querySelectorAll(".fld").forEach(fl=>{
    const id=fl.dataset.id, req=fl.dataset.req==="1";
    let v="";
    const r=fl.querySelector('input[type=radio]:checked'); 
    if(r) v=r.value; else { const i=fl.querySelector("input,textarea"); v=i?i.value.trim():""; }
    if(req && !v){fl.classList.add("err");ok=false;} else fl.classList.remove("err");
    data[id]=v;
  });
  if(!ok) return;
  const btn=card.querySelector(".fbtn");btn.classList.add("loading");btn.innerHTML='Sending<span class="spin"></span>';
  // success animation + collapse
  setTimeout(()=>{
    card.remove();
    const d=document.createElement("div");d.className="done";d.innerHTML='<span class="ck">✓</span> معلومات موصول ہو گئیں';
    chat.appendChild(d);chat.scrollTop=chat.scrollHeight;
    send(null,{formId,data});
  },500);
}

// ---------- Messaging ----------
async function send(text, form){
  if(busy) return; busy=true;
  if(text) add("me", esc(text));
  const t=typing();
  try{
    const r=await fetch("/chat/api/message",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({session, text: text||"", form: form||null})});
    const d=await r.json();
    t.remove();
    if(d.reply) add("bot", md(d.reply));
    if(d.show_form && FORMS[d.show_form]) renderForm(d.show_form);
  }catch(e){ t.remove(); add("bot","معذرت، رابطے میں مسئلہ آ گیا۔ دوبارہ کوشش کریں 🌸"); }
  busy=false;
}
document.getElementById("send").onclick=()=>{const v=inp.value.trim();if(v){inp.value="";send(v);}};
inp.addEventListener("keydown",e=>{if(e.key==="Enter"){const v=inp.value.trim();if(v){inp.value="";send(v);}}});

// welcome
add("bot", md("*السلام علیکم!* 🌸 میں زینب ہوں — ڈاؤن ٹاؤن فیملی ہسپتال۔ بتائیں میں آپ کی کیا مدد کر سکتی ہوں؟\\n👨‍⚕️ آن لائن ڈاکٹر مشورہ • 💊 دوائی کی ڈیلیوری • 🏥 ہوم نرسنگ • 🧪 لیب ٹیسٹ • ✨ ایستھیٹک"));
</script></body></html>`;
}
