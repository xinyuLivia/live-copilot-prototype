/* 智能操控 · 简版 · AI Pilot —— 方案A：AI 对话抽屉 ↔ 手动面板 联动 + 一触接管 */
const $ = s => document.querySelector(s);
const fab=$('#fab'), panel=$('#panel'), msgs=$('#msgs'), input=$('#input'), chips=$('#chips'),
      vscene=$('#vscene'), actflash=$('#actflash'), manual=$('#manual');

/* 无人机状态 */
const st = { alt:30.0, zoom:1.0, gimbal:0, heading:0, spd:0.0 };
let cur='auto';          // 控制源：auto / ai / manual / dispose
let running=null;        // 正在执行的 AI 操控序列
let disposing=false;     // 是否处于 AI 智能处置中（处置期间操控被锁定）
let dispTimer=null;
const PLACEHOLDER='下达飞行 / 云台指令（可组合）…';

/* ---------- 控制源 ---------- */
function setSource(s){
  cur=s;
  const map={auto:['任务自动 · 巡检执行中','src-auto'], ai:['AI 操控','src-ai'], manual:['手动操控','src-manual'], dispose:['AI 处置中 · 操控已锁定','src-dispose']};
  const b=$('#srcBadge'); b.textContent='控制源：'+map[s][0]; b.className='srcbadge '+map[s][1];
  $('#resumeBtn').style.display = (s==='auto'||s==='dispose')?'none':'inline-flex';
}
$('#resumeBtn').onclick=()=>{ if(running) abortAI('交还自动任务'); setSource('auto'); toast('已交还自动巡检任务'); };

/* ---------- 面板开关 ---------- */
function openPanel(){ panel.classList.add('open'); document.body.classList.add('drawer-open'); fab.classList.add('hidden'); }
function closePanel(){ panel.classList.remove('open'); document.body.classList.remove('drawer-open'); fab.classList.remove('hidden'); }
fab.onclick=openPanel; $('#closeBtn').onclick=closePanel;
$('#openManual').onclick=()=>{ const on=manual.classList.toggle('open'); $('#openManual').classList.toggle('on',on); };
$('#closeManual').onclick=()=>{ manual.classList.remove('open'); $('#openManual').classList.remove('on'); };
document.querySelectorAll('.views .vw').forEach(v=>v.onclick=()=>{ document.querySelectorAll('.views .vw').forEach(x=>x.classList.remove('active')); v.classList.add('active'); toast('已切换画面布局：'+v.title); });

/* ---------- 快捷指令 ---------- */
const CHIPS = [
  {cat:'组合动作'},
  '上升到50米并云台垂直向下','原地转一圈每90度停2秒','升10米看全景后回原高度',
  {cat:'单动作'},
  '向前飞5米','上升3米','左转30度','云台向下','变焦到5倍','返航降落'
];
function renderChips(){
  chips.innerHTML='';
  CHIPS.forEach(t=>{
    if(typeof t==='object'){ const d=document.createElement('div'); d.className='chipcat'; d.textContent=t.cat; chips.appendChild(d); return; }
    const c=document.createElement('div'); c.className='chip'; c.textContent=t; c.onclick=()=>{ input.value=t; send(); }; chips.appendChild(c);
  });
}

/* ---------- 消息辅助 ---------- */
function scroll(){ msgs.scrollTop=msgs.scrollHeight; }
function addUser(t){ const b=document.createElement('div'); b.className='bubble user'; b.textContent=t; msgs.appendChild(b); scroll(); }
function addBot(html){ const b=document.createElement('div'); b.className='bubble bot'; b.innerHTML=html; msgs.appendChild(b); scroll(); }
function typing(){ const t=document.createElement('div'); t.className='typing'; t.innerHTML='<i></i><i></i><i></i>'; msgs.appendChild(t); scroll(); return t; }
function toast(t){ const el=$('#toast'); el.textContent=t; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),1800); }
function flash(t){ actflash.textContent=t; actflash.classList.add('on'); setTimeout(()=>actflash.classList.remove('on'),1000); }
function nowTime(){ const d=new Date(); return [d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':'); }
function num(q, def){ const m=q.match(/-?\d+(\.\d+)?/); return m?parseFloat(m[0]):def; }
const cap = (n,max)=> Math.min(Math.abs(n),max);   // 限幅取正

