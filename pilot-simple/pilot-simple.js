/* 智能操控 · 简版 · AI Pilot —— 方案A：AI 对话抽屉 ↔ 手动面板 联动 + 一触接管 */
const $ = s => document.querySelector(s);
const fab=$('#fab'), panel=$('#panel'), msgs=$('#msgs'), input=$('#input'), chips=$('#chips'),
      vscene=$('#vscene'), actflash=$('#actflash'), manual=$('#manual');

/* 无人机状态 */
const st = { alt:30.0, zoom:1.0, gimbal:0, heading:0, spd:0.0 };
let cur='auto';          // 控制源：auto / ai / manual / dispose
let running=null;        // 正在执行的 AI 操控序列
let disposing=false;     // 是否处于 AI 智能处置中（处置期间操控被锁定）
let dispTimer=null, alarmTimer=null, disposeCard=null;
const PLACEHOLDER='下达飞行 / 云台指令（可组合）…';
const PLATE='粤B·D7F92';   // 演示：AI 处置取证识别到的车牌

/* ---------- 控制源 ---------- */
function setSource(s){
  cur=s;
  const map={auto:['任务自动 · 巡检执行中','src-auto'], ai:['AI 操控','src-ai'], manual:['手动操控','src-manual'], dispose:['AI 处置中 · 操控已锁定','src-dispose'], pause:['航线已暂停 · 待处置事件','src-dispose']};
  const b=$('#srcBadge'); b.textContent='控制源：'+map[s][0]; b.className='srcbadge '+map[s][1];
  $('#resumeBtn').style.display = (s==='auto'||s==='dispose'||s==='pause')?'none':'inline-flex';
  document.body.classList.toggle('aictrl', s==='ai');   // AI 操控时锁定手动面板
}
$('#resumeBtn').onclick=()=>{ if(running){ running.silent=true; abortAI('交还自动任务'); } if(typeof flightAuth!=='undefined'&&flightAuth){ flightAuth.checked=false; updateFlightLock(); } setSource('auto'); toast('已交还自动巡检任务'); };

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
function listeningBubble(){ const b=document.createElement('div'); b.className='listenrow'; b.innerHTML='<span class="lmic">🎤</span><span class="wave"><i></i><i></i><i></i><i></i></span><span class="ltxt">聆听中…请说出指令</span>'; msgs.appendChild(b); scroll(); return b; }
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
function boost(ms){ document.body.classList.add('boost'); setSpd(4.5); setTimeout(()=>{ document.body.classList.remove('boost'); setSpd(0.0); }, ms||1900); }
function applyAction(kind,n){
  switch(kind){
    case 'forward': flash('▲ 向前 '+n+'m'); boost(); break;
    case 'back':    flash('▼ 向后 '+n+'m'); boost(); break;
    case 'left':    flash('◀ 左移 '+n+'m'); boost(1600); break;
    case 'right':   flash('▶ 右移 '+n+'m'); boost(1600); break;
    case 'up':      st.alt=+(st.alt+n).toFixed(1); flash('⬆ 上升 '+n+'m'); break;
    case 'down':    st.alt=Math.max(0,+(st.alt-n).toFixed(1)); flash('⬇ 下降 '+n+'m'); break;
    case 'alt_to':  st.alt=+(+n).toFixed(1); flash('高度 → '+n+'m'); break;
    case 'takeoff': st.alt=n; flash('⛘ 起飞 '+n+'m'); break;
    case 'rtl':     flash('⛘ 返航降落'); boost(2000); break;
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
     <button class="abort">■ 终止操控</button></div>
     <div class="seq">${steps}</div>
     <div class="runbar"><i></i></div>`;
  c.querySelector('.abort').onclick=()=>abortAI('用户中止');
  return c;
}
const FLIGHT_KINDS=new Set(['forward','back','left','right','up','down','alt_to','takeoff','rtl','hover','yaw_l','yaw_r','estop']);
function aiRun(parsed){
  const hasFlight=parsed.steps.some(s=>FLIGHT_KINDS.has(s.kind));
  addBot(parsed.compound ? ('好的，分 '+parsed.steps.length+' 步执行（可随时中止/接管）：') : '好的，正在执行：');
  const c=cmdCardEl(parsed); msgs.appendChild(c); scroll();
  const seqEls=c.querySelectorAll('.sq'), fill=c.querySelector('.runbar i');
  running={card:c, timers:[], aborted:false, flight:hasFlight};
  let i=0;
  function nextStep(){
    if(running.aborted) return;
    if(i>=parsed.steps.length){ finish(); return; }
    const s=parsed.steps[i], el=seqEls[i]; el.classList.add('active'); litManual(s);
    const dur = s.kind==='pause' ? s.n*1000 : 1600;
    if(s.kind==='pause') flash('⏳ 停顿 '+s.n+'s');
    const t1=setTimeout(()=>{
      applyAction(s.kind, s.n);
      el.classList.remove('active'); el.classList.add('ok');
      fill.style.width=Math.round((i+1)/parsed.steps.length*100)+'%';
      i++; const t2=setTimeout(nextStep,500); running.timers.push(t2);
    }, dur);
    running.timers.push(t1);
  }
  function finish(){
    c.classList.add('done'); c.querySelector('.cs').textContent='AI 操控 · 已完成'; const ab=c.querySelector('.abort'); if(ab) ab.remove();
    addBot('✅ 已完成：<b>'+parsed.label+'</b><span class="tm"> · '+nowTime()+'</span>');
    running=null;
    if(hasFlight) returnWaylineBubble('操控已完成，无人机悬停中。');
  }
  if(hasFlight){
    setSource('ai');
    applyAction('hover'); flash('⏸ 暂停航线并悬停');
    addBot('⏸ 已暂停航线并悬停，进入实时飞控（AI 操控）…');
    const t0=setTimeout(()=>{ if(!running.aborted) nextStep(); }, 1400);
    running.timers.push(t0);
  } else {
    addBot('航线继续巡航，叠加执行云台 / 相机指令，无需暂停航线。');
    nextStep();
  }
}
function abortAI(reason){
  if(!running) return;
  const wasFlight=running.flight, silent=running.silent;
  running.aborted=true; running.timers.forEach(clearTimeout);
  const c=running.card; if(c){ c.classList.add('aborted'); const cs=c.querySelector('.cs'); if(cs) cs.textContent='已终止操控'; const ab=c.querySelector('.abort'); if(ab) ab.remove(); }
  running=null;
  if(silent) return;                       // 被处置/交还等外部流程抢占时，不重复提示
  if(wasFlight){
    applyAction('hover');
    addBot('■ 已终止操控（'+reason+'），无人机<b>原地悬停</b>。');
    returnWaylineBubble();
  } else {
    addBot('■ 已终止操控（'+reason+'）。');
  }
}
/* 智能体内提供「返回航线」按钮：点击后恢复航线、解锁 */
function returnWaylineBubble(prefix){
  const b=document.createElement('div'); b.className='bubble bot';
  b.innerHTML=(prefix?prefix+'<br>':'')+'需要继续巡检可返回航线。<br><button class="retway">↩ 返回航线</button>';
  msgs.appendChild(b); scroll();
  const btn=b.querySelector('.retway');
  btn.onclick=()=>{ btn.disabled=true; btn.textContent='✓ 已返回航线'; resumeWayline(); };
}
function resumeWayline(){
  if(running){ running.silent=true; abortAI('返回航线'); }
  if(typeof flightAuth!=='undefined'&&flightAuth){ flightAuth.checked=false; updateFlightLock(); }
  setSource('auto');
  addBot('↩ 已返回航线，任务继续巡航。');
  toast('已返回航线，任务继续');
}
function doEstop(reason){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(running){ running.silent=true; abortAI(reason); }
  applyAction('estop'); setSource('manual');
  openPanel(); addBot('■ <b>已急停</b>：立即原地悬停，进行中的指令已终止<span class="tm"> · '+nowTime()+'</span>。');
  toast('已急停');
}
{ const eb=$('#estopFloat'); if(eb) eb.onclick=()=>doEstop('急停按钮'); }

/* ============ 与「智能处置」融合（沿用智能处置核心交互） ============ */
/* 告警 → 自动暂停航线 → 待处置弹窗（暂不处理 / 人工接管处置 / AI 智能处置）
   仅选择 AI 智能处置才在实况智能体内出现处置内容；处置期间操控输入区隐藏、底部常驻两按钮 */

/* 1) 告警触发：自动暂停航线，弹出待处置弹窗 + 30s 倒计时 */
function triggerAlarm(){
  if(disposing) return;
  if(running){ running.silent=true; abortAI('告警处置抢占'); }
  setSource('pause');
  toast('检测到车辆违停，已自动暂停航线并悬停');
  const m=$('#alarmModal'); m.classList.add('open');
  let left=30; const ring=$('#amRing'); ring.textContent=left;
  clearInterval(alarmTimer);
  alarmTimer=setInterval(()=>{ left--; ring.textContent=left; if(left<=0) ignoreAlarm(true); }, 1000);
}
function closeAlarm(){ clearInterval(alarmTimer); $('#alarmModal').classList.remove('open'); }

/* 2a) 暂不处理 / 超时失效 → 恢复航线，实况智能体无任何处置内容 */
function ignoreAlarm(expired){
  closeAlarm(); setSource('auto');
  toast(expired?'30 秒未选择，已按不处置恢复航线':'已选择暂不处理，航线已恢复');
}
/* 2b) 人工接管处置 → 打开手动面板 + 飞行控制权，航线保持暂停，不出现 AI 处置内容 */
function manualDispose(){
  closeAlarm(); setSource('manual');
  manual.classList.add('open'); $('#openManual').classList.add('on');
  flightAuth.checked=true; updateFlightLock();
  toast('已人工接管处置，航线保持暂停，已开启飞行控制权；完成后点「交还自动任务」恢复航线');
}

/* 2c) AI 智能处置 → 实况智能体进入处置模式：输入区隐藏、底部两按钮常驻 */
function enterDisposal(){
  if(disposing) return;
  closeAlarm();
  if(running){ running.silent=true; abortAI('告警处置抢占'); }
  disposing=true;
  openPanel();
  document.body.classList.add('oplocked');
  document.body.classList.add('disposing');
  manual.classList.remove('open'); $('#openManual').classList.remove('on');
  setSource('dispose');
  const c=document.createElement('div'); c.className='dispcard'; disposeCard=c;
  c.innerHTML=`
    <div class="dt">🤖 处置智能体 · 已接管这条告警</div>
    <div class="ds">遇到车辆违停，我会自己看画面决定怎么拍——<b>追踪目标 → 拍照取证 → 识别车牌</b>，拍清楚就自动收尾并恢复航线。<br>全程不用你操作；想自己飞或想停下，用下方按钮。</div>
    <div class="rt" id="dispRt">🎯 正在追踪目标…</div>`;
  msgs.appendChild(c); scroll();
  toast('已进入 AI 智能处置');
  const steps=['🎯 正在追踪目标…','📷 正在拍照取证…','🔍 识别车牌中…'];
  let k=0; clearInterval(dispTimer);
  dispTimer=setInterval(()=>{
    k++;
    if(k<steps.length){ const rt=$('#dispRt'); if(rt) rt.textContent=steps[k]; }
    else { clearInterval(dispTimer); if(disposing) exitDisposal('done', disposeCard); }
  }, 2600);
}
function exitDisposal(mode, card){
  if(!disposing) return;
  disposing=false; clearInterval(dispTimer);
  document.body.classList.remove('oplocked');
  document.body.classList.remove('disposing');
  const dt=card&&card.querySelector('.dt'), ds=card&&card.querySelector('.ds'), rt=card&&card.querySelector('#dispRt');
  if(rt) rt.remove();
  if(mode==='manual'){
    setSource('manual');
    manual.classList.add('open'); $('#openManual').classList.add('on');
    flightAuth.checked=true; updateFlightLock();
    if(dt) dt.innerHTML='✅ 已终止 AI 处置 · 转人工接管';
    if(ds) ds.innerHTML='已取得设备控制权，<b>由你手动操作</b>；航线保持暂停，处置完成后点【▶ 交还自动任务】恢复航线。';
    addBot('已终止 AI 处置。已取得设备控制权，<b>由你手动操作</b>。处置完成后请恢复航线。');
    toast('已转人工接管');
  } else if(mode==='done'){
    setSource('auto');
    if(dt) dt.innerHTML='✅ 车牌已拍清楚 · 取证完成';
    if(ds) ds.innerHTML='已锁定违停车辆并拍清车尾，车牌识别成功、取证归档完成；航线已恢复，任务继续飞行。';
    if(card){
      const pl=document.createElement('div'); pl.className='plateline';
      pl.innerHTML='<span class="pv">'+PLATE+'</span><span class="pb">✓ 车牌识别成功</span>';
      card.appendChild(pl);
      const ph=document.createElement('div'); ph.className='evphoto';
      ph.innerHTML='📷 取证照 · 变焦 6.0x<span class="abox"></span>';
      card.appendChild(ph);
      scroll();
    }
    addDispRecord(true);
    addBot('✅ 取证完成，车牌 <b>'+PLATE+'</b> 识别成功，已归档；航线已恢复，任务继续飞行。');
    toast('取证完成 · 车牌 '+PLATE);
  } else {
    setSource('auto');
    if(dt) dt.innerHTML='✅ 已终止 AI 处置';
    if(ds) ds.innerHTML='已终止 AI 处置，航线已恢复，任务继续飞行。';
    addBot('✅ 已终止 AI 处置，航线已恢复，任务继续飞行。');
    toast('处置结束，航线已恢复');
  }
}
/* 左侧「发现车辆违停」告警图片下方追加处置记录 */
function addDispRecord(ok){
  const ev=$('#evCar'); if(!ev) return;
  ev.querySelectorAll('.disp').forEach(d=>d.remove());
  const d=document.createElement('div'); d.className='disp';
  d.innerHTML = ok
    ? '<div class="dh">✅ AI 处置完成 · 车牌 <b>'+PLATE+'</b></div><div class="dev"><span class="plate">'+PLATE+'</span></div>'
    : '<div class="dh warn">⚠ AI 处置完成 · 未取到清晰车牌</div>';
  ev.appendChild(d);
}
$('#btnDemoDisp').onclick=triggerAlarm;
$('#amIgnore').onclick=()=>ignoreAlarm(false);
$('#amManual').onclick=manualDispose;
$('#amAI').onclick=enterDisposal;
$('#dispResume').onclick=()=>{ if(disposing) exitDisposal('resume', disposeCard); };
$('#dispTakeover').onclick=()=>{ if(disposing) exitDisposal('manual', disposeCard); };

/* ============ 手动接管 ============ */
function takeover(){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(cur==='manual') return;
  if(running){ running.silent=true; abortAI('切换手动操控'); }
  setSource('manual'); toast('已切换为手动操控');
}
/* 飞行控制权：开启后才能操控飞行盘；云台 / 变焦不受限 */
const flightAuth=$('#flightAuth');
function updateFlightLock(){ document.querySelectorAll('.pad.flightctl').forEach(p=>p.classList.toggle('locked', !flightAuth.checked)); }
flightAuth.addEventListener('change',()=>{
  updateFlightLock();
  if(flightAuth.checked){ takeover(); toast('已开启飞行控制权（进入手动飞行模式）'); }
  else toast('已关闭飞行控制权');
});
updateFlightLock();

document.querySelectorAll('[data-m]').forEach(btn=>{
  btn.addEventListener('mousedown',()=>{
    if(!flightAuth.checked){ toast('请先开启【飞行控制权】'); return; }
    takeover();
    const [k,n]=btn.dataset.m.split(':');
    applyAction(k, n?+n:undefined);
    btn.classList.add('lit'); setTimeout(()=>btn.classList.remove('lit'),300);
  });
});
/* 云台 / 变焦：叠加执行，不改变控制源、不需飞行控制权 */
$('#mGim').addEventListener('input',e=>{ st.gimbal=+e.target.value; applyScene(); refreshHud(); flash('🎯 云台 '+st.gimbal+'°'); });
$('#mZoom').addEventListener('input',e=>{ st.zoom=(+e.target.value)/10; applyScene(); refreshHud(); flash('🔎 变焦 '+st.zoom.toFixed(1)+'x'); });

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

/* ============ 语音下发指令（演示：模拟语音识别） ============ */
const voiceSamples=['上升到 50 米，云台朝下','向前飞 10 米再拉个全景','原地顺时针转一圈，每 90 度停 2 秒','变焦到 5 倍看清远处','云台转到正下方'];
let listening=false;
$('#micBtn').onclick=()=>{
  const mic=$('#micBtn');
  if(listening) return;
  listening=true; mic.classList.add('listening');
  if(!panel.classList.contains('open')) openPanel();
  const lb=listeningBubble();
  setTimeout(()=>{
    lb.remove();
    const q=voiceSamples[Math.floor(Math.random()*voiceSamples.length)];
    input.value=q;
    mic.classList.remove('listening'); listening=false;
    setTimeout(send, 300);
  }, 1500);
};

/* ============ 任务计时（贴近真实实况） ============ */
let elapsed=7*60+3;
setInterval(()=>{
  elapsed++;
  const hh=String(Math.floor(elapsed/3600)).padStart(2,'0'), mm=String(Math.floor(elapsed%3600/60)).padStart(2,'0'), ss=String(elapsed%60).padStart(2,'0');
  const t=`${hh}:${mm}:${ss}`;
  $('#taskRt').textContent=t; $('#evRt').textContent='任务执行中 '+t;
},1000);

renderChips(); refreshHud();
