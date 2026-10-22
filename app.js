import {LETTERS,ROSCOS} from './roscos.js';
import {firebaseConfig} from './firebase-config.js';

const TEAMS=[
  {id:'brujos',name:'Brujos',emoji:'🧙'},
  {id:'fantasmas',name:'Fantasmas',emoji:'👻'},
  {id:'vampiros',name:'Vampiros',emoji:'🧛'},
  {id:'licantropos',name:'Licántropos',emoji:'🐺'}
];
const $=id=>document.getElementById(id);
const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tname=id=>TEAMS.find(t=>t.id===id)?.name||'Equipo';
const emoji=id=>TEAMS.find(t=>t.id===id)?.emoji||'🎃';
const codeAlphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode=()=>Array.from({length:6},()=>codeAlphabet[Math.floor(Math.random()*codeAlphabet.length)]).join('');
const milliseconds=v=>Math.max(0,Math.round(Number(v)||0));
const fmt=ms=>`${Math.floor(milliseconds(ms)/60000).toString().padStart(2,'0')}:${Math.floor((milliseconds(ms)%60000)/1000).toString().padStart(2,'0')}`;
const maxBonus=600;
let app=$('app'), room=null, roomCode=null, clientId=null, db=null, api=null, unsubscribe=null, firebaseError=null, serverOffset=0, busy=false, soundOn=false, toastTimer=null, activeMode='home';
const params=new URLSearchParams(location.search);
const localMode=params.get('demo')==='1';
const projectionMode=params.get('pantalla')==='1';
const firstCode=params.get('sala');
const localKey=code=>'rosco-mortis-'+code;
const now=()=>Date.now()+serverOffset;

