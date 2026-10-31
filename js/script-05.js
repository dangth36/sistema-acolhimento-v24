
(function(){'use strict';
const AK='frei_damiao_auditoria_v1', OP='frei_damiao_operador_atual_v1';
let adminAtivo=false;
// Privilégios administrativos dependem primeiro da conta autenticada no cofre.
// Conhecer a senha administrativa não converte uma sessão de operador em administrador.
const sessaoAdministradorAutorizada=()=>window.__contaAdminAutenticada?.()===true;
window.__adminPrincipalAtivo=()=>adminAtivo && sessaoAdministradorAutorizada();
window.__definirAdminDaSessao=ativo=>{adminAtivo=!!ativo && sessaoAdministradorAutorizada();atualizarIndicadorAdmin();};
const $=id=>document.getElementById(id);
const audits=()=>{try{return JSON.parse(localStorage.getItem(AK)||'[]')}catch{return []}};
let baseline='',lastHist='',lastAuditKey='',nomeOperador='';
function plantonistas(){
 try{
  const dados=(typeof state!=='undefined'&&state&&state.employees)?state:JSON.parse(localStorage.getItem('sistema_plantao_dados_v2')||'null');
  let lista=(dados?.employees?.plantonistas||[]).map(p=>String(p.nome||'').trim()).filter(Boolean);
  // Durante a criação de um novo plantão vazio, permitir que o operador já
  // cadastrado em outro plantão continue trabalhando e cadastre a nova equipe.
  // Assim a janela de identificação não bloqueia o botão "Adicionar Plantonista".
  if(!lista.length){
   for(const aba of dados?.equipesAbas?.plantonistas?.abas||[]){
    lista.push(...(aba.funcionarios||[]).map(p=>String(p.nome||'').trim()).filter(Boolean));
   }
  }
  return [...new Set(lista)].sort((a,b)=>a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
 }catch{return []}
}
function atualizarLista(){
 const select=$('operadorPlantonistaSelect');if(!select)return;
 const nomes=plantonistas(),assinatura=JSON.stringify(nomes);
 if(select.dataset.lista===assinatura)return;
 const anterior=select.value;
 select.dataset.lista=assinatura;
 select.replaceChildren(new Option('— Selecione o plantonista —',''));
 nomes.forEach(n=>select.add(new Option(n,n)));
 // O operador confirmado nunca é substituído silenciosamente por uma mudança de aba.
 // Se não pertence ao plantão atual, solicitar confirmação antes de novas alterações.
 const escolha=nomes.includes(anterior)?anterior:(nomes.includes(nomeOperador)?nomeOperador:'');
 select.value=escolha;
 if(nomeOperador&&!nomes.includes(nomeOperador)&&$('operadorModal').hidden){
  abrirModalOperador(false);
 }
}
window.atualizarListaOperador=atualizarLista;
$('operadorPlantonistaSelect').addEventListener('change',()=>{$('operadorModalErro').hidden=true;});
const LIMITE_INATIVIDADE_OPERADOR=15*60*1000;
let ultimaAtividadeOperador=Date.now();
let solicitacaoPorInatividade=false;
function abrirModalOperador(porInatividade=false){
 atualizarLista();
 solicitacaoPorInatividade=porInatividade;
 const titulo=$('operadorModalTitulo');
 const descricao=$('operadorModal').querySelector('.operador-modal-painel p');
 titulo.textContent=porInatividade?'👤 Confirme quem está operando':'👤 Quem está operando neste momento?';
 descricao.textContent=porInatividade?'Após 15 minutos sem atividade, confirme o plantonista responsável para continuar utilizando o sistema.':'Selecione seu nome na lista dos plantonistas do dia para identificar os registros realizados.';
 $('operadorModalErro').hidden=true;
 adminAtivo=false;atualizarIndicadorAdmin();
 $('operadorModal').hidden=false;
 $('operadorPlantonistaSelect').focus();
}
function registrarAtividadeOperador(){
 if(!$('operadorModal').hidden)return;
 ultimaAtividadeOperador=Date.now();
}
['pointerdown','keydown','touchstart','wheel'].forEach(tipo=>document.addEventListener(tipo,registrarAtividadeOperador,{passive:true}));
setInterval(()=>{
 if($('operadorModal').hidden&&Date.now()-ultimaAtividadeOperador>=LIMITE_INATIVIDADE_OPERADOR){
  abrirModalOperador(true);
 }
},10000);
function confirmarOperador(){const nome=$('operadorPlantonistaSelect').value;if(!nome||!plantonistas().includes(nome)){$('operadorModalErro').hidden=false;atualizarLista();return;}const anterior=nomeOperador;nomeOperador=nome;localStorage.setItem(OP,nome);$('operadorNomeExibido').textContent=nome;$('operadorModal').hidden=true;solicitacaoPorInatividade=false;ultimaAtividadeOperador=Date.now();}
$('confirmarEscolhaOperador').addEventListener('click',confirmarOperador);
$('abrirEscolhaOperador').addEventListener('click',()=>abrirModalOperador(false));
$('operadorPlantonistaSelect').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();confirmarOperador();}});