/* ============ 语义解析（含限幅） ============ */
/* 单个子句 → 一步指令 */
function parseOne(q){
  q=q.trim(); if(!q) return null;
  // 变焦 / 云台
  if(/变焦复位|缩回|恢复广角|回到?1\s*倍|变焦.*(重置|复位)|全景|广角|收全|拉全/.test(q)) return step('zoom_reset','🔎','变焦复位','变焦 → 1.0x');
  if(/变焦|放大|拉近|倍|zoom/i.test(q)){ let n=cap(num(q,3),16); n=Math.max(1,n); return step('zoom','🔎','变焦',`变焦 → ${n.toFixed(1)}x`,n); }
  if(/云台|镜头|相机|俯仰/.test(q)){
    if(/正下方|垂直向下|朝下|俯视|向下/.test(q)) return step('g_set','🎯','云台向下','云台俯仰 → -90°',-90);
    if(/回中|水平|归位|复位|摆平/.test(q)) return step('g_set','🎯','云台回中','云台俯仰 → 0°',0);
    const d=cap(num(q,30),90);
    if(/抬|仰|向上|上抬/.test(q)) return step('g_set','🎯','云台抬头',`云台俯仰 → +${d}°`, d);
    if(/压|俯|向下|下压|低头/.test(q)) return step('g_set','🎯','云台下压',`云台俯仰 → -${d}°`, -d);
  }
  if(/抬头|仰视/.test(q)){ const d=cap(num(q,15),90); return step('g_set','🎯','云台抬头',`云台俯仰 → +${d}°`, d); }
  if(/低头/.test(q)){ const d=cap(num(q,15),90); return step('g_set','🎯','云台下压',`云台俯仰 → -${d}°`, -d); }
  // 飞行
  if(/急停|紧急/.test(q)) return step('estop','■','急停','立即原地悬停');
  if(/返航|降落|回家|回巢|回来/.test(q)) return step('rtl','⛘','返航降落','返回起飞点并降落');
  if(/起飞/.test(q)){ const a=cap(num(q,10),120); return step('takeoff','⛘','起飞',`起飞至 ${a} m`,a); }
  if(/悬停|停住|hover|别动|保持位置/i.test(q)) return step('hover','⏸','悬停','保持当前位置悬停');
  if(/到\s*\d+\s*米|高度\s*\d+|到\s*\d+\s*m/i.test(q) && /(上升|升|拉高|下降|降低|高度|爬升)/.test(q)){
    const a=cap(num(q,st.alt),120); return step('alt_to', a>=st.alt?'⬆':'⬇', a>=st.alt?'上升到目标高度':'下降到目标高度', `高度 → ${a} m`, a);
  }
  if(/上升|升高|拉高|爬升/.test(q)){ const d=cap(num(q,3),10); return step('up','⬆','上升',`垂直上升 ${d} m`,d); }
  if(/下降|降低|下压高度|落一点|落一些/.test(q)){ const d=cap(num(q,2),10); return step('down','⬇','下降',`垂直下降 ${d} m`,d); }
  if(/左转|逆时针/.test(q)){ const d=cap(num(q,30),90); return step('yaw_l','↺','机头左转',`偏航 -${d}°`,d); }
  if(/右转|顺时针/.test(q)){ const d=cap(num(q,30),90); return step('yaw_r','↻','机头右转',`偏航 +${d}°`,d); }
  if(/向左飞|左移|向左平移/.test(q)){ const d=cap(num(q,5),10); return step('left','⬅','向左平移',`向左飞行 ${d} m`,d); }
  if(/向右飞|右移|向右平移/.test(q)){ const d=cap(num(q,5),10); return step('right','➡','向右平移',`向右飞行 ${d} m`,d); }
  if(/前进|向前|往前|前飞/.test(q)){ const d=cap(num(q,5),10); return step('forward','⬆','向前飞行',`向前飞行 ${d} m`,d); }
  if(/后退|向后|往后|倒退/.test(q)){ const d=cap(num(q,3),10); return step('back','⬇','向后飞行',`向后飞行 ${d} m`,d); }
  return null;
}
function step(kind,ico,title,param,n){ return {kind,ico,title,param,n}; }
function pause(sec){ return step('pause','⏳','停顿',`停顿 ${sec} 秒`,sec); }

