/* 实况智能体（Live Copilot）· 智能操控简版
   交互主线：下达指令 → 立即暂停航线并悬停 → 拆解动作并执行 → 完成后 5 秒倒计时恢复航线（可手动立即恢复）
   高阶能力：支线任务「巡检河岸并录像」——识别河岸 → 云台对准（占画面约 75%）→ 沿河堤逐点录像 → 回主航线 */
const $ = s => document.querySelector(s);
const fab=$('#fab'), panel=$('#panel'), msgs=$('#msgs'), input=$('#input'), chips=$('#chips'),
      chipwrap=$('#chipwrap'), vscene=$('#vscene'), actflash=$('#actflash'), manual=$('#manual');

/* 无人机状态 */
const st = { alt:30.0, zoom:1.0, gimbal:0, heading:0, spd:0.0 };
let cur='auto';          // 控制源：auto / ai / manual / dispose
let running=null;        // 正在执行的 AI 操控序列
let disposing=false;     // 是否处于 AI 智能处置中（处置期间操控被锁定）
let mdisposing=false;    // 是否处于人工处置中（处置未收口，操控可用但不自动恢复航线）
let alarmTimer=null, disposeCard=null;
let preemptedLabel=null; // 被告警抢占中止的操控指令名，用于处置收口后提示可重下
let pointfly=false;      // 是否处于指点飞行任务（到点悬停后才开放操控，且无航线可恢复）
const PLACEHOLDER='下达飞行 / 云台指令（可组合）…';
const PLATE='粤B·D7F92';   // 演示：AI 处置取证识别到的车牌

/* ---------- 控制源 ---------- */
function setSource(s){
  cur=s;
  /* 徽标文案以 PRD「控制权模型」表为准 */
  const map={auto:['航线任务执行中','src-auto'], ai:['AI 操控中','src-ai'], manual:['手动操控中','src-manual'],
             dispose:['AI 处置中','src-dispose'], pause:['航线已暂停 · 待处置','src-dispose'],
             mdispose:['人工处置-手动操控中','src-mdispose'], mdisposeAI:['人工处置-AI 操控中','src-mdispose'],
             pf:['指点飞行任务执行中','src-pf'], pfhover:['指点飞行 · 到点悬停','src-pfhover']};
  const b=$('#srcBadge'); b.textContent=map[s][0]; b.className='srcbadge '+map[s][1];
  document.body.classList.toggle('aictrl', s==='ai'||s==='mdisposeAI');   // AI 操控时锁定手动面板
}

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
  '向前飞5米','上升3米','左转30度','云台向下','变焦到5倍','云台回中'
];
function renderChips(){
  chips.innerHTML='';
  CHIPS.forEach(t=>{
    if(typeof t==='object'){ const d=document.createElement('div'); d.className='chipcat'; d.textContent=t.cat; chips.appendChild(d); return; }
    const c=document.createElement('div'); c.className='chip'; c.textContent=t; c.onclick=()=>{ input.value=t; send(); }; chips.appendChild(c);
  });
}
/* 无用户消息时展开；用户发出内容后自动收起。手动展开后不再自动收起 */
let chipsPinned=false;
function setChipsOpen(open){ chipwrap.classList.toggle('collapsed', !open); }
$('#chiphead').onclick=()=>{
  const nowOpen=chipwrap.classList.contains('collapsed');
  setChipsOpen(nowOpen); chipsPinned=nowOpen;
};

/* ---------- 消息辅助 ---------- */
function scroll(){ msgs.scrollTop=msgs.scrollHeight; }
function addUser(t){ const b=document.createElement('div'); b.className='bubble user'; b.textContent=t; msgs.appendChild(b); scroll(); if(!chipsPinned) setChipsOpen(false); }
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

/* 支线任务：巡检河岸并录像（高阶能力，1030 发布会演示场景） */
function riverTask(){
  return {label:'支线任务 · 巡检河岸并录像', ico:'🛶', compound:true, subtask:true, steps:[
    {kind:'river_scan',   ico:'🛰', title:'识别河岸',      param:'从画面识别河岸走向与方位', dur:2200},
    {kind:'river_gimbal', ico:'🎯', title:'云台对准河岸',  param:'云台 → -35°，河岸占画面 75%', dur:2200},
    {kind:'rec_start',    ico:'⏺', title:'开始录像',      param:'支线任务全程录像', dur:1500},
    {kind:'river_fly',    ico:'🛶', title:'沿河堤巡检',    param:'沿河堤逐点飞行，云台动态跟随', dur:5200},
    {kind:'rec_stop',     ico:'⏹', title:'结束录像',      param:'录像归档，主航线未改动', dur:1500}
  ]};
}

