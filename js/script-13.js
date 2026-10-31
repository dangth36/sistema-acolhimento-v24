
(function(){'use strict';
 const bar=document.getElementById('authToolbar');if(!bar||document.getElementById('abdNotificacoesBtn'))return;
 const btn=document.createElement('button');btn.type='button';btn.id='abdNotificacoesBtn';btn.title='Notificações pendentes';btn.setAttribute('aria-label','Notificações pendentes');btn.setAttribute('aria-expanded','false');
 btn.innerHTML='<svg class="abd-notif-sino" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 12c-7 0-12 5-12 12v3C25 32 22 44 22 59v13c0 5-3 9-7 12-2 2-1 5 2 5h66c3 0 4-3 2-5-4-3-7-7-7-12V59c0-15-3-27-16-32v-3c0-7-5-12-12-12z"/><path d="M40 91h20c-1 7-5 9-10 9s-9-2-10-9z"/></svg><span class="abd-notif-contador" hidden></span>';
 const sair=document.getElementById('abdSairTopo');bar.insertBefore(btn,sair||null);
 const painel=document.createElement('section');painel.id='abdNotificacoesPainel';painel.hidden=true; painel.setAttribute('aria-label','Centro de notificações');painel.innerHTML='<div class="abd-notif-header"><strong>🔔 Notificações pendentes</strong><button type="button" id="abdNotifFechar" aria-label="Fechar notificações">✕</button></div><div id="abdNotifLista"></div>';
 document.body.appendChild(painel);
 const counter=btn.querySelector('.abd-notif-contador');let ultimoConjunto=new Set();let inicializou=false;
 const dataLocal=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
 const horaLocal=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
 const hoje=()=>dataLocal(new Date());
 const nomeProd=(m,id)=>{const p=(m.produtos||[]).find(x=>String(x.id)===String(id));return p?p.nome+' · '+p.apresentacao:'Medicamento';};
 const agendaPara=(rx,date)=>{
  if(!rx.inicio||date<rx.inicio||(rx.fim&&date>rx.fim)||rx.usoLivre)return [];
  const horas=String(rx.horaInicio||'');const intervalo=Number(rx.intervalo);
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(horas)||!Number.isFinite(intervalo)||intervalo<=0)return (rx.horarios||[]).filter(h=>date!==rx.inicio||h>=horas);
  const inicial=Date.parse(rx.inicio+'T00:00:00Z')+(Number(horas.slice(0,2))*60+Number(horas.slice(3)))*60000;
  const inicioDia=Date.parse(date+'T00:00:00Z');const passo=Math.round(intervalo*60)*60000;
  if(!Number.isFinite(inicial)||!Number.isFinite(inicioDia)||passo<=0)return [];
  const n=Math.max(0,Math.ceil((inicioDia-inicial)/passo));const result=[];
  for(let k=n;k<n+72;k++){const t=inicial+k*passo;if(t>=inicioDia+86400000)break;if(t<inicioDia)continue;if(rx.fimHora&&rx.fim&&t>Date.parse(rx.fim+'T'+rx.fimHora+':00Z'))break;const mins=Math.round((t-inicioDia)/60000);result.push(String(Math.floor(mins/60)).padStart(2,'0')+':'+String(mins%60).padStart(2,'0'));}return result;
 };
 function calcular(){
  const result=[];const st=typeof state==='object'&&state?state:null;if(!st)return result;
  const m=st.medicamentos||{};const now=new Date(),date=hoje(),time=horaLocal(now);
  const ativos=new Map();for(const room of Object.values(st.rooms||{})){for(const p of room?.pessoas||[]){if(p&&p.id!=null&&p.nome&&!p.saida)ativos.set(String(p.id),{nome:p.nome,quarto:room.numero});}}
  for(const rx of m.prescricoes||[]){
   if(!rx.ativa||rx.usoLivre||!ativos.has(String(rx.pessoaId)))continue;
   for(const h of agendaPara(rx,date)){
    if(h>time)continue;
    const chave=String(rx.id)+'|'+date+'|'+h;
    if((m.administracoes||[]).some(a=>String(a.chave)===chave||(String(a.prescricaoId)===String(rx.id)&&a.data===date&&a.hora===h&&!a.usoLivre)))continue;
    const pessoa=ativos.get(String(rx.pessoaId));
    result.push({id:'dose:'+chave,icon:'💊',title:'Medicação pendente · '+h,desc:pessoa.nome+' · quarto '+pessoa.quarto+' · '+nomeProd(m,rx.produtoId),tab:'agenda'});
   }
  }
  function medConsumoDiarioNotificacao(med,produtoId){
   let total=0;
   for(const rx of med.prescricoes||[]){
    if(!rx.ativa||String(rx.produtoId)!==String(produtoId))continue;
    const dose=Number(rx.consumo)||0;
    if(rx.usoLivre){total+=dose*(Number(rx.vezes)||0)}
    else{total+=dose*(Array.isArray(rx.horarios)?rx.horarios.length:0)}
   }
   return total;
  }
  for(const lot of m.lotes||[]){
   if(lot.removido||Number(lot.quantidade)<=0)continue;
   const prod=(m.produtos||[]).find(p=>String(p.id)===String(lot.produtoId));if(!prod)continue;
   const val=lot.validade||'';
   if(val){const dias=Math.round((Date.parse(val+'T12:00:00')-Date.parse(date+'T12:00:00'))/86400000);
    if(dias<=30){const status=dias<0?'Vencido':dias===0?'Vence hoje':dias<=7?'Validade urgente':'Validade próxima';
    result.push({id:'validade:'+lot.id,icon:'📅',title:status,desc:prod.nome+' · lote '+(lot.numero||'—')+' · '+(dias<0?'vencido há '+Math.abs(dias)+' dia(s)':dias+' dia(s) restantes'),tab:'estoque'});}
   }
   const qtd=Number(lot.quantidade)||0,consumoDiario=medConsumoDiarioNotificacao(m,prod.id),baixo=prod.tipo==='frasco'?(consumoDiario>0&&qtd<=consumoDiario):qtd<=6;
   if(baixo){result.push({id:'estoque:'+lot.id,icon:'📦',title:'Estoque baixo',desc:prod.nome+' · lote '+(lot.numero||'—')+' · saldo '+qtd+' '+(prod.tipo==='frasco'?'mL':'un'),tab:'estoque'});}
  }
  for(const room of Object.values(st.rooms||{}))for(const p of room?.pessoas||[]){
   if(!p||!p.id||p.saida)continue;const ocorrencia=st.controleEntradaSaida?.[p.id]?.ocorrenciaChave;
   if(ocorrencia?.ativa)result.push({id:'chave:'+p.id,icon:'🔑',title:'Chave — '+(ocorrencia.tipo||'quebra/extravio'),desc:p.nome+' · quarto '+room.numero,tab:'chaves'});
  }
  return result;
 }
 function atualizar(){
  if(document.documentElement.classList.contains('abd-cofre-bloqueado'))return;
  let lista;try{lista=calcular()}catch(e){return;}
  const conjunto=new Set(lista.map(x=>x.id));
  if(inicializou&&lista.some(x=>!ultimoConjunto.has(x.id))){btn.classList.remove('abd-notif-chegou');void btn.offsetWidth;btn.classList.add('abd-notif-chegou');}
  inicializou=true;ultimoConjunto=conjunto;counter.hidden=!lista.length;counter.textContent=lista.length>99?'99+':String(lista.length);btn.setAttribute('aria-label',lista.length+' notificações pendentes');
  if(!painel.hidden){const box=document.getElementById('abdNotifLista');box.replaceChildren();if(!lista.length){const p=document.createElement('div');p.className='abd-notif-vazio';p.textContent='Nenhuma notificação pendente.';box.appendChild(p);return;}
   for(const item of lista){const b=document.createElement('button');b.type='button';b.className='abd-notif-item';const icon=document.createElement('span');icon.textContent=item.icon;const detail=document.createElement('span');const strong=document.createElement('strong');strong.textContent=item.title;const small=document.createElement('small');small.textContent=item.desc;detail.append(strong,small);b.append(icon,detail);b.addEventListener('click',()=>{
    painel.hidden=true;btn.setAttribute('aria-expanded','false');const tab=item.tab==='chaves'?'acesso':'medicamentos';document.querySelector('[data-abd-nav="'+tab+'"]')?.click();if(tab==='medicamentos'){document.querySelector('[data-med-tab="'+item.tab+'"]')?.click();if(item.tab==='agenda'){const d=document.getElementById('medData');if(d)d.value=hoje();window.renderMedicamentosV24?.();}}
   });box.appendChild(b);}
  }
 }
 btn.addEventListener('click',e=>{e.stopPropagation();painel.hidden=!painel.hidden;btn.setAttribute('aria-expanded',String(!painel.hidden));atualizar()});
 document.getElementById('abdNotifFechar').addEventListener('click',()=>{painel.hidden=true;btn.setAttribute('aria-expanded','false')});
 document.addEventListener('pointerdown',e=>{if(!painel.hidden&&!painel.contains(e.target)&&!btn.contains(e.target)){painel.hidden=true;btn.setAttribute('aria-expanded','false')}});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!painel.hidden){painel.hidden=true;btn.setAttribute('aria-expanded','false')}});
 window.addEventListener('focus',atualizar);document.addEventListener('visibilitychange',()=>{if(!document.hidden)atualizar()});
 setInterval(()=>{if(!document.hidden)atualizar()},30000);
 window.__atualizarNotificacoesV24=atualizar;
 atualizar();
})();
