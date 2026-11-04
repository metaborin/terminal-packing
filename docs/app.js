import {initPWA} from './pwa.js';
import {newState,parseRoster,validateState,importRoster,lookup,pack,undoPack,exportCSV,boxSummary,normalizeId} from './core.js';

const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=iso=>new Date(iso).toLocaleString('ja-JP',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
let state=newState(),db,ready=false,page='scan',filter='all',ocrBusy=false,pendingWrites=0,boxChanging=false,stream=null,photo=null,selected=null,confirmAction=null,toastTimer,importName='貼り付けた番号一覧';
const channel='BroadcastChannel' in window?new BroadcastChannel('packing-notebook-v1'):null;
const buttons=['open-camera','pick-photo','manual-toggle'];
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function problem(error){toast(error?.message||String(error));}
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open('terminal-packing-v1',1);req.onupgradeneeded=()=>req.result.createObjectStore('notebook');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error('別の画面を閉じてから、もう一度開いてください。'));});}
function readState(){return new Promise((resolve,reject)=>{const tx=db.transaction('notebook','readonly');const req=tx.objectStore('notebook').get('state');req.onsuccess=()=>{try{resolve(req.result?validateState(req.result):newState());}catch(e){reject(e);}};req.onerror=()=>reject(req.error);});}
function change(mutator,{replace=false}={}){pendingWrites++;return new Promise((resolve,reject)=>{if(!db||(!ready&&!replace))return reject(new Error('保存先の準備ができていません。'));const tx=db.transaction('notebook','readwrite');const store=tx.objectStore('notebook');let next,issue;const req=store.get('state');req.onsuccess=()=>{try{const current=replace?newState():(req.result?validateState(req.result):newState());next=mutator(current);next.updatedAt=new Date().toISOString();validateState(next);store.put(next,'state');}catch(e){issue=e;tx.abort();}};tx.oncomplete=()=>{state=next;ready=true;$('fatal').hidden=true;render();channel?.postMessage('changed');resolve(next);};tx.onabort=tx.onerror=()=>reject(issue||new Error('記録を保存できませんでした。梱包完了にはしていません。空き容量などを確認してください。'));}).finally(()=>{pendingWrites--;renderBoxControls();});}
channel?.addEventListener('message',async()=>{if(!db)return;try{state=await readState();render();if(selected){if(selected.box!==state.box&&lookup(state,selected.id).status==='ready'){clearResult();toast('別の画面で箱番号が変わりました。箱を確認して、もう一度端末番号を照合してください。');}else showMatch(selected.id,selected.image);}}catch(e){problem(e);}});
function nav(next){page=next;for(const name of ['scan','records','setup'])$('page-'+name).hidden=name!==next;document.querySelectorAll('.bottom-nav [data-page]').forEach(b=>{b.classList.toggle('active',b.dataset.page===next);b.setAttribute('aria-current',b.dataset.page===next?'page':'false');});if(next==='records')renderRecords();window.scrollTo({top:0,behavior:'instant'});}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.page)));
$('start-setup').onclick=()=>nav('setup');
$('date-label').textContent=new Date().toLocaleDateString('ja-JP',{month:'long',day:'numeric',weekday:'short'});
function empty(message){return `<div class="empty-state"><svg class="empty-icon"><use href="#i-box"/></svg>${message}</div>`;}
function render(){
 const total=state.roster.length,count=state.records.length;
 $('stat-packed').innerHTML=count+'<small>台</small>';$('stat-total').innerHTML=(total||'—')+'<small>台</small>';$('stat-left').innerHTML=(total?total-count:'—')+'<small>台</small>';$('progress-bar').style.width=(total?100*count/total:0)+'%';
 $('onboard').hidden=total>0;
 renderBoxControls();
 $('current-box-count').textContent=state.records.filter(r=>r.box===state.box).length+' 台';
 buttons.forEach(id=>$(id).disabled=!ready||!total||ocrBusy);
 $('recent-list').innerHTML=count?[...state.records].sort((a,b)=>b.packedAt.localeCompare(a.packedAt)).slice(0,4).map(r=>`<div class="recent-row"><div><strong>${esc(r.id)}</strong><small>${esc(r.box)} · ${time(r.packedAt)}</small></div><svg class="recent-check"><use href="#i-check"/></svg></div>`).join(''):empty('まだ梱包の記録がありません。<br>最初の1台から始めましょう。');
 $('roster-info').textContent=total?`${state.rosterName} ／ ${total} 台を登録済み`:'番号一覧はまだ登録されていません。';
 if(page==='records')renderRecords();
}
function renderRecords(){
 const byId=new Map(state.records.map(r=>[r.id,r]));const query=$('search-input').value.trim();
 const rows=state.roster.map(id=>({id,record:byId.get(id)})).filter(({id,record})=>(filter==='all'||(filter==='packed'?!!record:!record))&&(!query||id.includes(normalizeId(query))||record?.box.includes(query)));
 const summary=new Map();for(const r of state.records)summary.set(r.box,(summary.get(r.box)||0)+1);
 $('box-summary').innerHTML=[...summary].sort((a,b)=>a[0].localeCompare(b[0],'ja',{numeric:true})).map(([box,n])=>`<div class="box-chip">${esc(box)}<strong>${n}</strong> 台</div>`).join('');
 $('record-count').textContent=`${rows.length} 台を表示 ／ 一覧 ${state.roster.length} 台`;
 $('record-list').innerHTML=rows.length?rows.map(({id,record})=>`<div class="record-row"><span class="state-tag ${record?'':'pending'}">${record?'梱包済':'未梱包'}</span><div class="record-detail"><strong>${id}</strong>${record?`<small>${esc(record.box)} · ${time(record.packedAt)}</small>`:''}</div>${record?`<button type="button" class="undo" data-undo="${id}" aria-label="${id}の梱包記録を取り消す">取消</button>`:''}</div>`).join(''):empty(state.roster.length?'該当する端末がありません。':'準備画面で番号一覧を登録してください。');
}
$('search-input').oninput=renderRecords;
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(n=>n.classList.toggle('active',n===b));renderRecords();});
const standardBoxes=Array.from({length:129},(_,i)=>`箱${String(i+1).padStart(2,'0')}`);
let boxOptionsKey='';
function boxLocked(){return !ready||boxChanging||pendingWrites>0||ocrBusy||Boolean(selected&&lookup(state,selected.id).status==='ready');}
function renderBoxControls(){
 const names=[...new Set([...standardBoxes,state.box,...state.records.map(r=>r.box),...state.events.map(e=>e.box)])];
 const key=JSON.stringify(names);
 if(key!==boxOptionsKey){$('box-input').replaceChildren(...names.map(name=>{const option=document.createElement('option');option.value=option.textContent=name;return option;}));boxOptionsKey=key;}
 $('box-input').value=state.box;
 const index=standardBoxes.indexOf(state.box),locked=boxLocked();
 $('box-input').disabled=locked;
 $('prev-box').disabled=locked||index<=0;
 $('next-box').disabled=locked||index<0||index===standardBoxes.length-1;
 $('box-hint').textContent=selected&&lookup(state,selected.id).status==='ready'
  ? '梱包完了にするか、照合結果を閉じると箱を替えられます。'
  : index<0 ? '保存済みの箱名です。別の箱へ移るときは一覧から選べます。'
  : '振り分け表にも、同じ箱番号を書いてください。';
}
async function switchBox(target){
 if(boxLocked())return renderBoxControls();
 if(target===state.box)return;
 const from=state.box;
 boxChanging=true;renderBoxControls();
 try{await change(s=>{if(s.box!==from)throw new Error('別の画面で箱番号が変わりました。現在の箱を確認してください。');return {...s,box:target};});clearResult();toast(`${target} に切り替えました。箱の表示を確認してください。`);}
 catch(e){problem(e);try{state=await readState();render();}catch{}}
 finally{boxChanging=false;renderBoxControls();}
}
$('box-input').onchange=()=>{const target=$('box-input').value;$('box-input').value=state.box;switchBox(target);};
$('prev-box').onclick=()=>{const i=standardBoxes.indexOf(state.box);if(i>0)switchBox(standardBoxes[i-1]);};
$('next-box').onclick=()=>{const i=standardBoxes.indexOf(state.box);if(i>=0&&i<standardBoxes.length-1)switchBox(standardBoxes[i+1]);};
function confirm(title,body,action,button='確定する'){confirmAction=action;$('confirm-title').textContent=title;$('confirm-body').innerHTML=body;$('confirm-ok').textContent=button;$('confirm-ok').disabled=false;$('confirm-dialog').showModal();}
function closeConfirm(){$('confirm-dialog').close();confirmAction=null;}
$('confirm-close').onclick=$('confirm-cancel').onclick=closeConfirm;
$('confirm-ok').onclick=async()=>{if(!confirmAction)return;$('confirm-ok').disabled=true;try{await confirmAction();closeConfirm();}catch(e){problem(e);$('confirm-ok').disabled=false;}};
$('confirm-dialog').addEventListener('close',()=>confirmAction=null);
$('record-list').onclick=e=>{const b=e.target.closest('[data-undo]');if(b)askUndo(b.dataset.undo);};
function askUndo(id){const r=state.records.find(r=>r.id===id);if(!r)return;confirm('梱包記録を取り消しますか？',`<p><strong>${esc(id)}</strong> ／ ${esc(r.box)}</p><p>この番号を未梱包に戻します。実物の入っている箱も確認してください。</p>`,async()=>{await change(s=>{const actual=s.records.find(n=>n.id===id);if(!actual||actual.box!==r.box||actual.packedAt!==r.packedAt)throw new Error('記録が変更されています。一度閉じて、最新の記録を確認してください。');return undoPack(s,id,new Date().toISOString());});if(selected?.id===id)showMatch(id,selected.image);toast('未梱包に戻しました。');},'記録を取り消す');}
$('manual-toggle').onclick=()=>{$('manual-form').hidden=!$('manual-form').hidden;if(!$('manual-form').hidden)$('manual-id').focus();};
$('manual-form').onsubmit=e=>{e.preventDefault();if(ocrBusy)return;showMatch($('manual-id').value,null);};
function showMatch(raw,image){
 const result=lookup(state,raw),{status,id}=result;selected={id,image,box:state.box};$('result').hidden=false;$('result').className='result-card';
 const photoHTML=image?`<img class="result-photo" src="${image}" alt="読み取ったシールの画像">`:'';
 const number=`<div class="result-number">${esc(id||raw)}</div>${photoHTML}`;
 if(status==='ready'){$('result').innerHTML=`<p class="result-kicker">✓ 対象の端末・未梱包</p>${number}<p>シールと8桁すべてを見比べてください。<br><strong>${esc(state.box)}</strong> に入れてから完了を押します。</p><div class="result-actions"><button type="button" id="pack-now" class="primary">${esc(state.box)} に梱包完了</button><button type="button" id="dismiss-result" class="secondary">戻る</button></div>`;$('pack-now').onclick=completePack;}
 else if(status==='packed'){const r=result.record;$('result').classList.add('warning');$('result').innerHTML=`<p class="result-kicker">登録済みの番号です</p>${number}<p><strong>${esc(r.box)}</strong> に梱包済みです。<br>${time(r.packedAt)} に記録されています。</p><div class="result-actions"><button type="button" id="dismiss-result" class="secondary">次の端末へ</button><button type="button" id="undo-result" class="text-button">この記録を取り消す</button></div>`;$('undo-result').onclick=()=>askUndo(id);}
 else{$('result').classList.add('danger');const title=status==='not-found'?'番号一覧にありません':status==='no-roster'?'番号一覧を登録してください':'8桁の番号を入力してください';$('result').innerHTML=`<p class="result-kicker">${title}</p>${number}<p>番号を確認し、撮り直すか手入力で照合してください。<br>この状態では梱包記録を登録できません。</p><button type="button" id="dismiss-result" class="secondary">戻る</button>`;}
 $('dismiss-result').onclick=clearResult;renderBoxControls();$('result').scrollIntoView({block:'nearest',behavior:'smooth'});
}
function clearResult(){selected=null;$('result').hidden=true;$('result').replaceChildren();$('manual-id').value='';renderBoxControls();}
async function completePack(){const current=selected;if(!current)return;const b=$('pack-now');b.disabled=true;try{await change(s=>{if(s.box!==current.box)throw new Error('箱番号が変わりました。入れる箱を確認して、もう一度完了を押してください。');return pack(s,current.id,current.box,new Date().toISOString());});clearResult();toast(`${current.id} を ${current.box} に記録しました。`);if(state.records.length===1)navigator.storage?.persist?.().catch(()=>{});}catch(e){problem(e);try{state=await readState();render();showMatch(current.id,current.image);}catch{b.disabled=false;}}}

