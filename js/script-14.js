
/* Troca manual e conservadora de alterações. Não altera a rotina de backup completo. */
(()=>{
 'use strict';
 const KEY='v24_sync_base_1', LEDGER='v24_sync_recebidos_1', DEVICE='v24_sync_dispositivo_1';
 const el=(id)=>document.getElementById(id), clone=(v)=>JSON.parse(JSON.stringify(v));
 const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
 const status=(m,bad=false)=>{const e=el('v24SyncStatus');if(e){e.textContent=m;e.style.color=bad?'#a11b29':'#246448'}};
 const keyID=(o)=>o&&typeof o==='object'&&!Array.isArray(o)&&typeof o.id==='string'&&o.id.length>0;
 const arrIDs=(arr)=>Array.isArray(arr)&&arr.every(keyID)&&new Set(arr.map(x=>x.id)).size===arr.length;
 const forbidden=new Set(['atualizadoEm']);
 const readBase=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'null')}catch{return null}};
 const writeBase=(o)=>localStorage.setItem(KEY,JSON.stringify(o));
 const readSeen=()=>{try{return JSON.parse(localStorage.getItem(LEDGER)||'[]')}catch{return []}};
 const id=()=>crypto.randomUUID?crypto.randomUUID():('pkt-'+Date.now()+'-'+Math.random().toString(36).slice(2));
 const device=()=>{let v=localStorage.getItem(DEVICE);if(!v){v=id();localStorage.setItem(DEVICE,v)}return v};
 function normalized(){
  if(!state||!state.rooms)throw Error('Abra os dados do sistema antes de sincronizar.');
  return clone(state);
 }
 const esc=(p)=>p.map(x=>String(x)).join(' / ');
 function diff(a,b,path=[],changes=[]){
  if(eq(a,b))return changes;
  if(path.length===1&&forbidden.has(path[0]))return changes;
  if(arrIDs(a)&&arrIDs(b)){
    const am=new Map(a.map(x=>[x.id,x])),bm=new Map(b.map(x=>[x.id,x]));
    for(const k of new Set([...am.keys(),...bm.keys()]))diff(am.get(k),bm.get(k),[...path,'@'+k],changes);
    return changes;
  }
  if(a&&b&&!Array.isArray(a)&&!Array.isArray(b)&&typeof a==='object'&&typeof b==='object'){
    for(const k of new Set([...Object.keys(a),...Object.keys(b)]))diff(a[k],b[k],[...path,k],changes);
    return changes;
  }
  if(Array.isArray(a)&&Array.isArray(b)&&eq(a,b))return changes;
  // Controle de ES e sequências sem ids são indivisíveis: só aplica se nenhum outro computador os modificou.
  changes.push({path,old:a===undefined?{__v24absent:true}:a,value:b===undefined?{__v24absent:true}:b});
  return changes;
 }
 const absent=(v)=>v&&typeof v==='object'&&v.__v24absent===true&&Object.keys(v).length===1;
 function pick(root,path){
  let o=root;
  for(const token of path){
    if(o==null)return {__v24absent:true};
    if(String(token).startsWith('@')){
      if(!Array.isArray(o))return {__v24absent:true};
      o=o.find(v=>v&&v.id===token.slice(1));
    }else o=o[token];
  }
  return o===undefined?{__v24absent:true}:o;
 }
 function assign(root,path,value){
  let o=root;
  for(let i=0;i<path.length-1;i++){
    const token=path[i],next=path[i+1];
    if(String(token).startsWith('@')){
      if(!Array.isArray(o))throw Error('Estrutura de coleção incompatível');
      let item=o.find(v=>v&&v.id===token.slice(1));
      if(!item){item={id:token.slice(1)};o.push(item)}o=item;
    }else{
      if(o[token]===undefined||o[token]===null)o[token]=String(next).startsWith('@')?[]:{};
      o=o[token];
    }
  }
  const last=path[path.length-1];
  if(String(last).startsWith('@')){
    if(!Array.isArray(o))throw Error('Estrutura inválida');
    const idx=o.findIndex(v=>v&&v.id===last.slice(1));
    if(absent(value)){if(idx>=0)o.splice(idx,1)}
    else if(idx>=0)o[idx]=clone(value);
    else o.push(clone(value));
  }else if(absent(value))delete o[last];
  else o[last]=clone(value);
 }
 const b64=(bytes)=>{let out='';for(let i=0;i<bytes.length;i+=8192)out+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(out)};
 const from64=(s)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
 const enc=new TextEncoder(),dec=new TextDecoder();
 async function derive(pass,salt){
  const raw=await crypto.subtle.importKey('raw',enc.encode(pass),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:240000,hash:'SHA-256'},raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function seal(obj,pass){
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await derive(pass,salt), data=enc.encode(JSON.stringify(obj));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,data));
  return {type:'V24-ATUALIZACOES-CRIPTOGRAFADAS',version:1,kdf:'PBKDF2-SHA256-240000',cipher:'AES-256-GCM',salt:b64(salt),iv:b64(iv),data:b64(ciphertext)};
 }
 async function unseal(pkg,pass){
  if(pkg?.type!=='V24-ATUALIZACOES-CRIPTOGRAFADAS'||pkg.version!==1)throw Error('Este arquivo não é um pacote de atualizações V24.');
  const key=await derive(pass,from64(pkg.salt));
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(pkg.iv)},key,from64(pkg.data));
  return JSON.parse(dec.decode(plain));
 }
 const PASTA_SYNC_KEY='v24_pasta_exportacao_atualizacoes_v1';
 let pastaSyncCache=null;
 async function pastaSync(){
  if(pastaSyncCache)return pastaSyncCache;
  try{pastaSyncCache=await lerDadosArquivoStore(ARCHIVE_FOLDER_STORE,PASTA_SYNC_KEY)||null;return pastaSyncCache;}
  catch(e){return null}
 }
 async function atualizarPastaSync(){
  const campo=el('v24SyncFolderStatus');if(!campo)return;
  const pasta=await pastaSync();
  campo.textContent=pasta?.name?'📁 '+pasta.name:'📥 Download padrão do navegador';
  campo.title=pasta?.name?'Pasta selecionada: '+pasta.name:'Nenhuma pasta selecionada; os arquivos serão baixados normalmente';
 }
 async function escolherPastaSync(){
  if(!window.isSecureContext||typeof window.showDirectoryPicker!=='function'){
   status('⚠ Este navegador/contexto não permite escolher pasta diretamente. O download convencional continua disponível.',true);
   return;
  }
  try{
   const pasta=await window.showDirectoryPicker({mode:'readwrite',id:'v24-atualizacoes'});
   await gravarDadosArquivoStore(ARCHIVE_FOLDER_STORE,PASTA_SYNC_KEY,pasta);
   pastaSyncCache=pasta;
   await atualizarPastaSync();
   status('✓ Pasta de exportação definida: '+pasta.name+'.');
  }catch(e){if(e?.name!=='AbortError')status('✕ Não foi possível definir a pasta: '+e.message,true)}
 }
 async function guardarPacoteExportacao(content,name){
  const pasta=await pastaSync();
  if(pasta){
   try{
    let permissao=await pasta.queryPermission({mode:'readwrite'});
    if(permissao!=='granted'&&typeof pasta.requestPermission==='function')permissao=await pasta.requestPermission({mode:'readwrite'});
    if(permissao==='granted'){
     const arquivo=await pasta.getFileHandle(name,{create:true});
     const writer=await arquivo.createWritable();
     try{await writer.write(new Blob([JSON.stringify(content)],{type:'application/json'}));await writer.close();}
     catch(e){try{await writer.abort()}catch(_){}throw e}
     return 'pasta '+pasta.name;
    }
    status('⚠ Sem permissão para a pasta selecionada. Usando download normal.',true);
   }catch(e){status('⚠ Pasta indisponível ('+e.message+'). Usando download normal.',true)}
  }
  download(content,name);
  return 'pasta padrão de downloads';
 }
 const download=(content,name)=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(content)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
 };
 function prepareBase(){
  if(readBase())status('Base de referência encontrada. Exporte atualizações após trabalhar neste computador.');
  else status('Antes de exportar, carregue o MESMO backup nos três computadores e clique em Definir base inicial.',true);
 }
 async function exportUpdates(){
  try{
   if(!crypto.subtle)throw Error('Criptografia indisponível neste navegador.');
   const base=readBase();if(!base)throw Error('Defina primeiro a base inicial, após carregar o mesmo backup nos três computadores.');
   const now=normalized(), changes=diff(base,now);
   if(!changes.length){status('Nenhuma alteração nova desde a última exportação.');return}
   if(changes.some(c=>absent(c.value)))throw Error('Há exclusões no conjunto de alterações; faça revisão e use backup completo. A exportação incremental bloqueia exclusões por segurança.');
   const pass=prompt('Crie uma senha forte para proteger este pacote. Informe-a ao destinatário por outro meio seguro:');
   if(!pass)return;if(pass.length<12)throw Error('Use uma senha com pelo menos 12 caracteres.');
   if(prompt('Confirme a senha de criptografia do pacote:')!==pass)throw Error('As senhas não conferem.');
   const pkg={format:'v24-delta',version:1,id:id(),origin:device(),generatedAt:new Date().toISOString(),changes};
   const secure=await seal(pkg,pass);
   const nomeArquivo='V24_ATUALIZACOES_'+new Date().toISOString().slice(0,10)+'_'+pkg.id.slice(0,8)+'.json';
   const localDestino=await guardarPacoteExportacao(secure,nomeArquivo);
   writeBase(now);
   status('✓ Pacote criptografado exportado ('+changes.length+' alterações) para '+localDestino+'. Envie como documento. Não restaure como backup completo.');
  }catch(err){status('✕ '+err.message,true);alert('Exportação não concluída: '+err.message)}
 }
 async function importUpdates(file){
  try{
   if(!crypto.subtle)throw Error('Criptografia indisponível.');
   const wrapper=JSON.parse(await file.text());
   const pass=prompt('Digite a senha deste pacote de atualizações:');if(!pass)return;
   const pkg=await unseal(wrapper,pass);
   if(pkg.format!=='v24-delta'||pkg.version!==1||!pkg.id||!Array.isArray(pkg.changes)||pkg.changes.length>20000)throw Error('Conteúdo incompatível ou inválido.');
   if(readSeen().includes(pkg.id)){status('Este pacote já foi importado. Nenhum registro duplicado.');return}
   if(pkg.origin===device())throw Error('Este pacote foi gerado neste computador.');
   const current=normalized(), next=clone(current), conflicts=[],accepted=[];
   for(const c of pkg.changes){
    if(!c||!Array.isArray(c.path)||!c.path.length||c.path.length>12||c.path.some(k=>typeof k!=='string'||k.length>180||k==='__proto__'||k==='constructor'||k==='prototype')||!['rooms','controleEntradaSaida','medicamentos','employees','equipesAbas','selectPlantao','dataInicioPlantao','dataInicioPlantaoAnterior','plantonistasAnterior'].includes(c.path[0]))throw Error('Arquivo contém alteração não autorizada.');
    if(absent(c.value)){conflicts.push(esc(c.path)+' (exclusão requer revisão)');continue}
    const existing=pick(next,c.path);
    if(eq(existing,c.value))continue;
    if(!eq(existing,c.old)){conflicts.push(esc(c.path));continue}
    accepted.push(c);
    assign(next,c.path,c.value);
   }
   if(conflicts.length){
    status('⚠️ Importação BLOQUEADA: '+conflicts.length+' conflito(s). Nenhum dado foi alterado. Confira a lista.',true);
    alert('Importação cancelada para proteger dados locais. Conflitos:\n'+conflicts.slice(0,18).join('\n')+(conflicts.length>18?'\n...':'')+'\n\nCompare os registros manualmente. Não restaure o pacote como backup.');
    return;
   }
   if(!confirm('Pacote verificado: '+accepted.length+' alterações novas.\nOrigem: '+String(pkg.origin).slice(0,12)+'\nGerado em: '+pkg.generatedAt+'\n\nAplicar alterações? Recomenda-se fazer um backup completo antes.'))return;
   // Atomicidade em memória: nenhuma modificação no state antes da confirmação.
   const formerBase=readBase(), formerSeen=readSeen();
   try{
    snapshotAntes();
    state=normalizarEstado(next);
    salvarNoStorage();
    const baseline=formerBase?clone(formerBase):clone(current);
    for(const c of accepted){if(eq(pick(baseline,c.path),c.old))assign(baseline,c.path,c.value)}
    writeBase(baseline);
    localStorage.setItem(LEDGER,JSON.stringify([...formerSeen,pkg.id].slice(-1000)));
    render();window.__atualizarModuloMedicamentos?.();
    status('✓ '+accepted.length+' alterações aplicadas com segurança; pacote marcado como recebido.');
   }catch(err){state=current;salvarNoStorage();if(formerBase)writeBase(formerBase);else localStorage.removeItem(KEY);localStorage.setItem(LEDGER,JSON.stringify(formerSeen));render();throw err}
  }catch(err){status('✕ Não foi possível importar: '+err.message,true);alert('Falha de importação: '+err.message)}
 }
 // O modelo é local ao navegador, sem envio de informações dos acolhidos.
 const MODELO_WA_KEY='v24_whatsapp_link_modelo_v1';
 const MODELO_WA_PADRAO='https://wa.me/{numero}?text={mensagem}';
 const campoModeloWA=el('v24SyncWhatsAppModelo');
 const numeroWA=el('v24SyncWhatsAppNumero');
 let modeloWASalvo=MODELO_WA_PADRAO;
 try{modeloWASalvo=localStorage.getItem(MODELO_WA_KEY)||MODELO_WA_PADRAO}catch(_){}
 if(campoModeloWA)campoModeloWA.value=modeloWASalvo;
 const mensagemWA='Olá! Vou enviar o pacote de atualizações criptografado do Sistema de Controle de Acolhimento V24. Anexarei o arquivo .json como documento. A senha será informada por outro meio seguro.';
 function numeroWhatsappValidado(obrigatorio){
  const digits=String(numeroWA?.value||'').replace(/\\D/g,'');
  if(!digits&&!obrigatorio)return '';
  const telefone=digits.startsWith('55')?digits:'55'+digits;
  if(!/^55[1-9][0-9]{9,10}$/.test(telefone))throw Error('Informe um número de WhatsApp válido, com DDD.');
  return telefone;
 }
 function gerarLinkWhatsapp(modelo){
  const bruto=String(modelo||'').trim();
  if(!bruto)throw Error('Informe o link modelo do WhatsApp.');
  const telefone=bruto.includes('{numero}')?numeroWhatsappValidado(true):'';
  const link=bruto.replaceAll('{numero}',telefone).replaceAll('{mensagem}',encodeURIComponent(mensagemWA));
  let url;
  try{url=new URL(link)}catch(_){throw Error('Informe um endereço HTTPS válido do WhatsApp.')}
  if(url.protocol!=='https:'||!['wa.me','api.whatsapp.com','web.whatsapp.com'].includes(url.hostname)||
    url.username||url.password||url.port||link.includes('{')||link.includes('}')){
    throw Error('Utilize somente um link HTTPS oficial do WhatsApp.');
  }
  return url.href;
 }
 function salvarModeloWhatsapp(){
  const novo=String(campoModeloWA?.value||'').trim();
  try{
   gerarLinkWhatsapp(novo);
   localStorage.setItem(MODELO_WA_KEY,novo);
   modeloWASalvo=novo;
   status('✓ Link do WhatsApp salvo neste navegador.');
   return true;
  }catch(err){status('✕ '+err.message,true);campoModeloWA?.focus();return false}
 }
 function abrirLinkWhatsapp(modelo){
  try{
   const link=gerarLinkWhatsapp(modelo);
   const janela=window.open(link,'_blank','noopener,noreferrer');
   if(!janela){const a=document.createElement('a');a.href=link;a.target='_blank';a.rel='noopener noreferrer';a.click()}
   status('Conversa do WhatsApp aberta. Anexe o pacote .json criptografado como Documento; o link não inclui anexos.');
  }catch(err){status('✕ '+err.message,true);(String(modelo||'').includes('{numero}')?numeroWA:campoModeloWA)?.focus()}
 }
 el('v24SyncWhatsAppSalvarModelo')?.addEventListener('click',salvarModeloWhatsapp);
 el('v24SyncWhatsAppAbrirModelo')?.addEventListener('click',()=>abrirLinkWhatsapp(campoModeloWA?.value));
 // Compartilhar utiliza o modelo salvo; modelos com telefone fixo não exigem o campo de DDD.
 el('v24SyncWhatsApp')?.addEventListener('click',()=>abrirLinkWhatsapp(modeloWASalvo));
 el('v24SyncChooseFolder')?.addEventListener('click',escolherPastaSync);
 atualizarPastaSync();
 el('v24SyncExport')?.addEventListener('click',exportUpdates);
 const arquivoSync=el('v24SyncFile');
 const areaSync=el('v24SyncDropzone');
 let importandoSync=false, arrastosSync=0;
 async function receberArquivoSync(file){
  if(importandoSync)return status('Aguarde a conclusão da importação atual.',true);
  if(!file)return;
  if(!/\.json$/i.test(file.name||''))return status('✕ Selecione um arquivo .json de atualizações criptografadas.',true);
  // Limite preventivo: evita carregar inadvertidamente arquivos enormes em memória.
  if(file.size>40*1024*1024)return status('✕ Arquivo acima de 40 MB. Verifique se é o pacote de atualizações correto.',true);
  if(file.size===0)return status('✕ Arquivo vazio. Escolha um pacote válido.',true);
  importandoSync=true;
  areaSync?.classList.add('v24-sync-processando');
  try{await importUpdates(file)}finally{importandoSync=false;areaSync?.classList.remove('v24-sync-processando')}
 }
 el('v24SyncImport')?.addEventListener('click',()=>arquivoSync?.click());
 arquivoSync?.addEventListener('change',async e=>{
  const f=e.target.files?.[0];e.target.value='';await receberArquivoSync(f);
 });
 if(areaSync){
  areaSync.addEventListener('click',()=>{if(!importandoSync)arquivoSync?.click()});
  areaSync.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!importandoSync)arquivoSync?.click()}});
  areaSync.addEventListener('dragenter',e=>{e.preventDefault();e.stopPropagation();arrastosSync++;areaSync.classList.add('v24-sync-arrastando')});
  areaSync.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';areaSync.classList.add('v24-sync-arrastando')});
  areaSync.addEventListener('dragleave',e=>{e.preventDefault();e.stopPropagation();arrastosSync=Math.max(0,arrastosSync-1);if(!arrastosSync)areaSync.classList.remove('v24-sync-arrastando')});
  areaSync.addEventListener('drop',async e=>{
   e.preventDefault();e.stopPropagation();arrastosSync=0;areaSync.classList.remove('v24-sync-arrastando');
   const files=e.dataTransfer?.files;
   if(!files?.length)return;
   if(files.length!==1)return status('✕ Solte apenas um pacote de atualizações por vez.',true);
   await receberArquivoSync(files[0]);
  });
 }

 el('v24SyncReset')?.addEventListener('click',()=>{
  if(!state?.rooms){status('Faça login primeiro.',true);return}
  if(!confirm('Definir os dados atuais como base inicial deste computador? Faça isso APENAS depois de carregar o mesmo backup inicial nos três computadores. Alterações anteriores não serão exportadas.'))return;
  writeBase(normalized());localStorage.setItem(LEDGER,'[]');status('✓ Base inicial redefinida. Agora as próximas mudanças poderão ser exportadas.');
 });
 prepareBase();
})();