/* 整句 → {label, ico, steps[], compound} */
function parseCmd(q){
  // 模板：组合场景
  if(/转一圈|转圈|环视|绕一圈|360/.test(q)){
    const stepDeg = /(\d+)\s*度/.test(q)? +RegExp.$1 : 90;
    const stopS = /停\s*(\d+)/.test(q)? +RegExp.$1 : 2;
    const times = Math.max(1, Math.round(360/stepDeg));
    const arr=[]; for(let i=0;i<times;i++){ arr.push(step('yaw_r','↻','机头右转',`偏航 +${stepDeg}°`,stepDeg)); if(stopS>0) arr.push(pause(stopS)); }
    return {label:`原地环视一圈（每 ${stepDeg}° 停 ${stopS}s）`, ico:'🧭', compound:true, steps:arr};
  }
  if(/左右.*扫|扫视|来回看/.test(q)){
    const d=/(\d+)\s*度/.test(q)? +RegExp.$1 : 30;
    return {label:`机头左右扫视 ±${d}°`, ico:'🧭', compound:true, steps:[
      step('yaw_l','↺','左转',`偏航 -${d}°`,d), pause(1), step('yaw_r','↻','回中',`偏航 +${d}°`,d),
      step('yaw_r','↻','右转',`偏航 +${d}°`,d), pause(1), step('yaw_l','↺','回中',`偏航 -${d}°`,d) ]};
  }
  if(/(全景|看完).*回(原|到).*高度|升.*看.*回原高度|做个?全景.*回/.test(q)){
    const d=cap(num(q,10),10);
    return {label:`升 ${d}m 看全景后回原高度`, ico:'🧭', compound:true, steps:[
      step('up','⬆','上升',`垂直上升 ${d} m`,d), pause(2), step('down','⬇','下降',`垂直下降 ${d} m`,d) ]};
  }
  if(/(拉到最大|变焦最大|放大到最大).*(缩回|复位|缩)|变焦.*看完.*缩/.test(q)){
    return {label:'临时放大后自动复位', ico:'🧭', compound:true, steps:[
      step('zoom','🔎','变焦放大','变焦 → 8.0x',8), pause(2), step('zoom_reset','🔎','变焦复位','变焦 → 1.0x') ]};
  }
  // 通用：按连接词拆分成多步
  const parts=q.split(/[，,、；;]|然后|接着|再然后|再|并且|并|同时|之后|随后/).map(s=>s.trim()).filter(Boolean);
  const steps=[]; parts.forEach(p=>{ const s=parseOne(p); if(s) steps.push(s); });
  if(steps.length===0) return null;
  if(steps.length===1) return {label:steps[0].title, ico:steps[0].ico, compound:false, steps};
  return {label:`组合指令 · ${steps.length} 步`, ico:'🧭', compound:true, steps};
}