async function decodeText(file){if(file.size>5*1024*1024)throw new Error('番号一覧は5MB以内のファイルを選んでください。');const bytes=await file.arrayBuffer();let text=new TextDecoder('utf-8').decode(bytes);if(text.includes('\uFFFD')){try{text=new TextDecoder('shift_jis').decode(bytes);}catch{}}return text;}
$('import-file').onclick=()=>$('roster-file').click();
$('roster-file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{const text=await decodeText(f);importName=f.name;$('roster-text').value=text;previewImport(text);}catch(error){problem(error);}e.target.value='';};
$('roster-text').oninput=()=>importName='貼り付けた番号一覧';
$('preview-import').onclick=()=>previewImport($('roster-text').value);
function previewImport(text){try{const parsed=parseRoster(text);if(parsed.invalid.length){confirm('読み込めない行があります',`<p>8桁の端末番号だけの一覧を用意してください。修正してから再度確認します。</p><p>${parsed.invalid.slice(0,8).map(esc).join('<br>')}${parsed.invalid.length>8?'<br>ほか '+(parsed.invalid.length-8)+' 行':''}</p>`,()=>{},'閉じる');return;}if(!parsed.ids.length)throw new Error('端末番号を入力してください。');const name=importName;confirm('この番号一覧を登録しますか？',`<p><strong style="font-size:28px">${parsed.ids.length}</strong> 台の端末番号</p><p>${parsed.ids.slice(0,6).map(esc).join(' ／ ')}${parsed.ids.length>6?' …':''}</p>${parsed.duplicates?`<p>重複 ${parsed.duplicates} 件は1台にまとめます。</p>`:''}<p>今回回収する端末の一覧であることを確認してください。登録済みの梱包記録は引き継ぎます。</p>`,async()=>{await change(s=>importRoster(s,parsed.ids,name));clearResult();$('roster-text').value='';nav('scan');toast(`${parsed.ids.length} 台の番号一覧を登録しました。`);},'一覧を登録する');}catch(e){problem(e);}}
function filename(prefix,ext){const now=new Date();return `${prefix}_${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.${ext}`;}
async function saveFile(content,type,name){const file=new File([content],name,{type});if(navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:'端末回収ノート'});toast('共有操作を終えました。ファイルの保存先を確認してください。');return;}catch(e){if(e.name==='AbortError')return;}}
 const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);toast('書き出しました。保存したファイルを確認してください。');}