/* 整句 → {label, ico, steps[], compound} */
function parseCmd(q){
  // 高阶：支线任务巡检（河道 / 河岸 / 河堤）
  if(/河(道|岸|堤|流|渠)|沿河/.test(q)) return riverTask();
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
    case 'pause':   setSpd(0.0); break;
    /* 支线任务巡检 */
    case 'river_scan':   flash('🛰 已识别河岸走向'); break;
    case 'river_gimbal': st.gimbal=-35; applyScene(); document.body.classList.add('river-focus'); flash('🎯 云台对准河岸 · 占画面 78%'); break;
    case 'rec_start':    document.body.classList.add('recording'); flash('⏺ 开始录像'); break;
    case 'river_fly':    flash('🛶 沿河堤逐点飞行'); boost(5000); break;
    case 'rec_stop':     document.body.classList.remove('recording'); flash('⏹ 录像已归档'); break;
  }
  refreshHud();
}
/* 支线任务视觉复位（恢复航线时调用） */
function clearRiverScene(){ document.body.classList.remove('river-focus','recording'); }

/* HUD / 手动面板同步 */
function refreshHud(){
  $('#mGim').value=st.gimbal; $('#mGimVal').textContent=st.gimbal+'°';
  $('#mZoom').value=Math.round(st.zoom*10); $('#mZoomVal').textContent=st.zoom.toFixed(1)+'x';
}

/* ============ AI 执行（无确认，直接跑；可中止） ============ */
function cmdCardEl(parsed){
  const c=document.createElement('div'); c.className='cmd';
  const steps=parsed.steps.map((s,i)=>`<div class="sq"><span class="qi">${i+1}</span><span class="qt">${s.title}<small>${s.param}</small></span></div>`).join('');
  c.innerHTML=`<div class="ch"><div class="cico">${parsed.ico||'🧭'}</div>
     <div><div class="ct">${parsed.label}</div><div class="cs">AI 操控 · 执行中</div></div>
     <button class="abort">■ 终止</button></div>
     <div class="seq">${steps}</div>
     <div class="runbar"><i></i></div>`;
  c.querySelector('.abort').onclick=()=>abortAI('用户中止');
  return c;
}
/* 一次只跑一条指令：执行期间输入框 / 发送 / 快捷指令 / 麦克风全部置灰 */
function setCmdLock(on){
  document.body.classList.toggle('cmdrun', on);
  input.disabled=on; $('#sendBtn').disabled=on;
  input.placeholder = on ? '执行中… 要换指令请先点【终止】' : PLACEHOLDER;
}

function aiRun(parsed){
  setCmdLock(true);
  addBot(parsed.compound ? ('好的，分 '+parsed.steps.length+' 步执行：') : '好的，正在执行：');
  const c=cmdCardEl(parsed); msgs.appendChild(c); scroll();
  const seqEls=c.querySelectorAll('.sq'), fill=c.querySelector('.runbar i');
  running={card:c, timers:[], aborted:false, subtask:!!parsed.subtask, label:parsed.label};
  let i=0;
  function nextStep(){
    if(running.aborted) return;
    if(i>=parsed.steps.length){ finish(); return; }
    const s=parsed.steps[i], el=seqEls[i]; el.classList.add('active');
    const dur = s.kind==='pause' ? s.n*1000 : (s.dur || 1600);
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
    const wasSubtask=running.subtask;
    running=null; setCmdLock(false);
    if(wasSubtask){
      addBot('✅ 支线任务完成：<b>沿河堤巡检</b>，全程录像已归档，河岸平均占画面 <b>78%</b>（目标 75%）。'
        +(pointfly?'已飞回原目标点悬停。':'主巡检航线未改动。')+'<span class="tm"> · '+nowTime()+'</span>');
      addRiverRecord();
    } else {
      addBot('✅ 已完成：<b>'+parsed.label+'</b><span class="tm"> · '+nowTime()+'</span>');
    }
    if(mdisposing){          // 人工处置未收口：不倒计时、不自动恢复航线，等用户点收口按钮
      setSource('mdispose');
      addBot('人工处置尚未收口，<b>航线保持暂停</b>、无人机悬停。可继续下指令；取证完成后点下方【完成处置并恢复航线】。');
      return;
    }
    if(pointfly){            // 指点飞行没有航线可恢复：保持悬停，不出【恢复航线】与 5 秒倒计时
      setSource('pfhover');
      addBot('无人机<b>保持在目标点悬停</b>，可继续下指令。<br>结束本次临时任务请用左侧【一键返航】。');
      return;
    }
    resumeCountdown('操控已完成，无人机悬停中。');
  }
  /* 统一：下达指令即暂停航线并悬停，再解析拆解、立即执行 */
  setSource(mdisposing?'mdisposeAI':'ai');
  applyAction('hover');
  if(mdisposing){
    flash('🤖 处置中代飞 · 正在拆解动作');
    addBot('收到，处置期间由我代飞，正在拆解动作并执行…');
  } else if(pointfly){
    flash('🤖 到点悬停中 · 正在拆解动作');
    addBot('收到，正在拆解动作并执行…（指点飞行任务无航线可暂停，直接在目标点执行）');
  } else {
    flash('⏸ 暂停航线并悬停');
    addBot('⏸ 已暂停航线并悬停，正在拆解动作并执行…');
  }
  const t0=setTimeout(()=>{ if(running && !running.aborted) nextStep(); }, 1400);
  running.timers.push(t0);
}
function abortAI(reason){
  if(!running) return;
  const silent=running.silent;
  running.aborted=true; running.timers.forEach(clearTimeout);
  const c=running.card; if(c){ c.classList.add('aborted'); const cs=c.querySelector('.cs'); if(cs) cs.textContent='已终止操控'; const ab=c.querySelector('.abort'); if(ab) ab.remove(); }
  running=null; setCmdLock(false);
  if(silent) return;                       // 被处置等外部流程抢占时，不重复提示
  applyAction('hover');
  addBot('■ 已终止（'+reason+'），无人机<b>原地悬停</b>。');
  if(mdisposing){                          // 人工处置未收口：不给恢复航线入口，走底部收口按钮
    setSource('mdispose');
    addBot('人工处置仍在进行，航线保持暂停。取证完成后点下方【完成处置并恢复航线】。');
    return;
  }
  if(pointfly){                            // 指点飞行：无航线可恢复，停在当前位置继续待命
    setSource('pfhover');
    addBot('无人机<b>原地悬停</b>，可继续下指令。结束本次临时任务请用左侧【一键返航】。');
    return;
  }
  returnWaylineBubble();                   // 主动终止不自动恢复，交给用户决定
}