/* ============ 执行核心（AI + 手动共用） ============ */
function applyScene(){
  const pan = (st.gimbal / -90) * 10;   // -90° → 内容下移，露出更多地面
  vscene.style.transform = `scale(${st.zoom}) translateY(${pan}%)`;
}
function setSpd(v){ st.spd=v; }
function boost(ms){ document.body.classList.add('boost'); setSpd(4.5); setTimeout(()=>{ document.body.classList.remove('boost'); setSpd(0.0); }, ms||1500); }
function applyAction(kind,n){
  switch(kind){
    case 'forward': flash('▲ 向前 '+n+'m'); boost(); break;
    case 'back':    flash('▼ 向后 '+n+'m'); boost(); break;
    case 'left':    flash('◀ 左移 '+n+'m'); boost(1100); break;
    case 'right':   flash('▶ 右移 '+n+'m'); boost(1100); break;
    case 'up':      st.alt=+(st.alt+n).toFixed(1); flash('⬆ 上升 '+n+'m'); break;
    case 'down':    st.alt=Math.max(0,+(st.alt-n).toFixed(1)); flash('⬇ 下降 '+n+'m'); break;
    case 'alt_to':  st.alt=+(+n).toFixed(1); flash('高度 → '+n+'m'); break;
    case 'takeoff': st.alt=n; flash('⛘ 起飞 '+n+'m'); break;
    case 'rtl':     flash('⛘ 返航降落'); boost(1400); break;
    case 'hover':   setSpd(0.0); flash('⏸ 悬停'); break;
    case 'yaw_l':   st.heading=((st.heading-n)%360+360)%360; flash('↺ 左转 '+n+'°'); break;
    case 'yaw_r':   st.heading=((st.heading+n)%360)%360; flash('↻ 右转 '+n+'°'); break;
    case 'g_set':   st.gimbal=Math.max(-90,Math.min(30,n)); flash('🎯 云台 '+st.gimbal+'°'); applyScene(); break;
    case 'zoom':    st.zoom=n; flash('🔎 变焦 '+n.toFixed(1)+'x'); applyScene(); break;
    case 'zoom_reset': st.zoom=1.0; flash('🔎 变焦复位'); applyScene(); break;
    case 'estop':   setSpd(0.0); flash('■ 已急停'); break;
    case 'pause':   setSpd(0.0); break;
  }
  refreshHud();
}

/* HUD / 手动面板同步 */
function refreshHud(){
  $('#hZoom').textContent=st.zoom.toFixed(1)+'x';
  $('#hGimbal').textContent=st.gimbal+'°';
  $('#hHeading').textContent=st.heading+'°';
  $('#hAlt').textContent=st.alt.toFixed(1)+'m';
  $('#mGim').value=st.gimbal; $('#mGimVal').textContent=st.gimbal+'°';
  $('#mZoom').value=Math.round(st.zoom*10); $('#mZoomVal').textContent=st.zoom.toFixed(1)+'x';
}

/* 面板联动高亮：AI 执行某步时，点亮手动面板对应控件 */
const PAD_MAP={forward:'mFwd',back:'mBack',left:'mLeft',right:'mRight',up:'mUp',down:'mDown',takeoff:'mUp',alt_to:'mUp',yaw_l:'mYawL',yaw_r:'mYawR'};
function litManual(s){
  let id=PAD_MAP[s.kind];
  if(/^g_/.test(s.kind)) id='sldGim';
  if(/zoom/.test(s.kind)) id='sldZoom';
  if(!id) return; const el=$('#'+id); if(!el) return;
  el.classList.add('lit'); setTimeout(()=>el.classList.remove('lit'),1000);
}