function notify(s){const el=$('toast');el.textContent=s;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3200)}
function beep(f=620){if(!soundOn)return;try{const A=window.AudioContext||window.webkitAudioContext;const c=new A(),osc=c.createOscillator(),gain=c.createGain();osc.type='sine';osc.frequency.value=f;gain.gain.setValueAtTime(.07,c.currentTime);gain.gain.exponentialRampToValueAtTime(.0001,c.currentTime+.17);osc.connect(gain);gain.connect(c.destination);osc.start();osc.stop(c.currentTime+.17);osc.onended=()=>c.close()}catch{}}
function getViewerLink(){const u=new URL(location.href);u.searchParams.set('sala',roomCode);u.searchParams.set('pantalla','1');if(localMode)u.searchParams.set('demo','1');else u.searchParams.delete('demo');return u.toString()}
function getHostLink(){const u=new URL(location.href);u.searchParams.set('sala',roomCode);u.searchParams.delete('pantalla');if(localMode)u.searchParams.set('demo','1');return u.toString()}
function updateURL(code){const u=new URL(location.href);if(code)u.searchParams.set('sala',code);else u.searchParams.delete('sala');history.replaceState({},'',u.pathname+u.search);roomCode=code}
function uid(){if(localMode){let x=sessionStorage.getItem('rosco-uid');if(!x){x='local-'+randomCode()+randomCode();sessionStorage.setItem('rosco-uid',x)}return x}return clientId}
function isHost(){return room&&room.hostUid===uid()&&!projectionMode}
function validRoom(r){return !!(r&&r.kind==='rosco-v1'&&r.teams&&r.hostUid)}
function stateSeed(code){let teams={};for(const t of TEAMS){teams[t.id]={queue:[...LETTERS],correct:[],wrong:[],remainingMs:45000,status:'ready'}};return {kind:'rosco-v1',code,createdAt:Date.now(),hostUid:uid(),phase:'lobby',base:45,bonuses:{brujos:0,fantasmas:0,vampiros:0,licantropos:0},teams,activeTeam:'',clock:{running:false,startedAt:0},showClue:false,lastAction:{},finishReason:''}}
function color(l,t){return (t?.correct||[]).includes(l)?'ok':(t?.wrong||[]).includes(l)?'bad':t?.queue?.[0]===l?'active':'wait'}
function currentTime(r,id){const t=r?.teams?.[id];if(!t)return 0;let ms=t.remainingMs;if(id===r.activeTeam&&r.clock?.running)ms-=Math.max(0,now()-r.clock.startedAt);return milliseconds(ms)}
function currentClue(){if(!room?.activeTeam)return null;const id=room.activeTeam;const letter=room.teams[id]?.queue?.[0];return ROSCOS[id]?.find(x=>x.letter===letter)||null}
function settleClock(r,at){if(!r.clock?.running||!r.activeTeam)return;const t=r.teams[r.activeTeam];if(!t)return;const elapsed=Math.max(0,at-(r.clock.startedAt||at));t.remainingMs=milliseconds(t.remainingMs-elapsed);r.clock.running=false;r.clock.startedAt=0;if(!t.remainingMs){t.status='done'} }
function checkFinished(r){if(TEAMS.every(t=>r.teams[t.id].status==='done')){r.phase='finished';r.clock.running=false;r.finishReason='completed'} }
// Selecciona el siguiente equipo que aún puede jugar, sin modificar sus letras ni su tiempo.
function nextPlayableTeam(r,from){
  const start=TEAMS.findIndex(t=>t.id===from);
  for(let step=1;step<=TEAMS.length;step++){
    const candidate=TEAMS[(start+step+TEAMS.length)%TEAMS.length].id;
    const t=r.teams[candidate];
    if(t && t.status!=='done' && t.queue?.length && t.remainingMs>0)return candidate;
  }
  return null;
}
function chooseNextTeam(r,from){
  const next=nextPlayableTeam(r,from);
  if(next)r.activeTeam=next;
  r.clock.running=false;
  r.clock.startedAt=0;
  return next;
}
function snapshot(t){return {queue:[...t.queue],correct:[...t.correct],wrong:[...t.wrong],status:t.status}}
function rank(){return TEAMS.map(t=>({...t,...room.teams[t.id],remaining:currentTime(room,t.id)})).sort((a,b)=>b.correct.length-a.correct.length||a.wrong.length-b.wrong.length||b.remaining-a.remaining)}
function ring(id,large=false){const t=room?.teams?.[id]||{queue:[...LETTERS],correct:[],wrong:[]};const current=t.queue[0]||'✦';return `<div class="rosco ${large?'large':''}">${LETTERS.map((l,i)=>{const a=(i*360/LETTERS.length-90)*Math.PI/180;const x=50+46*Math.cos(a),y=50+46*Math.sin(a);return `<div class="node ${color(l,t)}" style="left:${x.toFixed(3)}%;top:${y.toFixed(3)}%">${l}</div>`}).join('')}<div class="inner"><span class="initial">${escapeHTML(current)}</span><small>TIEMPO RESTANTE</small><span class="timer live-clock" data-teamtime="${id}">${fmt(currentTime(room,id))}</span></div></div>`}
function scoreboard(){return `<div class="scoreboard">${TEAMS.map(t=>{const s=room.teams[t.id];return `<div class="score ${room.activeTeam===t.id?'on':''}"><b>${t.emoji} ${t.name}</b><div class="n">${s.correct.length} <span class="small">aciertos</span></div><div class="meta"><span class="live-clock" data-teamtime="${t.id}">${fmt(currentTime(room,t.id))}</span> · ${s.wrong.length} errores</div></div>`}).join('')}</div>`}
function phaseLabel(){return room.phase==='lobby'?'Preparando los roscos':room.phase==='playing'?'Partida en curso':'Partida finalizada'}
function roomHeader(){return `<div class="row between"><span class="pill">SALA ${escapeHTML(roomCode)} · ${phaseLabel()}</span><div class="actions"><button class="btn ghost mini" data-action="copy-host">Copiar acceso</button><button class="btn secondary mini" data-action="open-view">↗ Pantalla pública</button></div></div>`}
function homeHTML(){return `<div class="stack"><section class="hero"><div class="hero-content"><div class="eyebrow">EL ÚLTIMO JUEGO DE LA NOCHE</div><h1>El Rosco <em>Maldito</em></h1><p>Cuatro equipos. Cuatro roscos diferentes de 27 letras. Sumá el tiempo ganado durante la noche, dirigí cada turno y descubrí quién vence al reloj de Jack Mortis.</p><div class="actions"><button class="btn primary big" data-action="create">✦ Crear sala del rosco</button></div></div></section>${localMode?'<div class="notice">Modo ensayo sin conexión: los datos quedan en este navegador. Ideal para probar sin tocar la partida real.</div>':''}${firebaseError&&!localMode?`<div class="notice err">${escapeHTML(firebaseError)}<div class="actions" style="margin-top:10px"><a class="btn secondary" href="?demo=1">Ensayar sin Firebase</a></div></div>`:''}<div class="two"><section class="panel"><div class="eyebrow">PARA LA CONDUCTORA</div><h2>Controlá cada segundo</h2><p>Leé las definiciones, marcá Correcta, Incorrecta o Pasapalabra, pausá el reloj y decidí qué equipo continúa. Las soluciones quedan ocultas en la pantalla pública.</p><div class="actions"><a class="btn secondary" href="?demo=1">🧪 Probar la web sola</a></div></section><section class="panel"><div class="eyebrow">VOLVER A UNA SALA</div><h2>¿Ya empezaron?</h2><form id="join-form" class="row"><div class="field flex1"><label>CÓDIGO DE SEIS CARACTERES</label><input required id="join-code" maxlength="6" placeholder="ABC234" autocomplete="off"></div><button class="btn primary" type="submit">Entrar →</button></form><p class="small">Guardá el código de tu sala: permite abrir el rosco desde otro dispositivo.</p></section></div></div>`}
function lobbyHTML(){if(!isHost())return `<div class="panel"><div class="eyebrow">PANTALLA PÚBLICA</div><h2>Jack está preparando los roscos</h2><p>La conductora está ingresando los segundos obtenidos en los desafíos anteriores.</p><div class="actions"><button class="btn secondary" data-action="open-view">Ir a pantalla pública</button></div></div>`;
return `<div class="stack"><section class="panel">${roomHeader()}<div class="divider"></div><div class="eyebrow">CONFIGURACIÓN DE LA FINAL</div><h1>Prepará los <em>cuatro roscos</em></h1><p>Ingresá los segundos que cada equipo ganó en los juegos anteriores. Se sumarán a un tiempo inicial igual para todos.</p><div class="field" style="max-width:220px"><label>TIEMPO INICIAL POR EQUIPO (SEGUNDOS)</label><input id="base-seconds" type="number" min="0" max="600" step="1" value="${room.base}"></div><div class="divider"></div><div class="lobby-teams">${TEAMS.map(t=>`<div class="team-form"><div class="team-icon">${t.emoji}</div><strong>${t.name}</strong><div class="field"><label>SEGUNDOS GANADOS</label><input type="number" min="0" max="600" step="1" data-bonus="${t.id}" value="${room.bonuses[t.id]||0}" aria-label="Segundos ganados por ${t.name}"></div><div class="summary">${room.base+(room.bonuses[t.id]||0)} s</div><small>Tiempo total del equipo</small></div>`).join('')}</div><div class="actions" style="margin-top:22px"><button class="btn primary big" data-action="start-game">✦ Comenzar la gran final</button><button class="btn secondary" data-action="open-view">Mostrar en pantalla</button></div><p class="small" style="margin-top:13px">No hace falta que se conecten los cuatro grupos: vos controlás los turnos. Cada «Pasapalabra» pausa y pasa al equipo siguiente.</p></section></div>`}
function teamTabs(){return `<div class="team-tabs">${TEAMS.map(t=>{let d=room.teams[t.id];return `<button class="team-tab ${room.activeTeam===t.id?'active':''} ${d.status==='done'?'finished':''}" data-team="${t.id}" ${d.status==='done'||currentTime(room,t.id)<=0?'disabled':''}><b>${t.emoji} ${t.name}</b><div class="team-stats"><span>${d.correct.length} ✓ · ${d.wrong.length} ✗</span><span class="live-clock" data-teamtime="${t.id}">${fmt(currentTime(room,t.id))}</span><span>${d.status==='done'?'FINALIZADO':room.activeTeam===t.id?'SELECCIONADO':'Elegir equipo'}</span></div></button>`}).join('')}</div>`}
function playingHostHTML(){const id=room.activeTeam,t=id&&room.teams[id],q=currentClue();const hasTime=!!(t&&currentTime(room,id)>0),canMark=!!(room.clock.running&&q&&hasTime&&t.status!=='done');return `<div class="stack"><section class="panel">${roomHeader()}<div class="divider"></div><div class="row between"><span class="eyebrow">PANEL PRIVADO DE LA CONDUCTORA</span><button class="btn ghost mini" data-action="show-clue">${room.showClue?'Ocultar':'Mostrar'} definiciones en proyector</button></div><h2>¿Quién desafía al reloj?</h2>${teamTabs()}<p class="small" style="margin:12px 0 0">Al tocar <b>Pasapalabra</b>, se pausa el tiempo y se selecciona el siguiente equipo. También podés tocar otro equipo o usar <b>Pausar y cambiar</b>; las letras y el reloj de cada uno se conservan.</p></section>${id?`<div class="play-layout"><section class="panel ring-panel"><div class="row between"><b>${emoji(id)} ${tname(id)}</b><span class="pill">${t.correct.length}/27 correctas</span></div>${ring(id)}<div class="bar"><span id="time-bar" style="width:${room.base?Math.min(100,currentTime(room,id)/((room.base+(room.bonuses[id]||0))*1000)*100):0}%"></span></div><div class="actions"><button class="btn ${room.clock.running?'secondary':'primary'} flex1" data-action="toggle-clock" ${!hasTime||t.status==='done'?'disabled':''}>${room.clock.running?'⏸ Pausar':'▶ Iniciar / Reanudar'}</button><button class="btn secondary flex1" data-action="next-team" ${t.status==='done'&& !nextPlayableTeam(room,id)?'disabled':''}>⇥ Pausar y pasar al siguiente</button></div><div class="help-keys">El cronómetro descuenta solo mientras está corriendo. Para evitar que la pantalla se apague, dejá el celular activo.</div></section><section class="panel question-panel"><div class="row between"><span class="q-label">LETRA ${escapeHTML(q?.letter||'—')} · ${q?.contains?'CONTIENE':'EMPIEZA CON'}</span><span class="pill">${t.queue.length} pendientes</span></div>${q?`<div class="q-text">${q.contains?'Contiene la '+q.letter+'. ':'Empieza con la '+q.letter+'. '}${escapeHTML(q.clue)}</div><div class="answer-private"><span class="tag">RESPUESTA · SOLO VISIBLE PARA LA CONDUCTORA</span><strong class="answer">${escapeHTML(q.answer)}</strong></div>`:`<h2>¡Rosco completado!</h2><p>Este equipo ya no tiene letras pendientes.</p>`}<div class="actions"><button class="btn primary" data-action="correct" ${!canMark?'disabled':''}>✓ Correcta</button><button class="btn danger" data-action="wrong" ${!canMark?'disabled':''}>✕ Incorrecta</button><button class="btn secondary" data-action="pass" ${!canMark?'disabled':''}>↪ Pasapalabra → siguiente equipo</button><button class="btn ghost" data-action="undo" ${!room.lastAction?.teamId||room.clock.running?'disabled':''}>↶ Deshacer</button></div><div class="divider"></div><div class="actions"><button class="btn ghost" data-action="finish-team" ${room.clock.running||t.status==='done'?'disabled':''}>Dar por terminado este rosco</button><button class="btn danger" data-action="end-all">Finalizar la partida</button></div></section></div>`:`<section class="panel center"><h2>Elegí un equipo para comenzar</h2><p>Tocá uno de los cuatro equipos de arriba. Podés hacerlos jugar en cualquier orden.</p></section><div class="actions"><button class="btn danger" data-action="end-all">Finalizar la partida</button></div>`}<div class="panel"><div class="eyebrow">MARCADOR GENERAL</div><div style="margin-top:17px">${scoreboard()}</div></div></div>`}
function resultsHTML(){return `<section class="panel"><div class="eyebrow center">EL VEREDICTO DE JACK MORTIS</div><h1 class="center">¡La final ha <em>terminado!</em></h1><p class="center">Se ordena por aciertos, luego por menos errores y finalmente por tiempo restante.</p><div class="ranking">${rank().map((t,i)=>`<div class="rank"><span class="rank-number">${i+1}</span><span><b>${t.emoji} ${t.name}</b><br><span class="small">${t.correct.length} correctas · ${t.wrong.length} errores</span></span><span class="value">${t.correct.length} <small>ACIERTOS</small><div class="small">${fmt(t.remaining)} restante</div></span></div>`).join('')}</div>${isHost()?`<div class="actions" style="margin-top:25px"><button class="btn primary" data-action="reset">Preparar otra final</button><button class="btn secondary" data-action="open-view">Mostrar resultados</button></div>`:''}</section>`}
function projectionHTML(){if(!room)return `<section class="projection"><h2>No encontramos la sala</h2></section>`;if(room.phase==='finished')return `<div class="projection"><div class="eyebrow">EL VEREDICTO DEL ROSCO MALDITO</div><h1>¡Terminó la <em>gran final!</em></h1><div style="width:min(850px,100%)">${resultsHTML()}</div><button class="btn secondary" data-action="fullscreen">⛶ Pantalla completa</button></div>`;
const id=room.activeTeam,t=id&&room.teams[id],q=currentClue();return `<div class="projection"><div class="row between" style="width:100%"><span class="eyebrow">PRESENTADO POR JACK MORTIS</span><button class="btn ghost mini" data-action="fullscreen">⛶ Pantalla completa</button></div>${id?`<div class="big-team">${emoji(id)} ${tname(id)}</div><div class="big-ring-wrap">${ring(id,true)}</div><div class="subtitle">${room.clock.running?'EL TIEMPO ESTÁ CORRIENDO':t.status==='done'?'EQUIPO FINALIZADO':'TIEMPO DETENIDO'} · ${t.correct.length} ACIERTOS · ${t.wrong.length} ERRORES</div>${room.showClue&&q?`<p class="q-proj">${q.contains?'Contiene la '+q.letter+'. ':'Empieza con la '+q.letter+'. '}${escapeHTML(q.clue)}</p>`:''}`:`<h1>El tiempo <em>está por comenzar</em></h1><p>Cuatro equipos. Veintisiete letras. Un solo ganador.</p><img src="assets/jack-mortis.webp" alt="Jack Mortis en su mansión" style="width:min(68vw,480px);max-height:38vh;object-fit:cover;border-radius:16px;border:1px solid var(--line)">`}<div style="width:min(100%,960px)">${scoreboard()}</div><div class="subtitle">${room.phase==='lobby'?'ESPERANDO A LA CONDUCTORA':'CADA SEGUNDO CUENTA'}</div></div>`}
function viewerHome(){return `<section class="projection"><div class="eyebrow">PANTALLA PÚBLICA</div><h1>El Rosco <em>Maldito</em></h1><p>Necesitás abrir el enlace que genera la conductora.</p><a class="btn secondary" href="${location.pathname}">Volver al inicio</a></section>`}
function render(){app=$('app');$('connection').textContent=localMode?'MODO ENSAYO':firebaseError?'SIN CONEXIÓN':room?'CONECTADO':'FIREBASE ACTIVO';$('connection').classList.toggle('err',!!firebaseError);$('sound-toggle').textContent='♪ Sonido: '+(soundOn?'sí':'no');
if(projectionMode){app.innerHTML=room?projectionHTML():viewerHome();return}
if(!room){app.innerHTML=homeHTML();return}
if(!validRoom(room)){app.innerHTML=`<section class="panel"><h2>La sala no es del Rosco Maldito</h2><p>Este código no corresponde a una partida válida del rosco. Probá con otro código.</p><a class="btn secondary" href="${location.pathname}${localMode?'?demo=1':''}">Volver</a></section>`;return}
if(room.phase==='lobby')app.innerHTML=lobbyHTML();else if(room.phase==='finished')app.innerHTML=resultsHTML();else app.innerHTML=isHost()?playingHostHTML():projectionHTML();}
async function init(){try{soundOn=localStorage.getItem('rosco-sound')==='1'}catch{};if(localMode){clientId=uid();addEventListener('storage',e=>{if(roomCode&&e.key===localKey(roomCode)){try{room=JSON.parse(e.newValue);render()}catch{}}});if(firstCode)await openRoom(firstCode.toUpperCase());else render();return}
try{const [f,auth,dat]=await Promise.all([import('https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js'),import('https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js'),import('https://www.gstatic.com/firebasejs/10.12.3/firebase-database.js')]);api={...dat};const instance=f.initializeApp(firebaseConfig,'rosco-mortis');db=dat.getDatabase(instance);const user=await auth.signInAnonymously(auth.getAuth(instance));clientId=user.user.uid;dat.onValue(dat.ref(db,'.info/serverTimeOffset'),s=>{serverOffset=s.val()||0});if(firstCode)await openRoom(firstCode.toUpperCase());else render()}catch(e){firebaseError=`No pude conectar con Firebase: ${e.message}. Revisá que esté habilitada la autenticación anónima y que la página tenga internet.`;render()}}
async function openRoom(code){if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code)){notify('Ingresá un código válido de 6 caracteres');return}if(unsubscribe){unsubscribe();unsubscribe=null}updateURL(code);room=null;if(localMode){room=JSON.parse(localStorage.getItem(localKey(code))||'null');render();return}
app.innerHTML='<div class="panel center">Conectando con la sala…</div>';
unsubscribe=api.onValue(api.ref(db,'rooms/'+code),s=>{room=s.val();render()},e=>{firebaseError='Error de lectura: '+e.message;room=null;render()})}
async function createRoom(){if(busy)return;busy=true;try{let code=null;for(let n=0;n<8;n++){const x=randomCode(),seed=stateSeed(x);if(localMode){if(localStorage.getItem(localKey(x)))continue;localStorage.setItem(localKey(x),JSON.stringify(seed));code=x;break}else{const res=await api.runTransaction(api.ref(db,'rooms/'+x),old=>old===null?seed:undefined,{applyLocally:false});if(res.committed){code=x;break}}}if(!code)throw Error('No se pudo conseguir un código de sala.');await openRoom(code);notify('Sala creada. ¡Prepará los segundos!')}catch(e){notify('No se pudo crear: '+e.message)}finally{busy=false}}
async function mutate(fn){if(busy||!roomCode||!isHost())return false;busy=true;try{if(localMode){const original=JSON.parse(localStorage.getItem(localKey(roomCode))||'null');if(!validRoom(original))return false;const next=fn(original);if(!next)return false;localStorage.setItem(localKey(roomCode),JSON.stringify(next));room=next;render();return true}
const result=await api.runTransaction(api.ref(db,'rooms/'+roomCode),r=>{if(!validRoom(r)||r.hostUid!==uid())return;return fn(r)||undefined},{applyLocally:false});if(!result.committed){notify('No se pudo aplicar el cambio.');return false}return true}catch(e){notify('Error al guardar: '+e.message);return false}finally{busy=false}}
async function lobbyChange(target){if(room?.phase!=='lobby'||!isHost())return;const numeric=Math.max(0,Math.min(600,Math.trunc(Number(target.value)||0)));await mutate(r=>{if(r.phase!=='lobby')return null;if(target.id==='base-seconds')r.base=numeric;else if(target.dataset.bonus)r.bonuses[target.dataset.bonus]=numeric;else return null;for(const t of TEAMS)r.teams[t.id].remainingMs=(r.base+(r.bonuses[t.id]||0))*1000;return r})}
async function changeTeam(id){
if(room?.phase!=='playing'||!TEAMS.some(t=>t.id===id))return;
if(room.teams[id]?.status==='done'||currentTime(room,id)<=0){notify('Ese equipo ya terminó o no tiene tiempo.');return}
await mutate(r=>{
  if(r.phase!=='playing'||r.teams[id]?.status==='done'||r.teams[id].remainingMs<=0)return null;
  settleClock(r,now()); // Pausa automáticamente al salir del equipo anterior.
  r.activeTeam=id;
  r.clock={running:false,startedAt:0};
  r.lastAction={};
  checkFinished(r);
  return r;
});
}
async function act(type){
// Las acciones de sala deben funcionar ANTES de elegir un equipo activo.
if(type==='start-game'){
  const worked=await mutate(r=>{if(r.phase!=='lobby')return null;r.phase='playing';r.activeTeam='brujos';r.clock={running:false,startedAt:0};r.lastAction={};return r});
  if(worked)notify('¡Gran final iniciada! Elegí el equipo y tocá Iniciar / Reanudar.');
  return;
}
if(type==='end-all'){
  if(!confirm('¿Finalizar la partida de los cuatro equipos? Esta acción cierra el juego para todos.'))return;
  await mutate(r=>{if(r.phase!=='playing')return null;settleClock(r,now());r.clock.running=false;r.phase='finished';r.finishReason='manual';for(const t of TEAMS)r.teams[t.id].status='done';return r});return;
}
if(type==='reset'){
  if(!confirm('¿Reiniciar la final? Se borrarán los aciertos y errores de esta sala.'))return;
  await mutate(r=>{if(r.phase!=='finished')return null;let fresh=stateSeed(r.code);fresh.hostUid=r.hostUid;fresh.createdAt=r.createdAt;return fresh});return;
}
const id=room?.activeTeam;
if(type==='show-clue'){await mutate(r=>{if(r.phase!=='playing')return null;r.showClue=!r.showClue;return r});return}
if(type==='next-team'){
  const ok=await mutate(r=>{
    if(r.phase!=='playing'||!r.activeTeam)return null;
    const oldTeam=r.activeTeam;
    settleClock(r,now());
    chooseNextTeam(r,oldTeam);
    r.lastAction={};
    checkFinished(r);
    return r;
  });
  if(ok)notify('Turno pausado. El siguiente equipo está listo para reanudar.');
  return;
}
if(!id){notify('Elegí un equipo antes de continuar.');return}
if(type==='toggle-clock'){
const t=room.teams[id];if(!room.clock.running&&(t.status==='done'||currentTime(room,id)<=0))return;
await mutate(r=>{
 const at=now();if(r.phase!=='playing')return null;
 if(r.clock.running){
   const previous=r.activeTeam;
   settleClock(r,at);
   if(r.teams[previous].status==='done')chooseNextTeam(r,previous);
   checkFinished(r);
 }else if(r.teams[r.activeTeam].status!=='done'&&r.teams[r.activeTeam].remainingMs>0){
   r.lastAction={}; // El deshacer solo pertenece al turno que acaba de terminar.
   r.clock.running=true;r.clock.startedAt=at;
 }
 return r;
});return}
if(['correct','wrong','pass'].includes(type)){
const worked=await mutate(r=>{const at=now();if(r.phase!=='playing'||!r.clock.running)return null;const tm=r.activeTeam,t=r.teams[tm];if(!t?.queue?.length)return null;settleClock(r,at);if(t.status==='done'){checkFinished(r);return r}
const letter=t.queue[0];r.lastAction={teamId:tm,previous:snapshot(t)};
t.queue.shift();
if(type==='correct')t.correct.push(letter);
else if(type==='wrong')t.wrong.push(letter);
else t.queue.push(letter);
if(t.queue.length===0)t.status='done';
if(type==='pass' || t.status==='done'){
  // PASAPALABRA: la letra queda pendiente al final de la fila del equipo.
  // Ni su tiempo ni sus aciertos/errores se mezclan con los del siguiente.
  chooseNextTeam(r,tm); // Deja el nuevo reloj detenido, no consume tiempo sin dar inicio.
}else if(t.remainingMs>0){
  // Correcta/incorrecta: continúa el mismo equipo mientras le quede tiempo.
  r.clock.running=true;r.clock.startedAt=at;
}
checkFinished(r);return r});if(worked)beep(type==='correct'?850:type==='wrong'?260:500);return}
if(type==='undo'){
await mutate(r=>{if(r.phase!=='playing'||r.clock.running||!r.lastAction?.teamId)return null;const id=r.lastAction.teamId,t=r.teams[id],prev=r.lastAction.previous;t.queue=prev.queue;t.correct=prev.correct;t.wrong=prev.wrong;t.status=t.remainingMs>0?prev.status:'done';r.activeTeam=id;r.lastAction={};return r});return}
if(type==='finish-team'){
if(!confirm('¿Dar por terminado el rosco de '+tname(id)+'? No podrá volver a contestar.'))return;
await mutate(r=>{if(r.phase!=='playing'||r.clock.running)return null;r.teams[id].status='done';r.lastAction={};chooseNextTeam(r,id);checkFinished(r);return r});return}
}
async function copy(text){try{await navigator.clipboard.writeText(text);notify('Enlace copiado')}catch{prompt('Copiá este enlace:',text)}}
function tick(){if(!room)return;document.querySelectorAll('[data-teamtime]').forEach(el=>{const id=el.dataset.teamtime;const ms=currentTime(room,id);el.textContent=fmt(ms);el.classList.toggle('zero',ms<=0)});const id=room.activeTeam;if(id){const base=((room.base||0)+(room.bonuses?.[id]||0))*1000;const el=$('time-bar');if(el)el.style.width=base?`${Math.min(100,100*currentTime(room,id)/base)}%`:'0%';if(room.phase==='playing'&&room.clock.running&&isHost()&&currentTime(room,id)<=0&&!busy){mutate(r=>{if(r.phase!=='playing'||!r.clock.running)return null;const prior=r.activeTeam;settleClock(r,now());if(r.teams[prior]?.status==='done')chooseNextTeam(r,prior);checkFinished(r);return r})}}}

document.addEventListener('submit',async e=>{if(e.target.id==='join-form'){e.preventDefault();await openRoom($('join-code').value.trim().toUpperCase())}});
document.addEventListener('change',async e=>{if(e.target.id==='base-seconds'||e.target.dataset?.bonus)await lobbyChange(e.target)});
document.addEventListener('click',async e=>{if(e.target.closest('#sound-toggle')){soundOn=!soundOn;localStorage.setItem('rosco-sound',soundOn?'1':'0');render();beep();return}
const teamBtn=e.target.closest('[data-team]');if(teamBtn){await changeTeam(teamBtn.dataset.team);return}
const b=e.target.closest('[data-action]');if(!b)return;const action=b.dataset.action;
if(action==='create'){await createRoom();return}if(action==='copy-host'){await copy(getHostLink());return}if(action==='open-view'){window.open(getViewerLink(),'_blank','noopener');return}if(action==='fullscreen'){const el=$('app');if(document.fullscreenElement){document.exitFullscreen?.()}else el.requestFullscreen?.();return}
await act(action)});
setInterval(tick,150);
init();