/* 恢复航线：手动按钮（终止 / 接管后）—— 不倒计时、不自动 */
function returnWaylineBubble(prefix, tip){
  clearResumeCd();
  const b=document.createElement('div'); b.className='bubble bot';
  b.innerHTML=(prefix?prefix+'<br>':'')+(tip||'需要继续巡检可恢复航线。')+'<br><button class="retway">↩ 恢复航线</button>';
  msgs.appendChild(b); scroll();
  const btn=b.querySelector('.retway');
  btn.onclick=()=>{ btn.disabled=true; btn.textContent='✓ 已恢复航线'; resumeWayline(false); };
}

/* 恢复航线：执行完成后的 5 秒倒计时，未点击自动恢复 */
let resumeCd=null;
function clearResumeCd(){
  if(!resumeCd) return;
  clearInterval(resumeCd.timer);
  if(resumeCd.tip) resumeCd.tip.remove();      // 倒计时走完或被打断后，该提示不再成立
  if(resumeCd.btn) resumeCd.btn.disabled=true;
  resumeCd=null;
}
function resumeCountdown(prefix){
  clearResumeCd();
  let left=5;
  const b=document.createElement('div'); b.className='bubble bot';
  b.innerHTML=(prefix?prefix+'<br>':'')
    +'<div class="cdtip"><b class="cdn">'+left+'</b> 秒后自动恢复航线，也可立即恢复。</div>'
    +'<button class="retway">↩ 恢复航线（<span class="cdn">'+left+'</span>）</button>';
  msgs.appendChild(b); scroll();
  const btn=b.querySelector('.retway');
  btn.onclick=()=>{ clearResumeCd(); btn.disabled=true; btn.textContent='✓ 已恢复航线'; resumeWayline(false); };
  resumeCd={btn, tip:b.querySelector('.cdtip'), timer:setInterval(()=>{
    left--;
    if(left<=0){ clearResumeCd(); btn.textContent='✓ 已自动恢复航线'; resumeWayline(true); return; }
    b.querySelectorAll('.cdn').forEach(n=>n.textContent=left);
  },1000)};
}
function resumeWayline(auto){
  clearResumeCd();
  if(running){ running.silent=true; abortAI('恢复航线'); }
  mdisposing=false; document.body.classList.remove('mdispose');
  if(typeof flightAuth!=='undefined'&&flightAuth){ flightAuth.checked=false; updateFlightLock(); }
  if(document.body.classList.contains('river-focus')){   // 支线任务收口：镜头回默认巡检视角
    clearRiverScene(); st.gimbal=0; st.zoom=1.0; applyScene(); refreshHud();
  }
  setSource('auto');
  addBot(auto ? '↩ 5 秒倒计时结束，已<b>自动恢复航线</b>，任务继续巡航。' : '↩ 已恢复航线，任务继续巡航。');
  toast(auto ? '已自动恢复航线，任务继续' : '已恢复航线，任务继续');
}