/* ============ AI 执行（无确认，直接跑；可中止） ============ */
function cmdCardEl(parsed){
  const c=document.createElement('div'); c.className='cmd';
  const steps=parsed.steps.map((s,i)=>`<div class="sq"><span class="qi">${i+1}</span><span class="qt">${s.title}<small>${s.param}</small></span></div>`).join('');
  c.innerHTML=`<div class="ch"><div class="cico">${parsed.ico||'🧭'}</div>
     <div><div class="ct">${parsed.label}</div><div class="cs">AI 操控 · 执行中</div></div>
     <button class="abort">■ 中止</button></div>
     <div class="seq">${steps}</div>
     <div class="runbar"><i></i></div>`;
  c.querySelector('.abort').onclick=()=>abortAI('用户中止');
  return c;
}
function aiRun(parsed){
  setSource('ai'); manual.classList.contains('open') || null;
  addBot(parsed.compound ? ('好的，分 '+parsed.steps.length+' 步执行（可随时中止/接管）：') : '好的，正在执行：');
  const c=cmdCardEl(parsed); msgs.appendChild(c); scroll();
  const seqEls=c.querySelectorAll('.sq'), fill=c.querySelector('.runbar i');
  running={card:c, timers:[], aborted:false};
  let i=0;
  function nextStep(){
    if(running.aborted) return;
    if(i>=parsed.steps.length){ finish(); return; }
    const s=parsed.steps[i], el=seqEls[i]; el.classList.add('active'); litManual(s);
    const dur = s.kind==='pause' ? s.n*1000 : 900;
    if(s.kind==='pause') flash('⏳ 停顿 '+s.n+'s');
    const t1=setTimeout(()=>{
      applyAction(s.kind, s.n);
      el.classList.remove('active'); el.classList.add('ok');
      fill.style.width=Math.round((i+1)/parsed.steps.length*100)+'%';
      i++; const t2=setTimeout(nextStep,180); running.timers.push(t2);
    }, dur);
    running.timers.push(t1);
  }
  function finish(){
    c.classList.add('done'); c.querySelector('.cs').textContent='AI 操控 · 已完成'; const ab=c.querySelector('.abort'); if(ab) ab.remove();
    addBot('✅ 已完成：<b>'+parsed.label+'</b><span class="tm"> · '+nowTime()+'</span>');
    running=null;
  }
  nextStep();
}
function abortAI(reason){
  if(!running) return;
  running.aborted=true; running.timers.forEach(clearTimeout);
  const c=running.card; if(c){ c.classList.add('aborted'); const cs=c.querySelector('.cs'); if(cs) cs.textContent='已中止'; const ab=c.querySelector('.abort'); if(ab) ab.remove(); }
  addBot('■ 已中止（'+reason+'）。');
  running=null;
}
function doEstop(reason){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(running) abortAI(reason);
  applyAction('estop'); setSource('manual');
  openPanel(); addBot('■ <b>已急停</b>：立即原地悬停，进行中的指令已终止<span class="tm"> · '+nowTime()+'</span>。');
  toast('已急停');
}
$('#estopFloat').onclick=()=>doEstop('急停按钮');

/* ============ 与「智能处置」互斥：处置期间锁定操控 ============ */
/* 共用同一对话框：告警触发 AI 处置 → 操控入口全部锁定；处置收口后恢复操控 */
function enterDisposal(){
  if(disposing) return;
  if(running) abortAI('告警处置抢占');
  disposing=true;
  openPanel();
  document.body.classList.add('oplocked');
  manual.classList.remove('open'); $('#openManual').classList.remove('on');
  setSource('dispose');
  input.placeholder='处置进行中，操控暂不可用…';
  const c=document.createElement('div'); c.className='dispcard';
  c.innerHTML=`
    <div class="dt">🔒 检测到车辆违停 · AI 智能处置中</div>
    <div class="ds">处置期间<b>操控暂不可用</b>。智能体正在按画面理解<b>追踪目标 → 拍照取证 → 识别车牌</b>，拍清楚会自动收尾并恢复航线。</div>
    <div class="rt" id="dispRt">🎯 正在追踪目标…</div>
    <div class="da">
      <button id="dispResume">结束处置并恢复航线</button>
      <button id="dispTakeover">结束处置并人工接管</button>
    </div>`;
  msgs.appendChild(c); scroll();
  c.querySelector('#dispResume').onclick=()=>exitDisposal('resume', c);
  c.querySelector('#dispTakeover').onclick=()=>exitDisposal('manual', c);
  toast('已进入 AI 智能处置，操控已锁定');
  const steps=['🎯 正在追踪目标…','📷 正在拍照取证…','🔍 识别车牌中…'];
  let k=0; clearInterval(dispTimer);
  dispTimer=setInterval(()=>{
    k++;
    if(k<steps.length){ const rt=$('#dispRt'); if(rt) rt.textContent=steps[k]; }
    else { clearInterval(dispTimer); if(disposing) exitDisposal('done', c); }
  }, 1800);
}
function exitDisposal(mode, card){
  if(!disposing) return;
  disposing=false; clearInterval(dispTimer);
  document.body.classList.remove('oplocked');
  input.placeholder=PLACEHOLDER;
  const da=card.querySelector('.da'); if(da) da.remove();
  const dt=card.querySelector('.dt'), ds=card.querySelector('.ds'), rt=card.querySelector('#dispRt');
  if(mode==='manual'){
    setSource('manual');
    manual.classList.add('open'); $('#openManual').classList.add('on');
    if(dt) dt.innerHTML='✅ 已结束处置 · 转人工接管';
    if(ds) ds.innerHTML='已取得设备控制权，<b>操控已恢复</b>；可用「操控」面板或直接下达指令。';
    if(rt) rt.remove();
    addBot('✅ 已结束处置，取得控制权，<b>操控已恢复</b>。');
    toast('已转人工接管，操控已恢复');
  } else {
    setSource('auto');
    if(dt) dt.innerHTML = (mode==='done') ? '✅ 车牌已拍清楚 · 取证完成' : '✅ 已结束处置';
    if(ds) ds.innerHTML='航线已恢复，任务继续飞行，<b>操控已恢复</b>。可继续下达飞行 / 云台指令。';
    if(rt) rt.remove();
    addBot((mode==='done'?'✅ 取证完成，':'✅ 已结束处置，')+'航线已恢复，<b>操控已恢复</b>。');
    toast('处置结束，操控已恢复');
  }
}
$('#btnDemoDisp').onclick=enterDisposal;

