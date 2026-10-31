
(function(){'use strict';
const $=id=>document.getElementById(id), today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const m=()=>{if(!state.medicamentos)state.medicamentos={produtos:[],lotes:[],prescricoes:[],administracoes:[],movimentos:[]};return state.medicamentos};
const id=()=> 'med_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
const clean=t=>String(t??'').trim();
const fmt=d=>d?String(d).split('-').reverse().join('/'):'—';
const operator=()=>window.__operadorAtual?.()||'Não identificado';
const personMap=()=>{const list=[];for(const r of Object.values(state?.rooms||{}))for(const p of (r.pessoas||[]))if(clean(p.nome)&&!clean(p.saida))list.push({id:String(p.id),nome:p.nome,quarto:r.numero,idade:typeof idadeDaPessoa==='function'?idadeDaPessoa(p):null});return list.sort((a,b)=>a.nome.localeCompare(b.nome,'pt-BR'))};
const prodName=pid=>{const x=m().produtos.find(p=>p.id===pid);return x?x.nome+' · '+x.apresentacao:'Medicamento não localizado'};
const produto=pid=>m().produtos.find(p=>p.id===pid);
const unidade=p=>p?.tipo==='frasco'?'mL':'un';
const dec=n=>Number(n||0).toLocaleString('pt-BR',{maximumFractionDigits:2});
const addDays=(date,n)=>{const d=new Date(date+'T12:00:00');d.setDate(d.getDate()+n);return todayOf(d)};
const todayOf=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
function schedule(start,interval){const [h,min]=start.split(':').map(Number);const slots=[];for(let t=h*60+min,k=0;k<24&&t<h*60+min+1440;k++,t+=interval*60){const v=t%1440;slots.push(String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0'))}return [...new Set(slots)].sort()}
/* Agenda calculada a partir do instante real de início, não da meia-noite.
   UTC evita saltos causados por horário de verão e mantém os horários locais da prescrição. */
function doseSlotsOnDate(rx,date){
 if(!rx||rx.usoLivre||!rx.inicio||date<rx.inicio||(rx.fim&&date>rx.fim))return [];
 const intervalo=Number(rx.intervalo);
 const inicioHora=String(rx.horaInicio||'');
 if(!Number.isFinite(intervalo)||intervalo<=0||!/^([01]\d|2[0-3]):[0-5]\d$/.test(inicioHora)){
  // Compatibilidade com prescrições antigas que guardam apenas os horários.
  return (rx.horarios||[]).filter(h=>(date!==rx.inicio||h>=inicioHora)&&(!rx.fim||date!==rx.fim||h<=(rx.fimHora||"23:59")));
 }
 const start=Date.parse(rx.inicio+'T00:00:00Z')+(Number(inicioHora.slice(0,2))*60+Number(inicioHora.slice(3)))*60000;
 const day=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(start)||!Number.isFinite(day))return [];
 const step=Math.round(intervalo*60)*60000;
 const first=Math.max(0,Math.ceil((day-start)/step));
 const slots=[];
 for(let i=first;i<first+150;i++){
  const at=start+i*step;
  if(at>=day+86400000)break;
  if(at<day)continue;
  if(rx.fim&&at>medInstante(rx.fim,rx.fimHora||"23:59"))break;
  const minutes=Math.round((at-day)/60000);
  slots.push(String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0'));
 }
 return slots;
}
// Instantes locais representados em UTC para contagem estável, independentemente de fuso e horário de verão.
const medInstante=(data,hora)=>Date.parse(String(data||'')+'T'+String(hora||'00:00')+':00Z');
const medDataHora=t=>{const d=new Date(t);return {data:d.toISOString().slice(0,10),hora:d.toISOString().slice(11,16)}};
function medPlano(){
 const inicio=$('medInicio').value,hora=$('medHoraInicio').value||'08:00',livre=$('medUsoLivre').checked;
 const dias=Number($('medDias').value),vezes=Number($('medVezes').value),intervalo=Number($('medIntervalo').value);
 const manual=$('medFimManual').checked,primeiro=medInstante(inicio,hora);
 const valido=Number.isFinite(primeiro)&&Number.isInteger(dias)&&dias>0&&(livre||Number.isInteger(intervalo)&&intervalo>0);
 if(!valido)return null;
 const passo=intervalo*3600000;
 // Duração em dias considera a data inicial como dia 1, até o final do último dia.
 const limiteDias=medInstante(addDays(inicio,dias),'00:00')-1;
 let fimInstante=limiteDias;
 if(manual){fimInstante=medInstante($('medFimData').value,$('medFimHora').value);if(!Number.isFinite(fimInstante)||fimInstante<primeiro)return null;}
 const qtd=livre?Math.max(0,(manual?Math.floor((fimInstante-medInstante(inicio,'00:00'))/86400000)+1:dias))*vezes:Math.max(0,Math.floor((fimInstante-primeiro)/passo)+1);
 const ultimo=livre?fimInstante:primeiro+(Math.max(0,qtd-1))*passo;
 return {inicio,hora,dias,vezes,intervalo,livre,manual,quantidade:qtd,fim:medDataHora(ultimo).data,fimHora:medDataHora(ultimo).hora,limite:medDataHora(fimInstante)};
}
function quantidadeDosesProgramadas(inicio,hora,intervalo,dias){
 const primeiro=medInstante(inicio,hora),ultimo=medInstante(addDays(inicio,dias),'00:00')-1;
 return Number.isFinite(primeiro)&&Number.isFinite(ultimo)&&intervalo>0?Math.max(0,Math.floor((ultimo-primeiro)/(intervalo*3600000))+1):0;
}
function dailyConsumption(pid){return m().prescricoes.filter(rx=>rx.ativa&&rx.produtoId===pid&&!rx.usoLivre).reduce((sum,rx)=>sum+(Number(rx.consumo)||0)*(rx.horarios?.length||0),0)}
function updatePresentation(){const t=$('medTipo').value;$('medUnidadesWrap').hidden=t!=='cartela';$('medMlWrap').hidden=t!=='frasco'}
function updateEntry(){
 const p=produto($('medProdutoLote').value),li=p?.tipo==='frasco',unidades=$('medUnidadesLote'),bloco=$('medUnidadesLoteWrap');
 $('medQtdLabel').firstChild.textContent=li?'Quantidade de frascos recebidos ':'Quantidade de cartelas recebidas ';
 bloco.hidden=li||!p;unidades.disabled=li||!p;unidades.required=!li&&!!p;
 // Recarregar a tabela não deve apagar a quantidade real digitada pelo operador.
 if(unidades.dataset.produtoId!==String(p?.id||'')){
  unidades.dataset.produtoId=String(p?.id||'');
  unidades.value=p&&!li?String(Number(p.unidadesPorCartela)||1):'';
 }
 $('medQtdHelp').textContent=li?'O saldo será calculado em mL, usando o volume de cada frasco.':'Informe quantas unidades existem de fato EM CADA cartela recebida, mesmo que esteja incompleta.';
 atualizarTotalEntradaLote();
}
function atualizarTotalEntradaLote(){
 const p=produto($('medProdutoLote').value),c=Number($('medQuantidade').value),li=p?.tipo==='frasco';
 const u=li?Number(p?.mlPorFrasco):Number($('medUnidadesLote').value);
 const el=$('medLoteTotalPreview');
 if(!p||!Number.isInteger(c)||c<1||!Number.isFinite(u)||u<=0||(!li&&!Number.isInteger(u))){el.textContent='Informe as embalagens e suas unidades para calcular o saldo de entrada.';return;}
 el.textContent='Total a entrar no estoque: '+dec(c*u)+' '+unidade(p)+' ('+c+' '+(li?'frasco(s)':'cartela(s)')+' × '+dec(u)+' '+(li?'mL por frasco':'unidades por cartela')+').';
}
function updatePrescription(){
 const p=produto($('medProdutoPresc').value),pessoaId=$('medPessoa').value;
 const ls=lotesAutorizados(p?.id,pessoaId).filter(l=>Number(l.quantidade)>0);
 const saldo=ls.reduce((n,l)=>n+Number(l.quantidade||0),0);
 $('medResumoProduto').textContent=p?('Embalagem: '+(p.tipo==='frasco'?'Frasco líquido ('+dec(p.mlPorFrasco)+' mL)':'Cartela ('+dec(p.unidadesPorCartela||1)+' un)')+' | Lotes: '+(ls.map(l=>l.numero+' / '+fmt(l.validade)+' ('+(destinoLote(l)?'reservado para '+(l.reservadoPessoaNome||'acolhido'):'compartilhado')+')').join('; ')||'sem saldo')+' | Saldo disponível: '+dec(saldo)+' '+unidade(p)):'Selecione o medicamento para visualizar embalagem, lote, validade e saldo.';
 const livre=$('medUsoLivre').checked,manual=$('medFimManual').checked;
 $('medCamposUsoLivre').hidden=!livre;$('medCamposProgramados').hidden=livre;
 $('medIntervalo').disabled=livre;$('medIntervalo').required=!livre;
 $('medFimManualCampos').hidden=!manual;$('medFimData').required=manual;$('medFimHora').required=manual;
 const plano=medPlano(),consumo=Number($('medConsumo').value)||0;
 if(!plano||consumo<=0){$('medProjecao').textContent='Confira os dados do período, dose e horários para obter a estimativa.';$('medFimAutoResumo').textContent=manual?'Insira uma data e hora de término válidas.':'Término automático: informe o início e a duração.';return;}
 const necessidade=Math.round(plano.quantidade*consumo*100)/100,diferenca=Math.round((saldo-necessidade)*100)/100;
 const descricao=fmt(plano.fim)+' às '+plano.fimHora;
 $('medFimAutoResumo').textContent=manual?'Fim manual: '+descricao+' (última administração prevista).':'Fim calculado pelo período prescrito: '+descricao+'. A disponibilidade de estoque é conferida abaixo.';
 const proj=$('medProjecao');proj.replaceChildren();
 const texto=document.createElement('span');texto.textContent='A serem consumidas: '+dec(necessidade)+' '+unidade(p)+' ('+plano.quantidade+' administrações'+(livre?' possíveis, não automáticas':' programadas')+'). Estimativa conforme dados inseridos e prescrição. ';
 proj.append(texto);
 const aviso=document.createElement('strong');
 if(diferenca<0){aviso.textContent='FALTAM '+dec(-diferenca)+' '+unidade(p)+' — NÃO POSSIBILITA O TÉRMINO DO TRATAMENTO COM O ESTOQUE ATUAL.';aviso.style.color='#c61d2a';}
 else {aviso.textContent='Estoque suficiente. Saldo previsto após o tratamento: '+dec(diferenca)+' '+unidade(p)+'.';aviso.style.color='#176b34';}
 proj.append(aviso);
}
const destinoLote=l=>String(l?.reservadoPessoaId||'');
const lotesAutorizados=(produtoId,pessoaId)=>m().lotes.filter(l=>!l.removido&&l.produtoId===produtoId&&(!destinoLote(l)||destinoLote(l)===String(pessoaId)));
const nomeReserva=l=>{if(!l||!destinoLote(l))return 'Compartilhado';const atual=personMap().find(p=>p.id===destinoLote(l));return 'Exclusivo: '+(atual?.nome||l.reservadoPessoaNome||'Acolhido não localizado');};
function alterarDestinacaoLote(){const reservado=$('medDestinacao').value==='reservado';$('medReservadoPessoaWrap').hidden=!reservado;$('medReservadoPessoa').required=reservado;}
const personName=pid=>{const p=personMap().find(p=>p.id===pid);return p?p.nome+(p.idade!==null?' · '+p.idade+' anos':'')+' · quarto '+p.quarto:(m().prescricoes.find(x=>x.pessoaId===pid)?.pessoaNome||'Acolhido desligado')};
function msg(t,error=false){$('medMsg').textContent=t;$('medMsg').classList.toggle('med-erro',error)}
function audit(field,previous,next,rx){window.__auditarOcorrenciaChave?.({personId:String(rx?.pessoaId||''),personName:String(rx?.pessoaNome||''),quarto:String(rx?.quarto||''),field:'medicamentos — '+field,previous:String(previous),next:String(next),origin:'controle de medicamentos'})}
function event(tipo,detalhe,rx){const rec={id:id(),at:new Date().toISOString(),operador:operator(),tipo,detalhe,pessoaId:rx?.pessoaId||'',pessoaNome:rx?.pessoaNome||'',quarto:rx?.quarto||''};m().movimentos.push(rec);audit(tipo,'—',detalhe,rx)}
function persist(){try{salvarNoStorage();render();agendarIndicacaoSalvo();return true}catch(err){msg('Falha ao salvar: '+err.message,true);return false}}
const cell=(row,val)=>{const td=document.createElement('td');td.textContent=String(val??'');row.append(td);return td};
const escHtml=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const btn=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=fn;return b};
function fillSelect(el,items,placeholder){const prior=el.value;el.replaceChildren(new Option(placeholder,''));items.forEach(x=>el.add(new Option(x.label,x.value)));if([...el.options].some(o=>o.value===prior))el.value=prior;}
function renderPeople(){const items=personMap().map(p=>({value:p.id,label:p.nome+(p.idade!==null?' · '+p.idade+' anos':'')+' · quarto '+p.quarto}));fillSelect($('medPessoa'),items,'Selecione o acolhido');fillSelect($('medReservadoPessoa'),items,'Selecione o acolhido para reservar o lote');}
function renderProducts(){const items=m().produtos.map(x=>({value:x.id,label:x.nome+' · '+x.apresentacao}));fillSelect($('medProdutoLote'),items,'Selecione o medicamento');fillSelect($('medProdutoPresc'),items,'Selecione o medicamento')}
function statusTag(t){const b=document.createElement('span');b.className='med-tag '+(t==='administrado'?'med-ok':t==='nao_administrado'?'med-erro':'med-alerta');b.textContent=t==='administrado'?'Administrado':t==='nao_administrado'?'Não administrado':'Pendente';return b}
function agenda(date){const list=[];const active=new Set(personMap().map(p=>p.id));for(const rx of m().prescricoes){if(!rx.ativa||rx.usoLivre||!active.has(rx.pessoaId)||date<rx.inicio||(rx.fim&&date>rx.fim))continue;for(const hora of doseSlotsOnDate(rx,date))list.push({rx,hora,date,key:rx.id+'|'+date+'|'+hora})}return list.sort((a,b)=>a.hora.localeCompare(b.hora)||a.rx.pessoaNome.localeCompare(b.rx.pessoaNome,'pt-BR'))}
function prnOnDate(date){const active=new Set(personMap().map(p=>p.id));return m().prescricoes.filter(rx=>rx.ativa&&rx.usoLivre&&active.has(rx.pessoaId)&&date>=rx.inicio&&(!rx.fim||date<=rx.fim))}
function prnRecords(rx,date){return m().administracoes.filter(a=>a.prescricaoId===rx.id&&a.data===date&&a.usoLivre)}
function renderAgenda(){const date=$('medData').value||today(),filter=$('medFiltro').value,body=$('medListaAgenda');body.replaceChildren();let n=0;
for(const item of agenda(date)){const prev=m().administracoes.find(a=>a.chave===item.key);const status=prev?.status||'pendente';if(filter!=='todos'&&status!==filter)continue;n++;const tr=body.insertRow();cell(tr,item.hora);cell(tr,personName(item.rx.pessoaId));cell(tr,prodName(item.rx.produtoId)+' — '+item.rx.dose+' ('+item.rx.via+')');const td=tr.insertCell();td.append(statusTag(status));const act=tr.insertCell();if(!prev)act.append(btn('Registrar',()=>openAdministration(item)));else cellLog(act,prev)}
for(const rx of prnOnDate(date)){
const records=prnRecords(rx,date).sort((a,b)=>a.hora.localeCompare(b.hora));
const done=records.filter(a=>a.status==='administrado').length;
const limit=Math.max(1,Number(rx.vezes)||1);
const canRegister=done<limit&&date<=today();
// Se ainda não há registro, mostra a linha inicial para cadastrar o primeiro uso.
// Depois do primeiro registro, mantém apenas as linhas de administração realizadas.
if(records.length===0&&(filter==='todos'||filter==='pendente')){
 n++;const tr=body.insertRow();
 cell(tr,'Conforme necessidade');cell(tr,personName(rx.pessoaId));
 cell(tr,prodName(rx.produtoId)+' — '+rx.dose+' ('+rx.via+')'+(rx.refeicao?' · '+rx.refeicao:'')+' · limite '+limit+' vez(es)/dia');
 const td=tr.insertCell();const info=document.createElement('span');info.className='med-tag';info.textContent='Pendente · 0 de '+limit+' administração(ões)';td.append(info);
 const action=tr.insertCell();if(canRegister)action.append(btn('Registrar uso',()=>openAdministration({rx,date,hora:'',usoLivre:true})));
 else action.textContent='Data futura: não registrar antecipadamente';
}
for(const rec of records){
 if(filter!=='todos'&&filter!==rec.status)continue;
 n++;const tr=body.insertRow();cell(tr,rec.hora);cell(tr,personName(rx.pessoaId));
 cell(tr,prodName(rx.produtoId)+' — '+rec.dose+' · uso conforme necessidade');
 tr.insertCell().append(statusTag(rec.status));
 const action=tr.insertCell();cellLog(action,rec);
 // Com limite ainda disponível, permite outra administração na própria linha,
 // sem acrescentar a linha duplicada "Conforme necessidade".
 if(canRegister&&rec===records[records.length-1]){
   const more=btn('Registrar novo uso',()=>openAdministration({rx,date,hora:'',usoLivre:true}));
   more.classList.add('med-registrar-outro-uso');action.append(document.createTextNode(' '),more);
 }
}
}
if(!n){const tr=body.insertRow();const td=tr.insertCell();td.colSpan=5;td.textContent='Nenhuma administração prevista para os filtros escolhidos.'}}
function cellLog(box,rec){box.textContent=new Date(rec.at).toLocaleString('pt-BR')+' · '+rec.operador+(rec.observacao?' · '+rec.observacao:'')}
let pending=null;
const medMotivosAdministrado=['Medicado na recepção','Medicado no quarto','Levou a medicação'];
const medMotivosNaoAdministrado=['Saiu sem tomar','Se recusou','Esqueceu de tomar'];
function atualizarMotivosAdministracao(){
 const select=$('medMotivo'),status=$('medStatus').value,livre=$('medObsLivreCheck').checked;
 const anterior=select.value;
 select.replaceChildren(new Option('Selecione uma opção',''));
 for(const motivo of (status==='administrado'?medMotivosAdministrado:medMotivosNaoAdministrado))select.add(new Option(motivo,motivo));
 if([...select.options].some(op=>op.value===anterior))select.value=anterior;
 $('medMotivoWrap').hidden=livre;
 $('medObsLivreWrap').hidden=!livre;
 select.disabled=livre;select.required=!livre;
 $('medObs').disabled=!livre;$('medObs').required=livre;
}
$('medStatus').addEventListener('change',atualizarMotivosAdministracao);
$('medObsLivreCheck').addEventListener('change',atualizarMotivosAdministracao);
function openAdministration(item){if(!item.usoLivre&&m().administracoes.some(a=>a.chave===item.key)){msg('Esta dose já possui registro.',true);return}pending=item;const manual=Boolean(item.usoLivre);const horaInput=$('medHoraReal');$('medHoraRealWrap').hidden=!manual;horaInput.disabled=!manual;horaInput.readOnly=false;horaInput.required=manual;horaInput.value=manual&&item.date===today()?new Date().toTimeString().slice(0,5):'';
$('medDialogTexto').textContent=personName(item.rx.pessoaId)+' | '+prodName(item.rx.produtoId)+' | '+item.rx.dose+' | '+fmt(item.date)+(manual?' | uso conforme necessidade (registrar horário efetivo)':' às '+item.hora);$('medStatus').value='administrado';$('medObsLivreCheck').checked=false;$('medMotivo').value='';$('medObs').value='';atualizarMotivosAdministracao();$('medDialog').showModal()}
$('medCancelar').onclick=()=>{$('medDialog').close();pending=null};
$('medConfirmForm').onsubmit=e=>{e.preventDefault();if(!pending)return;const item=pending,status=$('medStatus').value,livre=$('medObsLivreCheck').checked,motivo=livre?'':$('medMotivo').value,obsLivre=livre?clean($('medObs').value):'',obs=livre?obsLivre:motivo,manual=Boolean(item.usoLivre),hora=manual?$('medHoraReal').value:item.hora;
if(!obs){msg(livre?'Informe a observação ou justificativa.':'Selecione um motivo para o registro.',true);(livre?$('medObs'):$('medMotivo')).focus();return}
if(manual){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)){msg('Informe o horário efetivo da administração.',true);$('medHoraReal').focus();return}if(item.date>today()){msg('Não é possível registrar uma administração futura.',true);return}if(!item.rx.ativa||!prnOnDate(item.date).some(rx=>rx.id===item.rx.id)){msg('Prescrição de uso livre não está ativa nesta data.',true);return}const registros=prnRecords(item.rx,item.date);const max=Math.max(1,Number(item.rx.vezes)||1);if(status==='administrado'&&registros.filter(a=>a.status==='administrado').length>=max){msg('O limite diário da prescrição já foi atingido.',true);return}if(registros.some(a=>a.hora===hora)){msg('Já existe um registro desta prescrição neste horário.',true);return}}
const chave=manual?item.rx.id+'|'+item.date+'|livre|'+hora:item.key;if(m().administracoes.some(a=>a.chave===chave)){msg('Já existe um registro para este horário.',true);return}
let lote=null;if(status==='administrado'){const referencia=today();lote=lotesAutorizados(item.rx.produtoId,item.rx.pessoaId).filter(l=>l.quantidade>=(item.rx.consumo||1)&&l.validade>=referencia).sort((a,b)=>a.validade.localeCompare(b.validade))[0];if(!lote){msg('Estoque autorizado para este acolhido, disponível e não vencido, insuficiente. Lotes reservados a outras pessoas não podem ser utilizados.',true);return}}
if(!confirm('Confirmar '+(status==='administrado'?'ADMINISTRAÇÃO':'NÃO ADMINISTRAÇÃO')+(manual?' conforme necessidade':' da dose programada')+'?'))return;
snapshotAntes();
const rec={id:id(),chave,prescricaoId:item.rx.id,pessoaId:item.rx.pessoaId,pessoaNome:item.rx.pessoaNome,produtoId:item.rx.produtoId,data:item.date,hora,dose:item.rx.dose,status,usoLivre:manual,motivo:motivo||'',observacaoLivre:obsLivre||'',observacao:obs,at:new Date().toISOString(),operador:operator(),loteId:lote?.id||''};m().administracoes.push(rec);
m().ultimoRegistroParaDesfazer={id:rec.id,timestamp:Date.now(),quantidadeConsumida:lote?Number(item.rx.consumo||1):0};
if(lote){lote.quantidade=Math.round((lote.quantidade-(item.rx.consumo||1))*100)/100;event('saída de estoque',prodName(item.rx.produtoId)+' | lote '+lote.numero+' | -'+(item.rx.consumo||1)+' '+unidade(produto(item.rx.produtoId))+' | dose '+item.rx.dose, item.rx)}event('administração — '+status,personName(item.rx.pessoaId)+' | '+prodName(item.rx.produtoId)+' | '+fmt(item.date)+' '+hora+' | '+item.rx.dose+(manual?' | conforme necessidade':'')+' | '+obs,item.rx);pending=null;$('medDialog').close();persist();renderAll();msg('Registro confirmado e auditado.')};
$('medTipo').onchange=updatePresentation;
$('medProdutoLote').onchange=updateEntry;
$('medQuantidade').addEventListener('input',atualizarTotalEntradaLote);
$('medUnidadesLote').addEventListener('input',atualizarTotalEntradaLote);
$('medProdutoPresc').onchange=updatePrescription;
$('medPessoa').addEventListener('change',updatePrescription);
$('medDestinacao').addEventListener('change',alterarDestinacaoLote);
alterarDestinacaoLote();
for(const f of ['medUsoLivre','medConsumo','medVezes','medHoraInicio','medIntervalo','medDias','medInicio','medFimManual','medFimData','medFimHora'])$(f).addEventListener('input',updatePrescription);
$('medUsoLivre').addEventListener('change',updatePrescription);
$('medFimManual').addEventListener('change',updatePrescription);
$('medProdutoForm').onsubmit=e=>{e.preventDefault();const nome=clean($('medNome').value),apresentacao=clean($('medApresentacao').value),tipo=$('medTipo').value,un=Number($('medUnidadesCartela').value),ml=Number($('medMlFrasco').value);if(!nome||!apresentacao||(tipo==='cartela'&&(!Number.isInteger(un)||un<1))||(tipo==='frasco'&&(!Number.isFinite(ml)||ml<=0)))return msg('Verifique o tipo e a capacidade da embalagem.',true);const item={id:id(),nome,apresentacao,local:clean($('medLocal').value),tipo,unidadesPorCartela:tipo==='cartela'?un:0,mlPorFrasco:tipo==='frasco'?ml:0};snapshotAntes();m().produtos.push(item);event('cadastro de medicamento',nome+' | '+tipo+' | '+apresentacao);persist();e.target.reset();updatePresentation();renderAll();msg('Medicamento cadastrado.')};
$('medLoteForm').onsubmit=e=>{
 e.preventDefault();
 const produtoId=$('medProdutoLote').value,p=produto(produtoId),numero=clean($('medLoteNumero').value),validade=$('medValidade').value;
 const embalagens=Number($('medQuantidade').value),unidadesEfetivas=Number($('medUnidadesLote').value);
 const reservado=$('medDestinacao').value==='reservado',pessoaReservada=personMap().find(x=>x.id===$('medReservadoPessoa').value);
 if(reservado&&!pessoaReservada)return msg('Escolha o acolhido para quem este lote ficará reservado.',true);
 if(!p||!numero||!validade||!Number.isInteger(embalagens)||embalagens<1)return msg('Preencha lote, validade e quantidade de embalagens.',true);
 if(p.tipo!=='frasco'&&(!Number.isInteger(unidadesEfetivas)||unidadesEfetivas<1))return msg('Informe a quantidade real de unidades por cartela recebida.',true);
 const fator=p.tipo==='frasco'?Number(p.mlPorFrasco):unidadesEfetivas;
 if(!Number.isFinite(fator)||fator<=0)return msg('Informe uma capacidade de embalagem válida.',true);
 const quantidade=Math.round(embalagens*fator*100)/100;
 const lote={id:id(),produtoId,numero,validade,quantidade,recebido:quantidade,embalagens,unidadesPorCartelaLote:p.tipo==='frasco'?null:unidadesEfetivas,reservadoPessoaId:reservado?pessoaReservada.id:'',reservadoPessoaNome:reservado?pessoaReservada.nome:'',origem:clean($('medOrigem').value),at:new Date().toISOString()};
 snapshotAntes();m().lotes.push(lote);
 event('entrada de estoque',prodName(produtoId)+' | lote '+numero+' | '+embalagens+' embalagem(ns) × '+dec(fator)+' '+(p.tipo==='frasco'?'mL':'unidades')+' | +'+dec(quantidade)+' '+unidade(p)+' | validade '+fmt(validade)+' | destinação: '+nomeReserva(lote),reservado?{pessoaId:pessoaReservada.id,pessoaNome:pessoaReservada.nome,quarto:pessoaReservada.quarto}:undefined);
 persist();e.target.reset();$('medUnidadesLote').dataset.produtoId='';alterarDestinacaoLote();renderAll();
 msg('Entrada de '+dec(quantidade)+' '+unidade(p)+' registrada'+(reservado?' e reservada exclusivamente para '+pessoaReservada.nome:'')+'.');
};
$('medPrescForm').onsubmit=e=>{e.preventDefault();const pessoa=personMap().find(p=>p.id===$('medPessoa').value),produtoId=$('medProdutoPresc').value,p=produto(produtoId),dose=clean($('medDose').value),via=$('medVia').value,inicio=$('medInicio').value,prescritor=clean($('medPrescritor').value),usoLivre=$('medUsoLivre').checked,consumo=Number($('medConsumo').value),dias=Number($('medDias').value),vezes=Number($('medVezes').value),intervalo=Number($('medIntervalo').value),hora=$('medHoraInicio').value,refeicao=$('medRefeicao').value,periodo=$('medPeriodo').value;if(!pessoa||!p||!Number.isFinite(consumo)||consumo<=0||(p.tipo!=='frasco'&&!Number.isInteger(consumo))||!dose||!prescritor||!inicio||!Number.isInteger(dias)||dias<1||(!usoLivre&&(!Number.isInteger(intervalo)||intervalo<1||intervalo>24||!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)))||(usoLivre&&(!Number.isInteger(vezes)||vezes<1||vezes>24)))return msg('Confira dose, duração, horários e referência da prescrição.',true);const plano=medPlano();if(!plano)return msg('Informe uma data de fim válida, igual ou posterior ao início.',true);const horarios=usoLivre?[]:schedule(hora,intervalo),fim=plano.fim,rx={id:id(),pessoaId:pessoa.id,pessoaNome:pessoa.nome,quarto:pessoa.quarto,produtoId,dose,consumo,via,horarios,inicio,fim,fimHora:plano.fimHora,fimManual:plano.manual,prescritor,usoLivre,vezes:usoLivre?vezes:horarios.length,periodo,refeicao,horaInicio:hora,intervalo:usoLivre?null:intervalo,dias,estimativa:consumo*plano.quantidade,observacao:clean($('medPrescObs').value),ativa:true,criadaEm:new Date().toISOString()};if(prescricaoEditandoId){
 if(!usuarioPodeEditarPrescricoes())return msg('Acesso exclusivo do Administrador Principal.',true);
 const original=m().prescricoes.find(r=>r.id===prescricaoEditandoId);
 if(!original||!original.ativa)return msg('Prescrição indisponível para edição.',true);
 const newData={...rx,id:original.id,pessoaId:original.pessoaId,pessoaNome:original.pessoaNome,quarto:original.quarto,criadaEm:original.criadaEm,ativa:original.ativa};
 if(pessoa.id!==original.pessoaId)return msg('Não é permitido transferir uma prescrição para outro acolhido. Cadastre uma nova.',true);
 const already=m().administracoes.some(a=>a.prescricaoId===original.id);
 const protectedFields=['produtoId','dose','consumo','via','usoLivre','inicio','fim','horarios','vezes','horaInicio','intervalo','fimHora','fimManual'];
 if(already&&protectedFields.some(k=>JSON.stringify(original[k]??null)!==JSON.stringify(newData[k]??null)))return msg('Há administrações registradas. Para alterar medicamento, dose, modalidade ou programação, encerre esta prescrição e crie outra; o histórico deve ser preservado.',true);
 const changed=Object.keys(newData).filter(k=>JSON.stringify(original[k]??null)!==JSON.stringify(newData[k]??null));
 if(!changed.length)return msg('Nenhuma alteração identificada.',true);
 if(!confirm('Confirmar edição da prescrição de '+original.pessoaNome+'?\nCampos alterados: '+changed.join(', ')))return;
 const before=changed.map(k=>k+': '+JSON.stringify(original[k]??null)).join(' | ');
 const after=changed.map(k=>k+': '+JSON.stringify(newData[k]??null)).join(' | ');
 snapshotAntes();Object.assign(original,newData,{atualizadaEm:new Date().toISOString(),atualizadaPor:operator()});
 event('prescrição editada','Antes: '+before+' | Depois: '+after,original);
 persist();resetarEdicaoPrescricao();renderAll();msg('Prescrição atualizada e auditada.');return;
}
snapshotAntes();m().prescricoes.push(rx);event('prescrição cadastrada' ,pessoa.nome+' | '+prodName(produtoId)+' | '+dose+' | '+(usoLivre?'uso conforme necessidade':horarios.join(', '))+' | '+dias+' dias | estimativa '+dec(rx.estimativa)+' '+unidade(p)+' | prescritor '+prescritor,rx);persist();e.target.reset();$('medInicio').value=today();renderAll();msg('Prescrição registrada. '+(usoLivre?'Uso livre disponível na Administração diária para registro manual, respeitando o limite prescrito.':'Confira os horários na agenda diária.'))};
let prescricaoEditandoId=null;
const usuarioPodeEditarPrescricoes=()=>window.__contaAdminAutenticada?.()===true&&window.__adminPrincipalAtivo?.()===true;
function resetarEdicaoPrescricao(){prescricaoEditandoId=null;$('medPrescForm').reset();$('medInicio').value=today();$('medPrescTitulo').textContent='Nova prescrição';$('medSalvarPresc').textContent='💾 Cadastrar prescrição';$('medCancelarEdicao').hidden=true;$('medAvisoEdicao').hidden=true;renderPeople();renderProducts();updatePrescription()}
function editarPrescricao(idRx){
 if(!usuarioPodeEditarPrescricoes()){msg('Somente o Administrador Principal pode editar prescrições.',true);return}
 const rx=m().prescricoes.find(r=>r.id===idRx);if(!rx||!rx.ativa){msg('Esta prescrição não está ativa.',true);return}
 prescricaoEditandoId=rx.id;
 renderPeople();renderProducts();
 // A pessoa pode já não estar na lista de acolhidos ativos.
 if(![...$('medPessoa').options].some(o=>o.value===rx.pessoaId))$('medPessoa').add(new Option(rx.pessoaNome+' (histórico)',rx.pessoaId));
 $('medPessoa').value=rx.pessoaId;$('medProdutoPresc').value=rx.produtoId;$('medConsumo').value=rx.consumo;$('medDose').value=rx.dose;
 $('medVia').value=rx.via;$('medUsoLivre').checked=Boolean(rx.usoLivre);$('medVezes').value=rx.vezes||1;$('medPeriodo').value=rx.periodo||'';$('medRefeicao').value=rx.refeicao||'';
 $('medInicio').value=rx.inicio;$('medHoraInicio').value=rx.horaInicio||(rx.horarios||[])[0]||'08:00';$('medIntervalo').value=rx.intervalo||8;$('medDias').value=rx.dias||1;$('medFimManual').checked=Boolean(rx.fimManual);$('medFimData').value=rx.fim||'';$('medFimHora').value=rx.fimHora||'23:59';$('medPrescritor').value=rx.prescritor||'';$('medPrescObs').value=rx.observacao||'';
 $('medPrescTitulo').textContent='✏️ Editar prescrição — '+rx.pessoaNome;$('medSalvarPresc').textContent='💾 Salvar alterações';$('medCancelarEdicao').hidden=false;$('medAvisoEdicao').hidden=false;
 updatePrescription();$('medPrescForm').scrollIntoView({behavior:'smooth',block:'start'});
}
$('medCancelarEdicao').onclick=resetarEdicaoPrescricao;
function renderPrescriptions(){
 const tbody=$('medListaPresc');
 const formatQtdCurta=q=>{const n=Number(q||0);if(Number.isInteger(n)&&n>=0&&n<10)return '0'+n;return dec(n)};
 tbody.replaceChildren();
 for(const rx of [...m().prescricoes].reverse()){
  if(rx.excluidaEm)continue; // Exclusão lógica: conservar dados para auditoria e histórico clínico.
  const tr=tbody.insertRow();
  const prod=produto(rx.produtoId);
  const tdA=tr.insertCell(); tdA.className='med-presc-acolhido'; tdA.textContent=rx.pessoaNome||'';
  const tdM=tr.insertCell(); tdM.className='med-presc-medicamento'; tdM.textContent=prodName(rx.produtoId);
  const tdD=tr.insertCell(); tdD.className='med-presc-detalhes';
  const detalhes=[];
  detalhes.push((rx.dose||'')+' · '+(rx.via||''));
  if(rx.usoLivre){
    detalhes.push('Uso conforme necessidade (até '+(rx.vezes||1)+' vezes/dia)');
  }else if((rx.horarios||[]).length){
    detalhes.push((rx.horarios||[]).join(', '));
  }
  if(rx.refeicao) detalhes.push(rx.refeicao);
  detalhes.push('a consumir: '+formatQtdCurta(rx.estimativa||0)+' '+unidade(prod));
  tdD.textContent=detalhes.filter(Boolean).join(' · ');

  const tdE=tr.insertCell();
  tdE.className='med-presc-sem-estoque';
  let semEstoque='Nenhuma';
  if(rx.ativa&&prod){
    const saldo=LotesSaldoPrescricao(rx,prod);
    const falta=Math.round(((Number(rx.estimativa)||0)-saldo)*100)/100;
    if(falta>0){
      semEstoque='- '+formatQtdCurta(falta)+' '+unidade(prod);
      tdE.style.color='#a81f1f';
      tdE.style.fontWeight='700';
    }
  }
  tdE.textContent=semEstoque;

  const tdS=tr.insertCell(); tdS.className='med-presc-situacao'; tdS.textContent=rx.ativa?'Ativa':'Encerrada';
  const tdAc=tr.insertCell(); tdAc.className='med-presc-acoes'; const botoes=document.createElement('div');botoes.className='med-presc-botoes';tdAc.append(botoes);
  if(rx.ativa && usuarioPodeEditarPrescricoes()){
    const edit=document.createElement('button');
    edit.type='button';
    edit.className='med-presc-btn-icone';
    edit.textContent='✏️';
    edit.title='Editar prescrição';
    edit.onclick=()=>editarPrescricao(rx.id);
    botoes.append(edit);
  }
  if(rx.ativa){
    const enc=document.createElement('button');
    enc.type='button';
    enc.className='med-presc-btn-encerrar';
    enc.textContent='Encerrar';
    enc.onclick=()=>{if(!confirm('Encerrar esta prescrição? Os registros anteriores serão preservados.'))return;snapshotAntes();rx.ativa=false;rx.encerradaEm=new Date().toISOString();event('prescrição encerrada',rx.pessoaNome+' | '+prodName(rx.produtoId),rx);persist();renderAll()};
    botoes.append(enc);
  }
  if(usuarioPodeEditarPrescricoes()){
    const excluir=document.createElement('button');
    excluir.type='button';excluir.className='med-presc-btn-excluir';
    excluir.textContent='🗑️';excluir.title='Excluir prescrição (Administrador Principal)';
    excluir.setAttribute('aria-label','Excluir prescrição de '+(rx.pessoaNome||'acolhido'));
    excluir.onclick=()=>excluirPrescricaoAdmin(rx.id);
    botoes.append(excluir);
  }
 }
 if(!tbody.rows.length){
  const r=tbody.insertRow();
  const td=r.insertCell(); td.colSpan=6; td.textContent='Nenhuma prescrição cadastrada.';
 }
}
function excluirPrescricaoAdmin(idRx){
 // Exclui da visualização e dos agendamentos, mas preserva receitas e administrações
 // anteriores para rastreabilidade, mesmo após importar/exportar backups.
 if(!usuarioPodeEditarPrescricoes())return msg('Exclusão exclusiva do Administrador Principal autenticado.',true);
 const rx=m().prescricoes.find(r=>r.id===idRx);
 if(!rx||rx.excluidaEm)return msg('Esta prescrição já foi excluída ou não foi localizada.',true);
 const motivo=prompt('Justificativa obrigatória para excluir a prescrição de '+(rx.pessoaNome||'acolhido')+' ('+prodName(rx.produtoId)+'):');
 if(motivo===null)return;
 if(!motivo.trim())return msg('Informe a justificativa para excluir a prescrição.',true);
 if(!confirm('CONFIRMAR EXCLUSÃO DA PRESCRIÇÃO?\n\nA prescrição será retirada da lista e da agenda. Administrações anteriores e o histórico de auditoria serão preservados.'))return;
 if(!usuarioPodeEditarPrescricoes())return msg('O acesso de Administrador Principal não está mais ativo.',true);
 snapshotAntes();
 rx.ativa=false;rx.excluidaEm=new Date().toISOString();rx.excluidaPor=operator();rx.motivoExclusao=motivo.trim();
 event('prescrição excluída',rx.pessoaNome+' | '+prodName(rx.produtoId)+' | justificativa: '+motivo.trim()+' | ID: '+rx.id,rx);
 if(prescricaoEditandoId===rx.id)resetarEdicaoPrescricao();
 persist();renderAll();msg('Prescrição excluída da lista. Histórico e administrações preservados.');
}
function LotesSaldoPrescricao(rx,prod){
 const lotes=lotesAutorizados(rx.produtoId,rx.pessoaId).filter(l=>Number(l.quantidade)>0);
 return Math.round(lotes.reduce((s,l)=>s+Number(l.quantidade||0),0)*100)/100;
}

// Operações de inventário: acesso só com sessão Admin autenticada e modo principal ativo.
const podeGerenciarInventario=()=>window.__contaAdminAutenticada?.()===true&&window.__adminPrincipalAtivo?.()===true;
const camposAuditoriaInventario={
 nome:'Nome do medicamento',apresentacao:'Apresentação / concentração',
 local:'Local de armazenamento',numero:'Número do lote',validade:'Validade',
 quantidade:'Quantidade disponível',recebido:'Quantidade recebida',unidadesPorCartelaLote:'Unidades efetivas por cartela deste lote',
 origem:'Origem / observação',reservadoPessoaNome:'Acolhido reservado',
 reservadoPessoaId:'Identificação da reserva',removido:'Situação do lote',
 motivoRemocao:'Motivo da remoção',saldoNaRemocao:'Saldo na remoção'
};
function valorAuditoriaInventario(campo,valor){
 if(valor===undefined||valor===null||valor==='')return 'Não informado';
 if(campo==='validade'&&/^\d{4}-\d{2}-\d{2}$/.test(String(valor)))return fmt(valor);
 if(campo==='removido')return valor?'Removido':'Disponível';
 return String(valor);
}
function diferencasAuditoriaInventario(antes,depois){
 const campos=Object.keys(camposAuditoriaInventario).filter(c=>c!=='reservadoPessoaId');
 const linhas=[];
 for(const campo of campos){
  if(String(antes?.[campo]??'')===String(depois?.[campo]??''))continue;
  linhas.push(camposAuditoriaInventario[campo]+': '+valorAuditoriaInventario(campo,antes?.[campo])+' → '+valorAuditoriaInventario(campo,depois?.[campo]));
 }
 if(!linhas.length&&String(antes?.reservadoPessoaId||'')!==String(depois?.reservadoPessoaId||'')){
  linhas.push('Destinação: '+valorAuditoriaInventario('reservadoPessoaNome',antes?.reservadoPessoaNome||'Compartilhado')+' → '+valorAuditoriaInventario('reservadoPessoaNome',depois?.reservadoPessoaNome||'Compartilhado'));
 }
 return linhas;
}
function registrarMudancaInventario(tipo,anterior,novo,contexto){
 const medicamento=tipo.includes('lote')?prodName(novo?.produtoId||anterior?.produtoId):(novo?.nome||anterior?.nome||'Medicamento');
 const cabecalho=tipo.includes('lote')?'Medicamento: '+medicamento+' | Lote: '+(novo?.numero||anterior?.numero||'—'):'Medicamento: '+medicamento;
 const linhas=diferencasAuditoriaInventario(anterior,novo);
 event(tipo,cabecalho+'\n'+(linhas.length?linhas.join('\n'):'Nenhum campo alterado.'),contexto);
}
function formatarDetalheHistoricoMedicamentos(ev){
 const detalhe=String(ev.detalhe||'');
 if(!/^(?:medicamento editado|lote de medicamento editado)$/i.test(String(ev.tipo||'')))return detalhe;
 const match=detalhe.match(/^Antes:\s*(\{.*\})\s*\|\s*Depois:\s*(\{.*\})$/s);
 if(!match)return detalhe;
 try{
  const antes=JSON.parse(match[1]),depois=JSON.parse(match[2]);
  const medicamento=ev.tipo.toLowerCase().includes('lote')?prodName(depois.produtoId||antes.produtoId):(depois.nome||antes.nome||'Medicamento');
  const titulo=ev.tipo.toLowerCase().includes('lote')?'Medicamento: '+medicamento+' | Lote: '+(depois.numero||antes.numero||'—'):'Medicamento: '+medicamento;
  const linhas=diferencasAuditoriaInventario(antes,depois);
  return titulo+'\n'+(linhas.length?linhas.join('\n'):'Nenhum campo alterado.');
 }catch(_){return detalhe;}
}
function abrirEditorInventario(tipo,itemId){
 if(!podeGerenciarInventario())return msg('Apenas o Administrador Principal pode editar o inventário.',true);
 const item=tipo==='produto'?produto(itemId):m().lotes.find(x=>x.id===itemId);
 if(!item)return msg('Registro não encontrado.',true);
 if(tipo==='lote'&&item.removido)return msg('Este lote já foi removido do inventário. Consulte a auditoria.',true);
 const p=tipo==='produto'?item:produto(item.produtoId);
 if(!p)return msg('Medicamento não encontrado.',true);
 const dlg=document.createElement('dialog');dlg.id='medInventarioDialog';
 const form=document.createElement('form');form.method='dialog';form.noValidate=true;
 const title=document.createElement('h3');title.textContent=tipo==='produto'?'✏️ Editar medicamento':'✏️ Editar lote — '+p.nome;form.append(title);
 const fields={};
 const field=(caption,key,val,kind='text')=>{const lab=document.createElement('label');lab.textContent=caption;const inp=document.createElement('input');inp.type=kind;inp.value=String(val??'');if(kind==='number'){inp.min='0';inp.step='any'}lab.append(inp);form.append(lab);fields[key]=inp;return inp};
 const choice=(caption,key,values,value)=>{const lab=document.createElement('label');lab.textContent=caption;const sel=document.createElement('select');values.forEach(x=>sel.add(new Option(x.label,x.value)));sel.value=value;lab.append(sel);form.append(lab);fields[key]=sel;return sel};
 if(tipo==='produto'){
  field('Nome comercial ou genérico','nome',item.nome);
  field('Apresentação / concentração','apresentacao',item.apresentacao);
  field('Local de armazenamento','local',item.local||'');
  const nota=document.createElement('p');nota.className='med-nota';nota.textContent='Tipo de embalagem e capacidade ficam preservados para não alterar a quantidade histórica dos lotes.';form.append(nota);
 }else{
  const utilizado=Number(item.recebido||0)>Number(item.quantidade||0)+0.0001||m().administracoes.some(a=>a.loteId===item.id);
  if(utilizado){
   const confirmarAlteracao=confirm('Lote com consumo registrado. Deseja realmente alterar este lote?');
   if(!confirmarAlteracao){dlg.remove();return;}
  }
  field('Número do lote','numero',item.numero);
  field('Validade','validade',item.validade,'date');
  field('Quantidade disponível ('+unidade(p)+')','quantidade',item.quantidade,'number');
  const notaSaldo=document.createElement('p');notaSaldo.className='med-nota';notaSaldo.textContent='Você pode ajustar o saldo disponível deste lote, inclusive para 0, sem apagar o histórico de consumo já registrado.';form.append(notaSaldo);
  field('Origem / observação','origem',item.origem||'');
  const pessoas=personMap().map(x=>({label:x.nome+' · quarto '+x.quarto,value:String(x.id)}));
  if(item.reservadoPessoaId&&!pessoas.some(x=>x.value===String(item.reservadoPessoaId)))pessoas.push({label:item.reservadoPessoaNome||'Acolhido desligado',value:String(item.reservadoPessoaId)});
  choice('Destinação','reserva',[{label:'Estoque compartilhado',value:''},...pessoas],String(item.reservadoPessoaId||''));
 }
 const buttons=document.createElement('div');buttons.className='med-inv-dialog-botoes';
 const cancel=document.createElement('button');cancel.type='button';cancel.className='med-cancelar';cancel.textContent='Cancelar';cancel.onclick=()=>dlg.close();
 const save=document.createElement('button');save.type='button';save.textContent='💾 Salvar alterações';
 save.onclick=()=>{
  if(!podeGerenciarInventario())return msg('Acesso administrativo não está ativo.',true);
  const current=tipo==='produto'?produto(itemId):m().lotes.find(x=>x.id===itemId);if(!current)return msg('Registro não encontrado.',true);
  if(tipo==='lote'&&current.removido)return msg('Lote removido: edição indisponível.',true);
  const before=structuredClone(current);const change={};
  if(tipo==='produto'){
   change.nome=clean(fields.nome.value);change.apresentacao=clean(fields.apresentacao.value);change.local=clean(fields.local.value);
   if(!change.nome||!change.apresentacao)return msg('Preencha o nome e a apresentação do medicamento.',true);
  }else{
   change.numero=clean(fields.numero.value);change.validade=fields.validade.value;change.quantidade=Number(fields.quantidade.value);change.recebido=current.recebido;change.origem=clean(fields.origem.value);change.reservadoPessoaId=fields.reserva.value;const pes=personMap().find(x=>String(x.id)===change.reservadoPessoaId);change.reservadoPessoaNome=change.reservadoPessoaId?(pes?.nome||current.reservadoPessoaNome||'Acolhido') : '';
   if(!change.numero||!/^\d{4}-\d{2}-\d{2}$/.test(change.validade)||!Number.isFinite(change.quantidade)||change.quantidade<0||(p.tipo!=='frasco'&&!Number.isInteger(change.quantidade)))return msg('Verifique lote, validade e saldo.',true);
  }
  if(!confirm('Confirma a alteração deste registro de inventário?'))return;
  snapshotAntes();Object.assign(current,change);registrarMudancaInventario(tipo==='produto'?'medicamento editado':'lote de medicamento editado',before,current);persist();renderAll();dlg.close();msg('Inventário atualizado com registro de auditoria.');
 };
 buttons.append(cancel,save);form.append(buttons);dlg.append(form);
 dlg.addEventListener('close',()=>dlg.remove());document.body.append(dlg);dlg.showModal();
}
function removerLoteInventario(itemId){
 if(!podeGerenciarInventario())return msg('Apenas o Administrador Principal pode remover lotes.',true);
 const lote=m().lotes.find(x=>x.id===itemId);
 if(!lote)return msg('Lote não encontrado.',true);
 if(lote.removido)return msg('Este lote já foi removido.',true);
 const medicamento=produto(lote.produtoId);
 const dlg=document.createElement('dialog');dlg.className='med-remover-lote-dialog';
 const frm=document.createElement('form');frm.method='dialog';
 const titulo=document.createElement('h3');titulo.textContent='📤 Remover lote do inventário';
 const descricao=document.createElement('p');descricao.textContent='Medicamento: '+(medicamento?.nome||'Não identificado')+' · Lote '+(lote.numero||'—')+' · Saldo atual: '+dec(lote.quantidade)+' '+unidade(medicamento)+'. A remoção não apagará o histórico de consumo.';
 const label=document.createElement('label');label.textContent='Justificativa da remoção';
 const motivo=document.createElement('select');motivo.required=true;motivo.add(new Option('Selecione a justificativa',''));
 ['Prazo / Validade','Fim da medicação','Demanda Desligada'].forEach(x=>motivo.add(new Option(x,x)));label.append(motivo);
 const aviso=document.createElement('p');aviso.className='med-nota';aviso.textContent='O lote deixará de aparecer no inventário e não poderá ser usado em novas administrações. Os dados originais e a ocorrência serão preservados na auditoria.';
 const botoes=document.createElement('div');botoes.className='med-remover-lote-acoes';
 const cancelar=document.createElement('button');cancelar.type='button';cancelar.textContent='Cancelar';cancelar.className='med-remover-lote-cancelar';cancelar.onclick=()=>dlg.close();
 const confirmar=document.createElement('button');confirmar.type='button';confirmar.textContent='Confirmar remoção';confirmar.className='med-remover-lote-confirmar';
 confirmar.onclick=()=>{
   if(!podeGerenciarInventario())return msg('Acesso administrativo encerrado.',true);
   if(!motivo.value){motivo.setCustomValidity('Selecione a justificativa da remoção.');motivo.reportValidity();return;}
   const atual=m().lotes.find(x=>x.id===itemId);
   if(!atual||atual.removido){dlg.close();return msg('Lote indisponível ou já removido.',true);}
   const antes=structuredClone(atual);
   snapshotAntes();
   atual.removido=true;
   atual.removidoEm=new Date().toISOString();
   atual.removidoPor=operator();
   atual.motivoRemocao=motivo.value;
   atual.saldoNaRemocao=Number(atual.quantidade)||0;
   event('lote removido do inventário',
      'Medicamento: '+prodName(atual.produtoId)+' | lote '+atual.numero+
      ' | justificativa: '+atual.motivoRemocao+
      ' | saldo removido: '+dec(atual.saldoNaRemocao)+' '+unidade(medicamento)+
      ' | validade '+fmt(atual.validade)+
      ' | destinação: '+nomeReserva(atual)+
      ' | saldo recebido originalmente: '+dec(Number(antes.recebido)||0)+' '+unidade(medicamento),
      {pessoaId:atual.reservadoPessoaId||'',pessoaNome:atual.reservadoPessoaNome||''});
   persist();renderAll();window.__atualizarNotificacoesV24?.();dlg.close();msg('Lote removido do inventário. Justificativa e histórico preservados na auditoria.');
 };
 motivo.onchange=()=>motivo.setCustomValidity('');
 botoes.append(cancelar,confirmar);frm.append(titulo,descricao,label,aviso,botoes);dlg.append(frm);
 dlg.addEventListener('close',()=>dlg.remove());document.body.append(dlg);dlg.showModal();
}
function excluirInventario(tipo,itemId){
 if(tipo==='lote')return removerLoteInventario(itemId);
 if(!podeGerenciarInventario())return msg('Apenas o Administrador Principal pode excluir registros do inventário.',true);
 const item=produto(itemId);
 if(!item)return msg('Registro não encontrado.',true);
 if(m().lotes.some(l=>l.produtoId===item.id)||m().prescricoes.some(x=>x.produtoId===item.id)||m().administracoes.some(x=>x.produtoId===item.id))return msg('Não é possível excluir medicamento com lotes, prescrições ou administrações vinculados.',true);
 if(!confirm('EXCLUIR cadastro do medicamento? A ação será registrada na auditoria.'))return;
 if(!podeGerenciarInventario())return msg('Acesso administrativo encerrado.',true);
 const before=structuredClone(item);snapshotAntes();const i=m().produtos.findIndex(x=>x.id===itemId);if(i<0)return;
 m().produtos.splice(i,1);registrarMudancaInventario('medicamento excluído',before,{excluido:true});persist();renderAll();msg('Cadastro excluído. Operação registrada na auditoria.');
}

function renderStock(){
 const tbody=$('medListaEstoque');tbody.replaceChildren();const now=today();
 for(const p of m().produtos){
  const ls=m().lotes.filter(l=>l.produtoId===p.id&&!l.removido);
  if(!ls.length&&m().lotes.some(l=>l.produtoId===p.id&&l.removido))continue;
  for(const l of ls.length?ls:[null]){
   const tr=tbody.insertRow(),q=Number(l?.quantidade||0);
   cell(tr,p.nome+' · '+p.apresentacao+' | '+(p.tipo==='frasco'?'Frasco '+dec(p.mlPorFrasco)+' mL':'Cartela '+dec(p.unidadesPorCartela||1)+' un'));
   cell(tr,p.local||'—');cell(tr,l?.numero||'Sem lote');
   const tdDestino=cell(tr,l?nomeReserva(l):'—');
   tdDestino.className=l?(destinoLote(l)?'med-lote-reservado':'med-lote-compartilhado'):'';
   if(l&&destinoLote(l)&&!personMap().some(x=>x.id===destinoLote(l))){tdDestino.title='Acolhido fora do cadastro ativo; a reserva permanece protegida.';}
   const val=cell(tr,fmt(l?.validade));const qtd=cell(tr,dec(q)+' '+unidade(p));
   const delta=l?.validade?Math.round((new Date(l.validade+'T12:00:00')-new Date(now+'T12:00:00'))/86400000):Infinity;
   const vcl=delta<0?'med-validade-vermelho':delta<=7?'med-validade-laranja':delta<=30?'med-validade-amarelo':'';
   if(vcl)val.classList.add(vcl);
   const diario=dailyConsumption(p.id);
   const perDay=diario>0&&q<=diario;
   const baixo=p.tipo==='frasco'?(diario>0&&q<=diario):q<=6;
   if(perDay)qtd.classList.add('med-qtd-vermelho');else if(baixo)qtd.classList.add('med-qtd-laranja');else qtd.classList.add('med-qtd-ok');
   const td=tr.insertCell();td.textContent=(delta<0?'VENCIDO':delta<=7?'Vence em '+delta+' dia(s)':delta<=30?'Vencimento próximo':'Validade regular')+' · '+(perDay?'Saldo para até 1 dia':baixo?'Estoque baixo':'Saldo normal')+' · '+(l&&destinoLote(l)?'uso exclusivo':'uso compartilhado');
   const act=tr.insertCell();act.className='med-estoque-acoes';
   if(podeGerenciarInventario()){
     const editP=btn('✏️ Medicamento',()=>abrirEditorInventario('produto',p.id));editP.title='Editar cadastro do medicamento';act.append(editP);
     if(l){const editL=btn('✏️ Lote',()=>abrirEditorInventario('lote',l.id));editL.title='Editar lote';act.append(editL);
       const delL=btn('📤 Remover lote',()=>removerLoteInventario(l.id));delL.className='med-excluir';delL.title='Remover lote do estoque com justificativa, sem excluir o histórico';act.append(delL);
     }else{
       const delP=btn('🗑️ Medicamento',()=>excluirInventario('produto',p.id));delP.className='med-excluir';act.append(delP);
     }
   }else act.textContent='—';

  }
 }
 if(!tbody.rows.length){const r=tbody.insertRow();const td=r.insertCell();td.colSpan=8;td.textContent='Nenhum medicamento cadastrado.'}
}
function renderEvents(){const tbody=$('medListaEventos');tbody.replaceChildren();for(const ev of [...m().movimentos].slice(-500).reverse()){const tr=tbody.insertRow();cell(tr,new Date(ev.at).toLocaleString('pt-BR'));cell(tr,ev.operador);cell(tr,ev.tipo);const detalhes=cell(tr,formatarDetalheHistoricoMedicamentos(ev));detalhes.classList.add('med-auditoria-detalhes')}if(!tbody.rows.length)tbody.insertRow().insertCell().textContent='Nenhum evento registrado.'}
function renderAll(){if(!state)return;renderPeople();renderProducts();updateEntry();updatePrescription();renderAgenda();renderPrescriptions();renderStock();renderEvents()}
window.__atualizarModuloMedicamentos=renderAll;
$('medAtualizar').onclick=renderAll;$('medData').onchange=renderAgenda;$('medFiltro').onchange=renderAgenda;
document.querySelectorAll('[data-med-tab]').forEach(button=>button.onclick=()=>{const tab=button.dataset.medTab;document.querySelectorAll('[data-med-tab]').forEach(b=>b.classList.toggle('med-selected',b===button));for(const [name,elm] of Object.entries({agenda:'medAgenda',prescricoes:'medPrescricoes',estoque:'medEstoque',auditoria:'medAuditoria'}))$(elm).hidden=name!==tab;renderAll()});
$('medData').value=today();$('medInicio').value=today();updatePresentation();updateEntry();alterarDestinacaoLote();updatePrescription();
document.querySelector('[data-abd-nav="medicamentos"]')?.addEventListener('click',()=>renderAll());
window.addEventListener('focus',()=>{if(document.body.dataset.abdPageActive==='medicamentos')renderAll()});
window.renderMedicamentosV24=renderAll;
renderAll();
})();