/* 左侧事件流追加支线任务记录 */
function addRiverRecord(){
  const list=$('#evlist'); if(!list) return;
  const ev=document.createElement('div'); ev.className='ev';
  ev.innerHTML='<div class="evh"><span class="dot"></span>支线任务<span class="evr">巡检完成</span></div>'
    +'<div class="evsub">河岸巡检并录像 · 沿河堤逐点飞行</div>'
    +'<div class="evthumb rvthumb">🛶<span class="rvtag">● 录像 00:12</span></div>'
    +'<div class="disp"><div class="dh">✅ 支线完成 · 河岸占画面 <b>78%</b> · 主航线未改动</div></div>';
  list.appendChild(ev); list.scrollTop=list.scrollHeight;
}
/* ============ 与「智能处置」融合（沿用智能处置核心交互） ============ */
/* 告警 → 自动暂停航线 → 待处置弹窗（暂不处理 / 人工接管处置 / AI 智能处置）
   仅选择 AI 智能处置才在实况智能体内出现处置内容；处置期间操控输入区隐藏、底部常驻两按钮 */

/* 1) 告警触发：自动暂停航线，弹出待处置弹窗 + 30s 倒计时 */
function triggerAlarm(){
  if(disposing) return;
  if(pointfly){ toast('指点飞行演示中，告警处置请先结束本次临时任务'); return; }
  dispRunId++;                    // 让上一轮处置的收尾动画立即失效
  clearResumeCd();
  /* 抢占正在执行的 AI 操控：静默中止序列，改由抢占提示统一说明 */
  const preempted = running ? (running.label || '当前操控') : null;
  if(running){ running.silent=true; abortAI('告警处置抢占'); }
  setSource('pause');
  document.body.classList.add('oplocked');   // 从航线暂停起锁操控，直到弹窗三选一
  toast('检测到车辆违停，已自动暂停航线并悬停');
  if(preempted){
    preemptedLabel=preempted;
    openPanel();
    addBot('⚠️ 有新告警要先处置，<b>已停下当前操控</b>（'+preempted+'），无人机原地悬停。'
      +'<br>请在右上角弹窗中选择处置方式：选【AI 智能处置】操控会锁定，选【人工接管处置】操控保留，处置收口后恢复。');
    flash('⚠️ 新告警抢占 · 已停下当前操控');
  }
  const m=$('#alarmModal'); m.classList.add('open');
  let left=30; const ring=$('#amRing'); ring.textContent=left;
  clearInterval(alarmTimer);
  alarmTimer=setInterval(()=>{ left--; ring.textContent=left; if(left<=0) ignoreAlarm(true); }, 1000);
}
function closeAlarm(){ clearInterval(alarmTimer); $('#alarmModal').classList.remove('open'); }

/* 2a) 暂不处理 / 超时失效 → 恢复航线，实况智能体无任何处置内容 */
function ignoreAlarm(expired){
  closeAlarm(); document.body.classList.remove('oplocked'); setSource('auto');
  toast(expired?'30 秒未选择，已按不处置恢复航线':'已选择暂不处理，航线已恢复');
  if(preemptedLabel){
    addBot('告警已按<b>暂不处理</b>关闭，航线已恢复，操控入口恢复可用。<br>需要继续刚才的「'+preemptedLabel+'」，再说一次即可。');
    preemptedLabel=null;
  }
}
/* 2b) 人工接管处置（只从待处置弹窗进入）→ 打开手动面板 + 飞行控制权，航线保持暂停，不出现 AI 处置内容
   处置未收口前航线不恢复：底部常驻【完成处置并恢复航线】，期间也可给智能体下指令代飞（P1） */
function manualDispose(){ closeAlarm(); enterManualDispose(); }

function enterManualDispose(){
  mdisposing=true;
  document.body.classList.remove('oplocked');   // 人工处置不锁操控
  document.body.classList.add('mdispose');
  setSource('mdispose');
  manual.classList.add('open'); $('#openManual').classList.add('on');
  flightAuth.checked=true; updateFlightLock();
  /* 人工处置以飞手手动飞控为主，不主动打开智能体抽屉；需要代飞时用户自己点悬浮球 */
  addBot('已<b>人工接管处置</b>。航线保持暂停、无人机悬停，已开启飞行控制权。'
    +'<br>可用手动面板飞控，也可直接给我下指令代飞；取证完成后点【完成处置并恢复航线】。'
    +(preemptedLabel?'<br>刚才被打断的「'+preemptedLabel+'」需要继续的话，再说一次即可。':''));
  preemptedLabel=null;
  toast('已人工接管处置，航线保持暂停');
}

/* 人工处置收口：唯一出口是底部按钮，收口后才恢复航线 */
function finishManualDispose(){
  if(!mdisposing) return;
  if(running){ running.silent=true; abortAI('人工处置收口'); }
  mdisposing=false;
  document.body.classList.remove('mdispose');
  manual.classList.remove('open'); $('#openManual').classList.remove('on');
  addDispRecord('manual');
  addBot('✅ 人工处置完成，已归档取证记录。');
  resumeWayline(false);
}