window.__operadorAtual=()=>nomeOperador||'Operador não identificado';
function addAudit(entry){
 let a=audits();a.push({id:crypto?.randomUUID?.()||String(Date.now())+'-'+Math.random(),at:new Date().toISOString(),user:window.__operadorAtual(),role:'plantonista',...entry});
 if(a.length>10000)a=a.slice(-10000);
 try{localStorage.setItem(AK,JSON.stringify(a))}catch(err){console.error('Auditoria não gravada:',err)}
}
window.__auditarOcorrenciaChave=entry=>addAudit(entry);
window.__lerAuditoriaOcorrenciaChave=(id)=>audits().filter(x=>String(x.personId||'')===String(id)&&(/chave/i.test(String(x.field||'')))).slice(-300).reverse();
window.__registrarExclusaoPassagem=function(p){addAudit({field:'exclusão individual de passagem',personId:String(p.id||''),personName:String(p.nome||''),quarto:String(p.quarto||''),previous:JSON.stringify({entrada:p.entrada||'',saida:p.saida||'',quarto:p.quarto||''}),next:'passagem excluída',origin:'administrador principal'});};
function capture(){try{baseline=JSON.stringify(state);lastHist=JSON.stringify(typeof acolhimentosHistorico==='undefined'?[]:acolhimentosHistorico)}catch{}}
function indexPeople(s){let out=new Map();for(const room of Object.values(s?.rooms||{}))for(const p of room.pessoas||[]){if(!p?.id)continue;out.set(String(p.id),{...p,quarto:room.numero});}return out;}
// Auditoria enxuta: registra apenas alterações efetivas e relevantes do acolhimento.
// A data/hora e o plantonista são acrescentados por addAudit no momento do salvamento.
const CAMPOS_AUDITADOS={
 entrada:'data de entrada',saida:'desligamento / data de saída',
 observacao:'observação',observacaoControle:'observação de controle',
 advertencia:'advertências',advertenciasMotivos:'motivo da advertência',
 quarto:'transferência de quarto'
};
function textoAuditado(v){
 if(v===undefined||v===null||v==='')return '—';
 if(typeof v==='object')return JSON.stringify(v);
 return String(v);
}
function registrarMudancaPessoa(a,b,campo,pessoa,origem){
 const anterior=a?.[campo],atual=b?.[campo];
 if(JSON.stringify(anterior)===JSON.stringify(atual))return;
 let descricao=CAMPOS_AUDITADOS[campo];
 if(!descricao){
  // Outros dados de identificação: registrar somente uma inclusão, exclusão ou edição posterior.
  const secundarios=['nome','cpf','identidade','cartaoSus','nascimento','genero','origemNacionalidade','responsavel','responsavelId','acessibilidade','necessidadeAcessibilidade'];
  if(!secundarios.includes(campo))return;
  descricao='informação: '+campo;
 }
 // Quando o motivo muda junto à quantidade de advertências, um único registro detalhado basta.
 if(campo==='advertencia'&&JSON.stringify(a?.advertenciasMotivos)!==JSON.stringify(b?.advertenciasMotivos))return;
 if(campo==='advertenciasMotivos'){
  // Registrar somente a diferença, nunca o JSON completo dos motivos.
  descricao='advertência';
  const antes=Number(a?.advertencia)||0,depois=Number(b?.advertencia)||0;
  const antigos=Array.isArray(anterior)?anterior:[];
  const novos=Array.isArray(atual)?atual:[];
  const mudaram=novos.length>antigos.length?novos.slice(antigos.length):
   (novos.length<antigos.length?antigos.slice(novos.length):
    novos.filter((m,i)=>JSON.stringify(m)!==JSON.stringify(antigos[i])));
  const textoMotivos=mudaram.map(m=>{
   const motivo=typeof m==='object'&&m!==null?m.motivo:m;
   return '"'+String(motivo||'Não informado').replace(/\s+/g,' ').trim().replace(/"/g,'\\"')+'"';
  }).join(', ');
  const dataMotivo=mudaram.find(m=>m&&typeof m==='object'&&m.data)?.data;
  const dt=dataMotivo?new Date(dataMotivo):new Date();
  const dataFormatada=Number.isNaN(dt.getTime())?'—':
   dt.toLocaleDateString('pt-BR')+' às '+String(dt.getHours()).padStart(2,'0')+'h'+String(dt.getMinutes()).padStart(2,'0')+'m';
  const acao=depois<antes?'motivo removido':'motivo';
  const detalhe=textoMotivos?'; '+acao+': '+textoMotivos:'';
  addAudit({personId:String(pessoa.id),personName:String(pessoa.nome||''),quarto:String(pessoa.quarto||''),field:descricao,
   previous:String(antes),next:String(depois)+detalhe+'; data: '+dataFormatada,origin:origem});
  return;
 }
 addAudit({personId:String(pessoa.id),personName:String(pessoa.nome||''),quarto:String(pessoa.quarto||''),field:descricao,
  previous:textoAuditado(anterior),next:textoAuditado(atual),origin:origem});
}
function diff(oldObj,newObj){
 const before=indexPeople(oldObj),after=indexPeople(newObj);
 for(const id of new Set([...before.keys(),...after.keys()])){
  const a=before.get(id),b=after.get(id),p=b||a;
  if(!p)continue;
  const tinhaAcolhimento=Boolean(String(a?.nome||'').trim()&&String(a?.entrada||'').trim());
  const temAcolhimento=Boolean(String(b?.nome||'').trim()&&String(b?.entrada||'').trim());
  // Uma única linha na primeira conclusão do cadastro, independentemente do número de campos preenchidos.
  if(!tinhaAcolhimento&&temAcolhimento){
   addAudit({personId:id,personName:String(b.nome||''),quarto:String(b.quarto||''),field:'acolhimento realizado',
    previous:'—',next:'Entrada: '+textoAuditado(b.entrada)+'; plantonista responsável: '+window.__operadorAtual(),origin:'acolhimento'});
   continue;
  }
  // Campos preenchidos durante a preparação inicial não geram auditoria antes da entrada.
  if(!tinhaAcolhimento&&!temAcolhimento)continue;
  if(a&&!b){
   addAudit({personId:id,personName:String(a.nome||''),quarto:String(a.quarto||''),field:'registro de acolhimento removido',previous:'Existente',next:'Removido',origin:'cadastro'});
   continue;
  }
  if(!a||!b)continue;
  // Uma transferência gera uma entrada, sem registro de exclusão/inclusão da pessoa.
  if(a.quarto!==b.quarto)registrarMudancaPessoa(a,b,'quarto',b,'transferência');
  for(const campo of Object.keys(CAMPOS_AUDITADOS)){
   if(campo==='quarto')continue;
   registrarMudancaPessoa(a,b,campo,b,'cadastro');
  }
  for(const campo of ['nome','cpf','identidade','cartaoSus','nascimento','genero','origemNacionalidade','responsavel','responsavelId','acessibilidade','necessidadeAcessibilidade']){
   registrarMudancaPessoa(a,b,campo,b,'cadastro');
  }
 }
}
window.__auditCommit=function(){
 try{
  const now=JSON.stringify(state);
  const hist=JSON.stringify(typeof acolhimentosHistorico==='undefined'?[]:acolhimentosHistorico);
  if(!baseline){baseline=now;lastHist=hist;return;}
  if(now!==baseline){diff(JSON.parse(baseline),state);baseline=now;}
  // Registros de passagens são espelhos do acolhimento/desligamento.
  // Não auditar a sincronização automática do histórico em duplicidade.
  // A exclusão manual de uma passagem é auditada separadamente por __registrarExclusaoPassagem.
  lastHist=hist;
 }catch(e){console.error('Erro na auditoria de alterações efetivas',e)}
};
// Formatação exclusivamente visual das datas na auditoria (dados armazenados intactos).
function formatarDatasAuditoria(valor){
 return String(valor??'').replace(/(^|[^0-9])(\d{4})-(\d{2})-(\d{2})(?=$|[^0-9])/g,
  (_,inicio,ano,mes,dia)=>inicio+dia+'/'+mes+'/'+ano);
}
function renderAudit(){const adminAcoes=$('authAuditAdminActions');if(adminAcoes)adminAcoes.hidden=!adminAtivo||!lastAuditKey;const filter=$('authAuditFilter').value.toLowerCase(),box=$('authAuditList');box.replaceChildren();const entries=audits().filter(x=>(!lastAuditKey||String(x.personId||'')===lastAuditKey)&&((x.personName||'')+' '+(x.quarto||'')+' '+(x.field||'')+' '+(x.user||'')).toLowerCase().includes(filter)).slice(-400).reverse();for(const x of entries){const div=document.createElement('div');div.className='authAuditRow';div.textContent=new Date(x.at).toLocaleString('pt-BR')+' | '+x.user+' | '+(x.personName||'Sistema')+' | Quarto '+(x.quarto||'—')+' | '+x.field+' | '+formatarDatasAuditoria(x.previous||'—')+' → '+formatarDatasAuditoria(x.next||'—');box.append(div)}if(!entries.length)box.textContent='Nenhum registro encontrado.'}
$('authAuditBtn').onclick=()=>{lastAuditKey='';$('authAuditFilter').value='';renderAudit();$('authAuditDialog').showModal()};$('authAuditFilter').oninput=renderAudit;
document.addEventListener('click',e=>{const btn=e.target.closest('.btn-auditoria-pessoa');if(!btn)return;e.preventDefault();e.stopPropagation();const row=btn.closest('[data-pessoa-id]');lastAuditKey=row?.dataset.pessoaId||'';$('authAuditFilter').value='';renderAudit();$('authAuditDialog').showModal();});
// Administrador Principal: senha criada na primeira utilização e verificada localmente.
const ADMIN_KEY='frei_damiao_admin_principal_v1';
const adminDlg=$('adminPrincipalDialog');
const adminErr=$('adminPrincipalErro');
const adminInput=$('adminPrincipalSenha');
function atualizarIndicadorAdmin(){
 const permitido=sessaoAdministradorAutorizada();
 if(!permitido)adminAtivo=false;
 const btnAdminTopo=$('adminPrincipalBtn');
 if(btnAdminTopo){
  btnAdminTopo.hidden=!permitido;
  btnAdminTopo.disabled=!permitido;
  btnAdminTopo.style.display=permitido?'':'none';
  btnAdminTopo.textContent=adminAtivo?'🔓':'🔐';
  btnAdminTopo.title=permitido?(adminAtivo?'Administrador Principal (ativo)':'Administrador Principal'):'Acesso exclusivo da conta Administrador';
  btnAdminTopo.setAttribute('aria-label',btnAdminTopo.title);
 }
 document.querySelectorAll('.btn-excluir-historico').forEach(btn=>{btn.hidden=!window.__adminPrincipalAtivo();});
}

function adminAviso(msg){adminErr.textContent=msg;adminErr.hidden=!msg;}
function adminCredencial(){try{return JSON.parse(localStorage.getItem(ADMIN_KEY)||'null')}catch{return null}}
async function adminDigest(salt,senha){
 if(!globalThis.crypto?.subtle)throw Error('Este navegador não oferece criptografia segura para verificar a senha.');
 const data=new TextEncoder().encode(salt+':'+senha);
 const hash=await crypto.subtle.digest('SHA-256',data);
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
function abrirAdmin(){
 if(!sessaoAdministradorAutorizada()){alert('Acesso exclusivo da conta Administrador Principal. Saia e entre com a conta de administrador.');return;}
 adminAviso('');adminInput.value='';$('adminPrincipalConfirmacao').value='';
 const criar=!adminCredencial();
 $('adminPrincipalCriacao').hidden=!criar;
 $('adminPrincipalDescricao').textContent=adminAtivo?'Gerencie as ações exclusivas do administrador.':(criar?'Primeiro acesso: crie uma senha de 4 a 8 caracteres. Guarde-a em local seguro.':'Informe a senha do Administrador Principal.');
 $('adminPrincipalPainel').hidden=!adminAtivo;
 adminInput.parentElement.querySelector('label').hidden=adminAtivo;
 adminInput.hidden=adminAtivo;
 $('adminPrincipalEntrar').hidden=adminAtivo;
 adminDlg.showModal();if(!adminAtivo)adminInput.focus();
}
$('adminPrincipalBtn').addEventListener('click',abrirAdmin);
$('adminPrincipalCancelar').addEventListener('click',()=>adminDlg.close());
$('adminPrincipalEntrar').addEventListener('click',async()=>{
 if(!sessaoAdministradorAutorizada()){adminAviso('Acesso negado: sessão de operador não pode ativar o modo administrador.');return;}
 const senha=adminInput.value,registro=adminCredencial();adminAviso('');
 if(senha.length<4||senha.length>8){adminAviso('A senha deve conter entre 4 e 8 caracteres.');return;}
 try{
  if(!registro){
   if(senha!==$('adminPrincipalConfirmacao').value){adminAviso('As senhas não coincidem.');return;}
   const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);
   const salt=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
   const hash=await adminDigest(salt,senha);
   localStorage.setItem(ADMIN_KEY,JSON.stringify({v:1,salt,hash}));
  }else if((await adminDigest(registro.salt,senha))!==registro.hash){adminAviso('Senha incorreta.');return;}
  if(!sessaoAdministradorAutorizada()){adminAviso('A sessão atual não é de administrador.');return;}
  adminAtivo=true;atualizarIndicadorAdmin();renderAudit();addAudit({field:'acesso Administrador Principal',previous:'inativo',next:'ativo',origin:'administração'});
  adminDlg.close(); // Permitir navegar no histórico sem uma janela modal bloqueando a tela.
 }catch(err){adminAviso(err.message||'Falha ao verificar senha.');}
});
$('adminPrincipalSair').addEventListener('click',()=>{adminAtivo=false;atualizarIndicadorAdmin();adminDlg.close();});
function limparAuditoriaAdmin(){
 if(!window.__adminPrincipalAtivo())return;
 const senha=prompt('ATENÇÃO: esta ação apagará TODOS os registros de auditoria deste navegador. Faça um backup antes.\nDigite LIMPAR AUDITORIA para confirmar:');
 if(senha!=='LIMPAR AUDITORIA')return;
 try{localStorage.removeItem(AK);baseline=JSON.stringify(state);lastHist=JSON.stringify(acolhimentosHistorico);renderAudit();alert('Registros de auditoria locais apagados.');}
 catch(err){alert('Não foi possível limpar a auditoria: '+err.message);}
}
$('adminPrincipalLimparAuditoria').addEventListener('click',limparAuditoriaAdmin);
$('authAuditClearBtn').addEventListener('click',()=>{
 if(!adminAtivo){alert('Acesso exclusivo do Administrador Principal.');return;}
 const pessoaId=String(lastAuditKey||'');
 if(!pessoaId){alert('Abra a auditoria pelo botão ℹ️ da pessoa para limpar somente os registros dela.');return;}
 const todos=audits();
 const alvo=todos.filter(a=>String(a.personId||'')===pessoaId);
 if(!alvo.length){alert('Esta pessoa não possui registros de auditoria para excluir.');return;}
 const nome=alvo.find(a=>a.personName)?.personName||'pessoa selecionada';
 const confirmacao=prompt('Excluir SOMENTE '+alvo.length+' registro(s) de auditoria de '+nome+'?\nOs registros de outras pessoas e do sistema serão preservados.\nDigite LIMPAR PESSOA para confirmar:');
 if(confirmacao!=='LIMPAR PESSOA')return;
 try{
  const restantes=todos.filter(a=>String(a.personId||'')!==pessoaId);
  localStorage.setItem(AK,JSON.stringify(restantes));
  renderAudit();
  alert(alvo.length+' registro(s) de auditoria da pessoa selecionada foram excluídos. Os demais foram preservados.');
 }catch(err){alert('Não foi possível limpar a auditoria desta pessoa: '+err.message);}
});
// Após renderização do histórico, os botões de exclusão só ficam disponíveis ao administrador.
const observer=new MutationObserver(()=>{
 document.querySelectorAll('.btn-excluir-historico').forEach(btn=>{if(btn.hidden===adminAtivo)btn.hidden=!adminAtivo;});
});
const historicoPainel=$('historicoResultados')||document.querySelector('.historico-resultados');
if(historicoPainel)observer.observe(historicoPainel,{childList:true,subtree:true});
atualizarIndicadorAdmin();
window.__authBoot=()=>{capture();atualizarLista();$('operadorNomeExibido').textContent=nomeOperador||'Não selecionado';abrirModalOperador(false);};
setInterval(atualizarLista,1500);
// A seleção inicial é exibida apenas após o carregamento dos dados, em __authBoot.
})();
