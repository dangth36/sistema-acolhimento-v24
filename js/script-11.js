
/* Cofre offline: dados AES-GCM; chave de dados protegida individualmente por PBKDF2.
   O armazenamento legado é excluído somente após confirmação da cópia e teste da cifra. */
(()=>{'use strict';
 const VAULT='acolhimento_cofre_contas_v1', DATA='acolhimento_cofre_dados_v1';
 const nativeGet=Storage.prototype.getItem,nativeSet=Storage.prototype.setItem,nativeRemove=Storage.prototype.removeItem;
 const nativeKey=Storage.prototype.key;
 const $=id=>document.getElementById(id), tela=$('abdCofreTela');
 const utf8=new TextEncoder(), decode=new TextDecoder();
 const isAppKey=k=>/^(sistema_plantao|frei_damiao|acolhimento_)/.test(String(k))&&k!==VAULT&&k!==DATA;
 // Base64 em blocos: um ArrayBuffer grande não pode virar argumentos de uma única chamada.
 const bytesToB64=u=>{let binary='';const bloco=8192;for(let i=0;i<u.length;i+=bloco)binary+=String.fromCharCode(...u.subarray(i,i+bloco));return btoa(binary)};
 const b64ToBytes=s=>Uint8Array.from(atob(s),x=>x.charCodeAt(0));
 const random=n=>crypto.getRandomValues(new Uint8Array(n));
 const error=msg=>{$('abdCofreErro').textContent=msg||''};
 const listRaw=()=>{const out={};for(let i=0;i<localStorage.length;i++){const k=nativeKey.call(localStorage,i);if(isAppKey(k)){const val=nativeGet.call(localStorage,k);if(val!==null)out[k]=val;}}return out;};
 const meta=()=>{try{return JSON.parse(nativeGet.call(localStorage,VAULT)||'null')}catch{return null}};
 const title=(t,d)=>{$('abdCofreTitulo').textContent=t;$('abdCofreDescricao').textContent=d;$('abdCofreFormulario').replaceChildren();$('abdCofreAcoes').replaceChildren();error('')};
 const labelInput=(nome,type='text',minLength=0)=>{const label=document.createElement('label');label.textContent=nome;const input=document.createElement('input');input.type=type;if(minLength)input.minLength=minLength;input.required=true;label.appendChild(input);$('abdCofreFormulario').appendChild(label);return input};
 const button=(txt,click,klass='')=>{const b=document.createElement('button');b.type='button';b.textContent=txt;if(klass)b.className=klass;b.addEventListener('click',click);$('abdCofreAcoes').appendChild(b);return b};
 async function passKey(password,salt){const base=await crypto.subtle.importKey('raw',utf8.encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:310000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
 async function seal(key,data){const iv=random(12);const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,utf8.encode(JSON.stringify(data)));return {iv:bytesToB64(iv),cipher:bytesToB64(new Uint8Array(cipher))};}
 async function unseal(key,data){const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(data.iv)},key,b64ToBytes(data.cipher));return JSON.parse(decode.decode(raw));}
 async function wrap(rawKey,password){const salt=random(16),k=await passKey(password,salt),enc=await seal(k,{key:bytesToB64(rawKey)});return {salt:bytesToB64(salt),iv:enc.iv,cipher:enc.cipher};}
 async function unwrap(record,password){const k=await passKey(password,b64ToBytes(record.salt));const decoded=await unseal(k,record);return b64ToBytes(decoded.key);}
 const dataKey=raw=>crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt','decrypt']);
 let current=null,rawMaster=null,sharedKey=null,memory={},dirty=false,writing=false,started=false,appStart=null;
 // A checagem usa a sessão criptográfica já autenticada, não a senha antiga do modo admin.
 Object.defineProperty(window,'__contaAdminAutenticada',{configurable:false,enumerable:false,get:()=>()=>!!current&&current.role==='admin'});
 let saveDelay=0;
 function guardPassword(p){if(p.length<4)throw Error('Use uma senha com pelo menos 4 caracteres.');}
 async function writeEncrypted(){
  if(writing||!dirty||!sharedKey)return;
  writing=true;
  try{
   while(dirty){dirty=false;const snapshot=JSON.stringify(memory);const encrypted=await seal(sharedKey,JSON.parse(snapshot));nativeSet.call(localStorage,DATA,JSON.stringify(encrypted));}
  }catch(e){dirty=true;error('Falha ao gravar os dados criptografados: '+e.message);alert('Atenção: não foi possível salvar a última alteração criptografada. Não feche esta página.');}
  finally{writing=false;}
 }
 function scheduleSave(){dirty=true;clearTimeout(saveDelay);saveDelay=setTimeout(writeEncrypted,0)}
 function installStorageBridge(){
  if(Storage.prototype.__abdCofreAtivo)return;
  Object.defineProperty(Storage.prototype,'__abdCofreAtivo',{value:true});
  Storage.prototype.getItem=function(key){if(this===localStorage&&isAppKey(key))return Object.prototype.hasOwnProperty.call(memory,key)?memory[key]:null;return nativeGet.call(this,key)};
  Storage.prototype.setItem=function(key,value){if(this===localStorage&&isAppKey(key)){memory[String(key)]=String(value);scheduleSave();return;}return nativeSet.call(this,key,value)};
  Storage.prototype.removeItem=function(key){if(this===localStorage&&isAppKey(key)){delete memory[String(key)];scheduleSave();return;}return nativeRemove.call(this,key)};
 }
 function backupLegacy(){const plain=listRaw();const blob=new Blob([JSON.stringify({tipo:'backup-de-seguranca-pre-criptografia',data:new Date().toISOString(),registros:plain},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ACOLHIMENTO_BACKUP_ANTES_DA_CRIPTOGRAFIA_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),6000);return Object.keys(plain).length;}
 let backupFeito=false;
 function showSetup(){
  title('🔐 Criar Administrador Principal','Primeiro acesso: crie a conta que cadastrará todos os operadores. A senha não poderá ser recuperada sem outra conta autorizada.');
  const username=labelInput('Nome de usuário do administrador');username.value='admin';
  const pw=labelInput('Senha inicial do administrador (mínimo 4 caracteres)','password',4);pw.value='albergue2026';
  const confirm=labelInput('Confirmar senha inicial','password',4);confirm.value='albergue2026';
  const plain=listRaw();const legacy=Object.keys(plain).length>0;
  if(legacy){const info=document.createElement('p');info.textContent='Foram encontrados dados antigos sem criptografia. Baixe e guarde o backup antes de migrar. Esse arquivo de backup NÃO é criptografado.';$('abdCofreFormulario').appendChild(info);button('⬇ Baixar backup dos dados atuais',()=>{backupLegacy();backupFeito=true;error('Backup solicitado. Confira o arquivo na pasta de downloads antes de continuar.')},'secundario')}
  button('Criar administrador e criptografar',async()=>{
   try{
    const name=username.value.trim(),password=pw.value;if(!name)throw Error('Informe o nome do administrador.');guardPassword(password);if(password!==confirm.value)throw Error('As senhas não coincidem.');if(legacy&&!backupFeito)throw Error('Baixe o backup antes de migrar os dados existentes.');
    error('Criptografando e verificando os dados...');const raw=random(32),key=await dataKey(raw),wrapped=await wrap(raw,password);
    const bundle=await seal(key,plain);const check=await unseal(key,bundle);if(JSON.stringify(check)!==JSON.stringify(plain))throw Error('A verificação da migração falhou. Os dados originais foram mantidos.');
    nativeSet.call(localStorage,DATA,JSON.stringify(bundle));
    // Teste de leitura do que foi efetivamente gravado antes de remover os legados.
    const stored=await unseal(key,JSON.parse(nativeGet.call(localStorage,DATA)));
    if(JSON.stringify(stored)!==JSON.stringify(plain))throw Error('Falha na conferência do armazenamento.');
    const admin={id:crypto.randomUUID(),name,role:'admin',active:true,mustChange:true,...wrapped};
    nativeSet.call(localStorage,VAULT,JSON.stringify({v:1,users:[admin]}));
    for(const k of Object.keys(plain))nativeRemove.call(localStorage,k);
    await startSession(admin,raw,stored);
   }catch(e){error(e.message||'Falha ao configurar o acesso seguro.');}
  });
  button('Restaurar backup criptografado',showRestore,'secundario');
 }
 function showRestore(){
  title('📂 Restaurar backup criptografado','Selecione um backup criado por este sistema. A senha de um operador ativo será necessária para conferir os dados antes da restauração.');
  const file=document.createElement('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','Backup criptografado');$('abdCofreFormulario').appendChild(file);
  const name=labelInput('Nome de usuário do backup');const password=labelInput('Senha do usuário','password');
  button('Verificar e restaurar',async()=>{try{
   if(!file.files?.[0])throw Error('Selecione o arquivo de backup.');
   const obj=JSON.parse(await file.files[0].text());if(obj.type!=='acolhimento-cofre-encriptado-v1'||!obj.users?.users?.length||!obj.data?.cipher||!obj.data?.iv)throw Error('Formato de backup inválido.');
   const user=obj.users.users.find(u=>u.active&&u.name.toLowerCase()===name.value.trim().toLowerCase());if(!user)throw Error('Operador não encontrado no backup.');
   const raw=await unwrap(user,password.value),key=await dataKey(raw);const plain=await unseal(key,obj.data);
   if(!plain||typeof plain!=='object'||Array.isArray(plain))throw Error('O conteúdo do backup é inválido.');
   if(meta())throw Error('Já existe um cofre neste navegador. Por segurança, restaure o backup em uma instalação sem dados, evitando substituir o cofre atual.');
   nativeSet.call(localStorage,DATA,JSON.stringify(obj.data));nativeSet.call(localStorage,VAULT,JSON.stringify(obj.users));
   await startSession(user,raw,plain);
  }catch(e){error('Restauração não realizada: '+e.message)}});
  button('Voltar',()=>meta()?showLogin():showSetup(),'secundario');
 }
 function showLogin(){
  const vault=meta();if(!vault?.users?.length){showSetup();return;}
  title('🔐 Entrar - Sistema de Acolhimento','');
  const sel=document.createElement('select');sel.setAttribute('aria-label','Operador');
  vault.users.filter(u=>u.active).forEach(u=>sel.add(new Option(u.name,u.id)));
  const label=document.createElement('label');label.textContent='Operador';label.appendChild(sel);$('abdCofreFormulario').appendChild(label);
  const pw=labelInput('Senha','password');
  const entrarBtn=button('Entrar',async()=>{try{
   const u=vault.users.find(x=>x.id===sel.value&&x.active);if(!u)throw Error('Operador inválido.');
   entrarBtn.disabled=true;
   const raw=await unwrap(u,pw.value),key=await dataKey(raw);const encrypted=JSON.parse(nativeGet.call(localStorage,DATA)||'null');if(!encrypted)throw Error('Arquivo criptografado não encontrado.');
   const plain=await unseal(key,encrypted);await startSession(u,raw,plain);
  }catch(e){error('Não foi possível entrar: verifique o usuário, a senha e a integridade dos dados.');entrarBtn.disabled=false;}});
  pw.addEventListener('keydown',e=>{
   if(e.key!=='Enter'||e.isComposing)return;
   e.preventDefault();
   if(!entrarBtn.disabled)entrarBtn.click();
  });
  sel.addEventListener('keydown',e=>{
   if(e.key!=='Enter'||e.isComposing)return;
   e.preventDefault();
   if(pw.value&&!entrarBtn.disabled)entrarBtn.click();else pw.focus();
  });
  pw.focus();
  button('Restaurar backup criptografado',showRestore,'secundario');
 }
 function requireNewAdminPassword(user,raw,plain){
  title('🔑 Troca obrigatória da senha inicial','Para proteger os dados, substitua a senha inicial por uma senha particular antes de abrir o sistema.');
  const nova=labelInput('Nova senha (mínimo 4 caracteres)','password',4);
  const confirm=labelInput('Confirmar nova senha','password',4);
  button('Alterar senha e acessar',async()=>{try{
   guardPassword(nova.value);if(nova.value==='albergue2026')throw Error('A nova senha deve ser diferente da senha inicial.');
   if(nova.value!==confirm.value)throw Error('As senhas não coincidem.');
   const vault=meta(),conta=vault?.users?.find(x=>x.id===user.id);if(!conta)throw Error('Conta administrativa não encontrada.');
   Object.assign(conta,await wrap(raw,nova.value),{mustChange:false});
   nativeSet.call(localStorage,VAULT,JSON.stringify(vault));
   await startSession(conta,raw,plain);
  }catch(e){error(e.message||'Não foi possível alterar a senha.')}});
 }
 async function startSession(user,raw,plain){
  if(user.mustChange){requireNewAdminPassword(user,raw,plain);return;}
  current={id:user.id,name:user.name,role:user.role};rawMaster=raw;sharedKey=await dataKey(raw);memory={...plain};
  // Limpa restos de uma migração interrompida após a gravação autenticada.
  for(const k of Object.keys(listRaw()))nativeRemove.call(localStorage,k);
  installStorageBridge();tela.hidden=true;document.documentElement.classList.remove('abd-cofre-bloqueado');document.documentElement.classList.add('abd-cofre-desbloqueado');
  window.__operadorAtual=()=>current?.name||'Não autenticado';
  const legacyAuditBoot=window.__authBoot;
  window.__authBoot=()=>{if(typeof legacyAuditBoot==='function')legacyAuditBoot();const old=$('operadorModal');if(old){old.hidden=false;old.style.display='none'}const nome=$('operadorNomeExibido');if(nome)nome.textContent=current.name;const buttonOld=$('abrirEscolhaOperador');if(buttonOld)buttonOld.hidden=true;const adminOld=$('adminPrincipalBtn');if(adminOld)adminOld.hidden=current.role!=='admin';window.__definirAdminDaSessao?.(current.role==='admin')};
  if(!started){started=true;appStart();const old=$('operadorModal');if(old){old.hidden=false;old.style.display='none'};installToolbar();}
  else{window.__definirAdminDaSessao?.(current.role==='admin');}
 }
 function installToolbar(){
  const bar=document.createElement('div');bar.id='abdCofreBarra';
  const title=document.createElement('strong');title.textContent='🔐 '+current.name+' ('+(current.role==='admin'?'Administrador':'Operador')+')';bar.appendChild(title);
  const add=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);bar.appendChild(b);return b};
  add('Alterar minha senha',changeOwnPassword);
  if(current.role==='admin')add('Gerenciar operadores',manageUsers);
  add('Backup criptografado',()=>{const encrypted=nativeGet.call(localStorage,DATA);const users=nativeGet.call(localStorage,VAULT);if(dirty||writing||!encrypted||!users){alert('Aguarde a gravação criptografada terminar.');writeEncrypted();return;}const blob=new Blob([JSON.stringify({type:'acolhimento-cofre-encriptado-v1',users:JSON.parse(users),data:JSON.parse(encrypted)})],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ACOLHIMENTO_BACKUP_CRIPTOGRAFADO_'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),6000)});
  const sairCofre=add('Sair / Bloquear',()=>{if(dirty||writing){alert('Aguarde a conclusão da gravação criptografada.');writeEncrypted();return;}location.reload()});
  sairCofre.id='abdCofreSairBtn';
  const sairTopo=$('abdSairTopo');if(sairTopo)sairTopo.onclick=()=>sairCofre.click();
  ($('authToolbar')||document.body.firstElementChild)?.insertAdjacentElement('afterend',bar);
  let ultimaAtividade=Date.now();
  for(const evento of ['pointerdown','keydown','touchstart'])document.addEventListener(evento,()=>{ultimaAtividade=Date.now()},{passive:true});
  setInterval(()=>{if(current&&Date.now()-ultimaAtividade>=15*60*1000){if(dirty||writing){writeEncrypted();return;}location.reload()}},10000);
 }
 function showManage(t,d){tela.hidden=false;title(t,d);}
 function closeManage(){tela.hidden=true;error('')}
 function changeOwnPassword(){
  showManage('🔑 Alterar minha senha','A senha atual protege a chave que permite acessar os dados.');
  const old=labelInput('Senha atual','password'),newPw=labelInput('Nova senha (mínimo 4 caracteres)','password',4),confirm=labelInput('Confirmar nova senha','password',4);
  button('Salvar nova senha',async()=>{try{guardPassword(newPw.value);if(newPw.value!==confirm.value)throw Error('As novas senhas não coincidem.');const v=meta(),u=v.users.find(x=>x.id===current.id);await unwrap(u,old.value);Object.assign(u,await wrap(rawMaster,newPw.value));nativeSet.call(localStorage,VAULT,JSON.stringify(v));closeManage();alert('Senha alterada com sucesso.')}catch(e){error('Não foi possível alterar a senha: '+e.message)}});
  button('Cancelar',closeManage,'secundario');
 }
 function manageUsers(){
  if(current?.role!=='admin')return;
  showManage('👥 Gerenciar operadores','As contas são independentes da lista de funcionários. Novos operadores recebem senha individual.');
  const list=document.createElement('div');list.id='abdCofreContas';$('abdCofreFormulario').appendChild(list);
  function refresh(){list.replaceChildren();const v=meta();v.users.forEach(u=>{const item=document.createElement('div');item.className='abd-cofre-conta';const span=document.createElement('span');span.textContent=u.name+' — '+(u.role==='admin'?'Administrador':'Operador')+(u.active?'':' (desativado)');item.appendChild(span);if(u.id!==current.id){
   const reset=document.createElement('button');reset.textContent='Redefinir senha';reset.onclick=async()=>{const nova=prompt('Nova senha para '+u.name+' (mínimo 4 caracteres):');if(nova===null)return;try{guardPassword(nova);const latest=meta(),target=latest.users.find(x=>x.id===u.id);Object.assign(target,await wrap(rawMaster,nova));nativeSet.call(localStorage,VAULT,JSON.stringify(latest));alert('Senha redefinida. A senha anterior não funcionará mais.')}catch(e){error(e.message)}};item.appendChild(reset);
   const btn=document.createElement('button');btn.textContent=u.active?'Desativar':'Ativar';btn.onclick=()=>{const latest=meta(),target=latest.users.find(x=>x.id===u.id);target.active=!target.active;nativeSet.call(localStorage,VAULT,JSON.stringify(latest));refresh()};item.appendChild(btn)}list.appendChild(item)})}
  refresh();const name=labelInput('Nome do novo operador');const pw=labelInput('Senha inicial (mínimo 4 caracteres)','password',4);
  button('Cadastrar operador',async()=>{try{const v=meta(),n=name.value.trim();if(!n)throw Error('Informe o nome do operador.');guardPassword(pw.value);if(v.users.some(u=>u.name.toLowerCase()===n.toLowerCase()))throw Error('Esse nome já está cadastrado.');v.users.push({id:crypto.randomUUID(),name:n,role:'operador',active:true,...await wrap(rawMaster,pw.value)});nativeSet.call(localStorage,VAULT,JSON.stringify(v));name.value='';pw.value='';error('Operador cadastrado.');refresh()}catch(e){error(e.message)}});
  button('Fechar',closeManage,'secundario');
 }
 window.__secureStart=callback=>{appStart=callback;if(!crypto?.subtle){title('Acesso seguro indisponível','Este navegador não fornece Web Crypto neste contexto. Abra o sistema em um ambiente local confiável com suporte a crypto.subtle. Os dados não foram carregados.');return;}if(meta())showLogin();else showSetup();};
 document.documentElement.classList.add('abd-cofre-bloqueado');
 window.addEventListener('beforeunload',event=>{if(dirty||writing){event.preventDefault();event.returnValue='Há alterações ainda sendo criptografadas.'}});
})();