/* 2c) AI 智能处置：过程与文案沿用智能处置原型
   分析加载 → 说明可随时接管 → 实时状态行（追踪 / 取证 / 识别）→ 取证结论卡 → 两段式恢复航线 */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let dispRunId=0, dispRunEl=null;
const staleDisp=my=>my!==dispRunId;

function addPhase(t){ const p=document.createElement('div'); p.className='phase'; p.textContent=t; msgs.appendChild(p); scroll(); return p; }
function setRun(el, html){ el.innerHTML='<span class="rtxt">'+html+'</span>'; scroll(); }
function shutter(){ const f=$('#shutter'); f.classList.remove('fire'); void f.offsetWidth; f.classList.add('fire'); }
function evidenceHTML(){
  return '<div class="evidence"><div class="rear"><div class="glass"></div><div class="lamp l"></div><div class="lamp r"></div>'
    +'<div class="plate">'+PLATE+'</div><i class="frame"><span class="lb">车牌 '+PLATE+'</span></i></div>'
    +'<span class="stamp">'+nowTime()+' · 6.0x</span></div>';
}
function disposeSceneReset(){
  st.zoom=1.0; $('#mZoom').value=10; applyScene(); refreshHud();
  document.querySelector('.cross').classList.remove('on-target');
  document.body.classList.remove('zoomed');
}

async function enterDisposal(){
  if(disposing) return;
  closeAlarm();
  if(running){ running.silent=true; abortAI('告警处置抢占'); }
  stopRec(false);                  // 处置接管后输入区隐藏，进行中的语音一并丢弃
  mdisposing=false; document.body.classList.remove('mdispose');   // AI 处置抢占人工处置
  disposing=true; const my=++dispRunId;
  openPanel();
  document.body.classList.add('oplocked');
  document.body.classList.add('disposing');
  manual.classList.remove('open'); $('#openManual').classList.remove('on');
  setSource('dispose');
  toast('已进入 AI 智能处置');

  addBot('🔒 <b>已接管这条告警</b>，智能处置中…');
  const t=typing(); await sleep(900); t.remove(); if(staleDisp(my)) return;

  /* 阶段一：分析（只给加载过程，不出结论卡） */
  addPhase('执行过程信息');
  const an=document.createElement('div'); an.className='analyzing';
  an.innerHTML='<div class="ahd"><span class="spin"></span><span class="atxt">正在读取告警帧…</span></div><div class="abar"><i></i></div>';
  msgs.appendChild(an); scroll();
  for(const s of ['正在读取告警帧…','正在锁定违停车辆…','正在判断取证方式…']){
    an.querySelector('.atxt').textContent=s;
    await sleep(1100); if(staleDisp(my)){ an.remove(); return; }
  }
  an.remove();

  /* 阶段二：执行（不逐条展示动作，只报当前在做什么） */
  addBot('我将<b>根据画面理解智能处置</b>。<br>若您想人工接管可点击【<b>结束处置并人工接管</b>】，若您想结束处置可点击【<b>结束处置并恢复航线</b>】。');
  await sleep(800); if(staleDisp(my)) return;

  const run=document.createElement('div'); run.className='closing running';
  msgs.appendChild(run); dispRunEl=run;
  setRun(run,'🎯 正在追踪目标…');
  st.zoom=2.2; $('#mZoom').value=22; applyScene(); refreshHud();
  await sleep(2200); if(staleDisp(my)) return;
  document.querySelector('.cross').classList.add('on-target');
  await sleep(1600); if(staleDisp(my)) return;
  st.zoom=6.0; $('#mZoom').value=60; applyScene(); refreshHud();
  document.body.classList.add('zoomed');
  await sleep(1900); if(staleDisp(my)) return;

  setRun(run,'📷 正在拍照取证…');
  shutter();
  await sleep(1800); if(staleDisp(my)) return;
  setRun(run,'🔍 识别车牌中…');
  await sleep(1800); if(staleDisp(my)) return;
  run.remove(); dispRunEl=null;

  /* 收口：取证结论 */
  disposing=false; document.body.classList.remove('disposing');
  addPhase('处置结论');
  addBot('✅ <b>车牌已拍清楚，取证完成</b>。');
  const c=document.createElement('div'); c.className='card'; disposeCard=c;
  c.innerHTML='<div class="ch">取证完成<span class="tag">AI 智能处置</span></div>'+evidenceHTML()
    +'<div class="plateline"><span class="pv">'+PLATE+'</span><span class="badge">车牌识别成功</span></div>';
  msgs.appendChild(c); scroll();
  addDispRecord(true);
  await sleep(900); if(staleDisp(my)) return;
  await closeAndResume(my, false);
}