$('export-csv').onclick=()=>{if(!state.roster.length)return toast('番号一覧を登録してから書き出してください。');saveFile(exportCSV(state),'text/csv;charset=utf-8',filename('梱包記録','csv')).catch(problem);};
$('backup').onclick=()=>{if(!state.roster.length)return toast('番号一覧を登録してから保存してください。');saveFile(JSON.stringify(state,null,2),'application/json',filename('端末回収バックアップ','json')).catch(problem);};
$('restore').onclick=()=>$('restore-file').click();
$('restore-file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;try{if(f.size>20*1024*1024)throw new Error('バックアップが大きすぎます。');const restored=validateState(JSON.parse(await f.text()));confirm('バックアップから復元しますか？',`<p>番号一覧 <strong>${restored.roster.length} 台</strong> ／ 梱包済み <strong>${restored.records.length} 台</strong></p><p>現在の一覧と記録を、このバックアップの内容に置き換えます。必要な現在の記録は、先にバックアップを保存してください。</p>`,async()=>{await change(()=>restored,{replace:true});clearResult();nav('scan');toast('バックアップから復元しました。');},'この内容に復元する');}catch(error){problem(new Error('復元できません：'+error.message));}e.target.value='';};

function stopCamera(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}$('camera-video').srcObject=null;}
$('open-camera').onclick=async()=>{if(ocrBusy)return;$('camera-status').textContent='カメラを準備しています…';$('take-photo').disabled=true;$('camera-dialog').showModal();try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('この画面ではカメラを直接開けません。下の「iPhoneの撮影画面を使う」を選んでください。');stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});if(!$('camera-dialog').open){stopCamera();return;}$('camera-video').srcObject=stream;await $('camera-video').play();$('take-photo').disabled=false;$('camera-status').textContent='他の端末の番号が枠に入らないようにします。';}catch(e){stopCamera();$('camera-status').textContent=e.name==='NotAllowedError'?'カメラの利用を許可するか、下の「iPhoneの撮影画面を使う」を選んでください。':e.message;}};
$('close-camera').onclick=()=>$('camera-dialog').close();$('camera-dialog').addEventListener('close',stopCamera);
$('camera-fallback').onclick=()=>{$('camera-dialog').close();$('capture-input').click();};
$('take-photo').onclick=()=>{const v=$('camera-video');if(!v.videoWidth)return;const rect=v.getBoundingClientRect(),guide=$('camera-guide').getBoundingClientRect();const scale=Math.max(rect.width/v.videoWidth,rect.height/v.videoHeight);const ox=(v.videoWidth*scale-rect.width)/2,oy=(v.videoHeight*scale-rect.height)/2;const x=(guide.left-rect.left+ox)/scale,y=(guide.top-rect.top+oy)/scale,w=guide.width/scale,h=guide.height/scale;const c=document.createElement('canvas');c.width=Math.round(w);c.height=Math.round(h);c.getContext('2d').drawImage(v,x,y,w,h,0,0,c.width,c.height);$('camera-dialog').close();readCanvas(c);};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&stream)$('camera-dialog').close();});
$('pick-photo').onclick=()=>$('photo-input').click();
for(const id of ['photo-input','capture-input'])$(id).onchange=async e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;try{if(f.size>35*1024*1024)throw new Error('35MB以内の写真を選んでください。');await loadPhoto(f);}catch(error){problem(error);}};
async function loadPhoto(file){const url=URL.createObjectURL(file);try{const im=new Image();im.src=url;await im.decode();const c=document.createElement('canvas');const scale=Math.min(1,3600/Math.max(im.naturalWidth,im.naturalHeight));c.width=Math.round(im.naturalWidth*scale);c.height=Math.round(im.naturalHeight*scale);c.getContext('2d').drawImage(im,0,0,c.width,c.height);photo={source:c,zoom:1,cx:c.width/2,cy:c.height/2};$('photo-dialog').showModal();drawPhoto();}catch{throw new Error('この写真を開けませんでした。カメラで撮影するか、JPEG・PNGの写真を選んでください。');}finally{URL.revokeObjectURL(url);}}
function photoScale(){return Math.min(1000/photo.source.width,1000/photo.source.height)*photo.zoom;}
function drawPhoto(){if(!photo)return;const c=$('photo-canvas');c.width=c.height=1000;const ctx=c.getContext('2d');ctx.fillStyle='#202a24';ctx.fillRect(0,0,1000,1000);const s=photoScale();ctx.drawImage(photo.source,500-photo.cx*s,500-photo.cy*s,photo.source.width*s,photo.source.height*s);}
$('photo-canvas').onclick=e=>{if(!photo)return;const r=e.currentTarget.getBoundingClientRect(),s=photoScale();photo.cx+=(1000*(e.clientX-r.left)/r.width-500)/s;photo.cy+=(1000*(e.clientY-r.top)/r.height-500)/s;photo.zoom=Math.min(14,photo.zoom*1.7);drawPhoto();};
$('photo-in').onclick=()=>{photo.zoom=Math.min(20,photo.zoom*1.35);drawPhoto();};$('photo-out').onclick=()=>{photo.zoom=Math.max(.5,photo.zoom/1.35);drawPhoto();};
$('photo-rotate').onclick=()=>{const src=photo.source,c=document.createElement('canvas');c.width=src.height;c.height=src.width;const ctx=c.getContext('2d');ctx.translate(c.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(src,0,0);photo={source:c,zoom:1,cx:c.width/2,cy:c.height/2};drawPhoto();};
$('close-photo').onclick=()=>$('photo-dialog').close();$('photo-dialog').addEventListener('close',()=>{photo=null;});
$('read-photo').onclick=()=>{const c=document.createElement('canvas');c.width=1680;c.height=480;const ctx=c.getContext('2d'),s=photoScale();ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(photo.source,photo.cx-420/s,photo.cy-120/s,840/s,240/s,0,0,c.width,c.height);$('photo-dialog').close();readCanvas(c);};
async function readCanvas(c){
 if(ocrBusy)return;ocrBusy=true;selected=null;render();const image=c.toDataURL('image/jpeg',.8);$('result').hidden=false;$('result').className='result-card';$('result').innerHTML='<p class="result-kicker"><span class="loading"></span>番号を読み取っています</p><p id="ocr-status" role="status">初回は読み取りの準備に少し時間がかかります。</p>';$('result').scrollIntoView({block:'nearest',behavior:'smooth'});
 try{const {recognize}=await import('./ocr.js');const result=await recognize(c,{onProgress:p=>{if($('ocr-status'))$('ocr-status').textContent=p.status+(p.progress>0?' '+Math.round(p.progress*100)+'%':'');}});
 if(result.candidates.length===1){showMatch(result.candidates[0].id,image);}
 else if(result.candidates.length>1){$('result').className='result-card warning';$('result').innerHTML=`<p class="result-kicker">複数の番号が見つかりました</p><img class="result-photo" src="${image}" alt="読み取り範囲"><p>実物のシールと一致する番号を選んでください。</p><div class="result-actions">${result.candidates.map(c=>`<button type="button" class="secondary" data-candidate="${c.id}">${c.id}</button>`).join('')}</div>`;$('result').querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>showMatch(b.dataset.candidate,image));}
 else{$('result').className='result-card warning';$('result').innerHTML=`<p class="result-kicker">8桁の番号を読み取れませんでした</p><img class="result-photo" src="${image}" alt="読み取り範囲"><p>数字を横向きに大きく映して、もう一度お試しください。手入力でも照合できます。</p>`;$('manual-form').hidden=false;}
 }catch(e){$('result').className='result-card warning';$('result').innerHTML='<p class="result-kicker">読み取りを開始できませんでした</p><p>初回は通信できる場所で「準備・保存」から読み取りを準備してください。手入力でも作業できます。</p>';$('manual-form').hidden=false;console.error('OCR failed',e?.message);}
 finally{ocrBusy=false;render();}
}
async function init(){
 try{db=await openDB();state=await readState();ready=true;render();}
 catch(e){$('fatal').hidden=false;$('fatal').textContent='このブラウザの保存先を開けません。プライベートブラウズを終了するか、Safariで開き直してください。既存の記録に問題がある場合は、控えを確認してください。';render();}
 initPWA({isBusy:()=>pendingWrites>0||ocrBusy||document.querySelector('dialog[open]')!==null||Boolean(selected&&lookup(state,selected.id).status==='ready')});
}
init();