/* ============ 手动接管 ============ */
function takeover(){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(cur==='manual') return;
  if(running) abortAI('切换手动操控');
  setSource('manual'); toast('已切换为手动操控');
}
document.querySelectorAll('[data-m]').forEach(btn=>{
  btn.addEventListener('mousedown',()=>{
    takeover();
    const [k,n]=btn.dataset.m.split(':');
    applyAction(k, n?+n:undefined);
    btn.classList.add('lit'); setTimeout(()=>btn.classList.remove('lit'),300);
  });
});
$('#mGim').addEventListener('input',e=>{ takeover(); st.gimbal=+e.target.value; applyScene(); refreshHud(); });
$('#mZoom').addEventListener('input',e=>{ takeover(); st.zoom=(+e.target.value)/10; applyScene(); refreshHud(); });

/* ============ 发送 ============ */
function send(){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  const q=input.value.trim(); if(!q) return;
  if(!panel.classList.contains('open')) openPanel();
  addUser(q); input.value='';
  const t=typing();
  setTimeout(()=>{
    t.remove();
    const parsed=parseCmd(q);
    if(!parsed){ addBot('抱歉，我没太理解这条指令。可以试试这样说："向前飞 5 米""上升到 50 米，云台朝下""原地转一圈，每 90 度停 2 秒""变焦到 5 倍""返航降落"。'); return; }
    if(parsed.steps.length===1 && parsed.steps[0].kind==='estop'){ doEstop('对话急停'); return; }
    aiRun(parsed);
  }, 700);
}
$('#sendBtn').onclick=send;
input.addEventListener('keydown', e=>{ if(e.key==='Enter') send(); });

/* ============ 任务计时（贴近真实实况） ============ */
let elapsed=7*60+3;
setInterval(()=>{
  elapsed++;
  const hh=String(Math.floor(elapsed/3600)).padStart(2,'0'), mm=String(Math.floor(elapsed%3600/60)).padStart(2,'0'), ss=String(elapsed%60).padStart(2,'0');
  const t=`${hh}:${mm}:${ss}`;
  $('#taskRt').textContent=t; $('#evRt').textContent='任务执行中 '+t;
  const rec=document.querySelector('.rec'); if(rec) rec.childNodes[rec.childNodes.length-1].textContent=' REC '+t;
},1000);

renderChips(); refreshHud();