/* 恢复航线：先给「正在恢复」，落地后改为「航线已恢复」 */
async function closeAndResume(my, aborted){
  const box=document.createElement('div'); box.className='closing'+(aborted?' stop':'');
  box.innerHTML='🔄 正在恢复航线....';
  msgs.appendChild(box); scroll();
  await sleep(1600); if(staleDisp(my)) return;

  document.body.classList.remove('oplocked');
  disposeSceneReset();
  setSource('auto');
  await sleep(1400); if(staleDisp(my)) return;

  box.innerHTML='▶ <b>航线已恢复</b>，任务继续飞行。您可关闭对话框。';
  scroll();
  toast(aborted?'已终止 AI 处置，航线已恢复':'处置完成，航线已自动恢复');
  if(preemptedLabel){                    // 处置收口，抢占前被中止的操控可重下
    addBot('操控入口已恢复。刚才被打断的「'+preemptedLabel+'」需要继续的话，再说一次即可。');
    preemptedLabel=null;
  }
}

/* 处置中的两个收口按钮 */
function stopDisposal(mode){
  if(!disposing) return;
  const my=++dispRunId;                    // 递增令牌，正在跑的处置流程随即自行终止
  disposing=false; document.body.classList.remove('disposing');
  if(dispRunEl){
    dispRunEl.classList.remove('running');
    dispRunEl.innerHTML = mode==='manual' ? '🛑 AI 处置已终止，转人工接管' : '🛑 处置已终止';
    dispRunEl=null;
  }
  addBot('🛑 已终止 AI 处置。');
  if(mode==='manual'){
    /* 处置就此结束，转普通手动操控（不进人工处置态）；航线保持暂停，由用户点【返回航线】 */
    document.body.classList.remove('oplocked');
    disposeSceneReset();
    manual.classList.add('open'); $('#openManual').classList.add('on');
    flightAuth.checked=true; updateFlightLock();
    setSource('manual');
    returnWaylineBubble('🕹 已取得设备控制权，<b>由你手动操作</b>。', '处置完成后请点击【<b>恢复航线</b>】。');
    toast('已终止 AI 处置，控制权已交给你');
    if(preemptedLabel){
      addBot('刚才被打断的「'+preemptedLabel+'」需要继续的话，再说一次即可。');
      preemptedLabel=null;
    }
  } else {
    toast('已终止 AI 处置，正在恢复航线');
    closeAndResume(my, true);
  }
}
/* 左侧「发现车辆违停」告警图片下方追加处置记录 */
function addDispRecord(ok){
  const ev=$('#evCar'); if(!ev) return;
  ev.querySelectorAll('.disp').forEach(d=>d.remove());
  const d=document.createElement('div'); d.className='disp';
  d.innerHTML = ok==='manual'
    ? '<div class="dh">✅ 人工处置完成 · 飞手现场取证</div><div class="dev"><span class="plate">'+PLATE+'</span></div>'
    : ok
    ? '<div class="dh">✅ AI 处置完成 · 车牌 <b>'+PLATE+'</b></div><div class="dev"><span class="plate">'+PLATE+'</span></div>'
    : '<div class="dh warn">⚠ AI 处置完成 · 未取到清晰车牌</div>';
  ev.appendChild(d);
}
/* ============ 指点飞行任务演示 ============
   飞往目标点途中不提供智能体入口；到点悬停后才可下指令。
   到点悬停下执行完成不出现【恢复航线】与 5 秒倒计时，无人机保持悬停。 */
let pfTimer=null, pfTip=null;
function setPfTip(txt){
  if(!pfTip){ pfTip=document.createElement('div'); pfTip.className='pftip'; $('#videoArea').appendChild(pfTip); }
  pfTip.textContent=txt;
}
function clearPfTip(){ if(pfTip){ pfTip.remove(); pfTip=null; } }
function setTaskCard(nm, st1, st2){
  $('#taskNm').textContent=nm+'…'; $('#taskNm2').textContent=nm;
  $('#taskSt1').textContent=st1; $('#taskSt2').textContent=st2;
}

function startPointFly(){
  if(pointfly || disposing || mdisposing) return;
  if(running){ running.silent=true; abortAI('切换任务'); }
  clearResumeCd(); closeAlarm();
  pointfly=true;
  document.body.classList.add('pf-flying');
  closePanel();                                    // 途中没有入口：抽屉收起、悬浮球隐藏
  msgs.querySelectorAll('.bubble,.cmdcard,.card,.phase,.closing,.analyzing,.typing').forEach(e=>e.remove());
  manual.classList.remove('open'); $('#openManual').classList.remove('on');
  flightAuth.checked=false; updateFlightLock();
  setTaskCard('K12+300 临时指点飞行任务','飞往目标点…','到点悬停');
  setSource('pf');
  setPfTip('指点飞行任务 · 飞往目标点途中，暂不提供实况智能体入口');
  toast('已切换为指点飞行任务，正在飞往目标点');
  boost(6000);
  clearTimeout(pfTimer);
  pfTimer=setTimeout(pointFlyArrived, 6200);
}
function pointFlyArrived(){
  if(!pointfly) return;
  document.body.classList.remove('pf-flying');      // 到点悬停：入口出现
  applyAction('hover');
  setSource('pfhover');
  setTaskCard('K12+300 临时指点飞行任务','已到达目标点 · 悬停中','到点悬停');
  setPfTip('已到达目标点并悬停 · 可打开实况智能体下达操控指令');
  toast('已到达目标点并悬停，实况智能体入口已开放');
  addBot('已到达目标点并<b>悬停</b>。<br>本次是指点飞行任务，没有航线可暂停，你的指令我会直接在目标点执行；执行完成后无人机继续悬停，<b>不会出现【恢复航线】</b>。<br>结束本次临时任务请用左侧【一键返航】。');
  fab.classList.add('pulse');
  setTimeout(()=>fab.classList.remove('pulse'), 6000);
}
function endPointFly(silent){
  if(!pointfly) return;
  if(running){ running.silent=true; abortAI('结束指点飞行'); }
  clearTimeout(pfTimer);
  pointfly=false;
  document.body.classList.remove('pf-flying');
  clearPfTip();
  setTaskCard('景区门口大道巡检任务2026','执行中…','返航');
  setSource('auto');
  if(!silent) toast('临时任务已结束，已回到航线巡检任务');
}
$('#btnDemoPF').onclick=()=>{ pointfly ? endPointFly() : startPointFly(); };
$('#btnRtl').onclick=()=>{
  if(!pointfly){ toast('演示中：一键返航为主任务级操作'); return; }
  if(!confirm('返航则当前临时任务结束，确认返航？')) return;
  addBot('已确认返航，<b>当前指点飞行任务结束</b>。');
  endPointFly(true);
  toast('已返航，临时任务结束');
};

$('#btnDemoDisp').onclick=triggerAlarm;
$('#amIgnore').onclick=()=>ignoreAlarm(false);
$('#amManual').onclick=manualDispose;
$('#amAI').onclick=enterDisposal;
$('#dispResume').onclick=()=>stopDisposal('resume');
$('#dispTakeover').onclick=()=>stopDisposal('manual');
$('#mdispDone').onclick=finishManualDispose;
$('#mdispDoneBar').onclick=finishManualDispose;   // 抽屉未打开时的画面级收口入口

/* ============ 手动接管 ============ */
function takeover(){
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(mdisposing){                          // 人工处置内的手动飞控：不改处置态、不给恢复航线入口
    if(running){ running.silent=true; abortAI('转手动飞控'); }
    setSource('mdispose');
    return;
  }
  if(cur==='manual') return;
  clearResumeCd();
  if(running){ running.silent=true; abortAI('切换手动操控'); }
  if(pointfly){                            // 指点飞行：手动飞完仍是悬停，无航线可恢复
    setSource('manual'); toast('已切换为手动操控');
    addBot('已切换为<b>手动操控</b>，无人机在目标点悬停。<br>本次是指点飞行任务，没有航线可恢复；结束临时任务请用左侧【一键返航】。');
    return;
  }
  setSource('manual'); toast('已切换为手动操控');
  returnWaylineBubble('已切换为手动操控，航线保持暂停。');
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
  if(document.body.classList.contains('oplocked')){ toast('有新告警待处置，请先在弹窗中选择处置方式'); return; }
  if(running){ toast('上一条指令还在执行，先点【终止】'); return; }
  const q=input.value.trim(); if(!q) return;
  clearResumeCd();                 // 下达新指令即取消未完成的恢复航线倒计时
  if(!panel.classList.contains('open')) openPanel();
  addUser(q); input.value='';
  const t=typing();
  setTimeout(()=>{
    t.remove();
    if(/急停|紧急|返航|降落|回家|回巢|回来|起飞|结束任务|终止任务|返回起飞点|结束巡检/.test(q)){
      addBot('这类操作暂时还不支持。我能帮你控制飞行方向和距离、高度、机头朝向、云台角度、变焦镜头、拍照录像；<br>'
        +(pointfly ? '起飞、降落、返航、急停、结束任务会影响整个指点飞行任务，请用左侧【一键返航】操作，返航后本次临时任务即结束。'
                   : '起飞、降落、返航、急停、结束任务会影响整个巡检任务，请在页面上操作。'));
      return;
    }
    const parsed=parseCmd(q);
    if(!parsed){ addBot('这条我没太理解。可以这样说：「向前飞 5 米」「上升到 50 米，云台朝下」「原地转一圈，每 90 度停 2 秒」「变焦到 5 倍」。'); return; }
    aiRun(parsed);
  }, 700);
}
$('#sendBtn').onclick=send;
input.addEventListener('keydown', e=>{ if(e.key==='Enter') send(); });

/* ============ 语音下发指令 ============
   录音时原地把输入框换成录音条：实时音量波形 + 计时 + 边说边出字（灰=未定稿）。
   结束后转写文字落回输入框，由用户确认发送——飞行指令不做自动发送。
   演示入口：点按开始/结束；按住麦克风说话、松手结束；Alt+点击模拟没听到声音。   */
const voiceSamples=['请对前面的河道进行巡检并录像','上升到 50 米，云台朝下','向前飞 10 米再拉个全景','原地顺时针转一圈，每 90 度停 2 秒','变焦到 5 倍看清远处'];
const inputbar=$('#inputbar'), recbar=$('#recbar'), recWave=$('#recWave'), recTime=$('#recTime'), recTxt=$('#recTxt');
recWave.innerHTML='<i></i>'.repeat(9);
let rec=null;

function startRec(mute){
  if(rec) return;
  if(disposing){ toast('处置进行中，操控暂不可用'); return; }
  if(document.body.classList.contains('oplocked')){ toast('有新告警待处置，请先在弹窗中选择处置方式'); return; }
  if(running){ toast('上一条指令还在执行，先点【终止】'); return; }
  inputbar.classList.add('recording');
  recbar.classList.toggle('mute', !!mute);
  recTxt.className='rtxt partial';
  recTxt.textContent = mute ? '没听到声音…' : '听着，请说指令…';
  recTime.textContent='0:00';
  const bars=[...recWave.children];
  rec={sec:0, text:'', timers:[]};
  rec.timers.push(setInterval(()=>{ rec.sec++; recTime.textContent='0:'+String(rec.sec).padStart(2,'0'); },1000));
  rec.timers.push(setInterval(()=>{
    bars.forEach(b=>{ b.style.height = mute ? '3px' : (4+Math.random()*12).toFixed(0)+'px'; });
  },110));
  if(mute){                              // 静音满 3 秒自动结束，并在对话里明确报错
    rec.timers.push(setTimeout(()=>{
      stopRec(false);
      addBot('没听到声音，本次语音已取消。请检查浏览器 / 系统的麦克风授权，或直接用文字下发指令。');
    },3000));
    return;
  }
  const full=voiceSamples[Math.floor(Math.random()*voiceSamples.length)];
  let i=0;
  const typer=setInterval(()=>{
    rec.text=full.slice(0,++i);
    recTxt.textContent=rec.text;
    recTxt.scrollLeft=recTxt.scrollWidth;    // 长句跟随显示最新说出的部分
    if(i>=full.length){
      clearInterval(typer);
      recTxt.className='rtxt';           // 转写定稿：灰字转白
      rec.timers.push(setTimeout(()=>stopRec(true), 1000));   // 静音满 1 秒自动结束
    }
  },200);                                  // 贴近真人语速，约 5 字 / 秒
  rec.timers.push(typer);
}

function stopRec(commit){
  if(!rec) return;
  const txt=rec.text;
  rec.timers.forEach(t=>{ clearTimeout(t); clearInterval(t); });
  rec=null;
  inputbar.classList.remove('recording');
  if(!commit || !txt) return;
  input.value=txt; input.focus();
  const sb=$('#sendBtn'); sb.classList.remove('nudge'); void sb.offsetWidth; sb.classList.add('nudge');
}

/* 录音态里麦克风被录音条取代，结束只有条内的 ✓（或长按松手），取消只有 ✕ / Esc */
const mic=$('#micBtn');
let holdTimer=null, wasHold=false;
mic.addEventListener('mousedown', ()=>{ wasHold=false; holdTimer=setTimeout(()=>{ wasHold=true; startRec(false); },300); });
mic.addEventListener('mouseup', ()=>{ clearTimeout(holdTimer); if(wasHold) stopRec(true); });
mic.addEventListener('mouseleave', ()=>{ clearTimeout(holdTimer); });
mic.addEventListener('click', e=>{
  if(wasHold){ wasHold=false; return; }               // 长按已在 mouseup 处理
  if(e.altKey){ startRec(true); return; }             // 演示：没听到声音
  startRec(false);
});
$('#recDone').onclick=()=>stopRec(true);
$('#recCancel').onclick=()=>stopRec(false);
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && rec) stopRec(false); });

/* ============ 任务计时（贴近真实实况） ============ */
let elapsed=7*60+3;
setInterval(()=>{
  elapsed++;
  const hh=String(Math.floor(elapsed/3600)).padStart(2,'0'), mm=String(Math.floor(elapsed%3600/60)).padStart(2,'0'), ss=String(elapsed%60).padStart(2,'0');
  const t=`${hh}:${mm}:${ss}`;
  $('#taskRt').textContent=t; $('#evRt').textContent='任务执行中 '+t;
},1000);

renderChips(); refreshHud();
