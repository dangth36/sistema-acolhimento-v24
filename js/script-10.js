
(function(){
  'use strict';
  const body=document.body;
  const titles={
    painel:['Painel geral','Indicadores, ações rápidas e situação da unidade'],
    quartos:['Quartos e áreas','Cartões de quartos, filtros e cadastros completos'],
    mapa:['Mapa de ocupação','Localize um quarto pelo mapa visual da unidade'],
    funcionarios:['Gestão de funcionários','Plantonistas administrativos e vigilantes'],
    acesso:['Controle de entrada e saída','Registro de horários e autorizações'],
    historico:['Histórico de acolhimentos','Pesquisa de passagens anteriores'],
    auditoria:['Auditoria','Histórico de alterações e ações administrativas'],
    medicamentos:['Controle de medicamentos','Estoque, prescrições, horários e administração'],
    arquivos:['Arquivos e backups','Listas, planilhas, arquivos ODT e cópias de segurança']
  };
  const assign=(selector,group)=>document.querySelectorAll(selector).forEach(el=>{
    if(el.parentElement===body)el.dataset.abdPage=group;
  });
  assign('#abdPainelGeral, .status-cadastros-linha','painel');
  assign('#filtroQuartos, .modo-quartos-toolbar, #areas','quartos');
  assign('#abdMapaQuartos','mapa');
  assign('#painelConfiguracaoRelacao','arquivos');
  assign('body > .hidden-area','funcionarios');
  assign('#controleEntradaSaidaPanel','acesso');
  assign('#historicoPanel','historico');
  assign('body > header, body > .backup-panel, #pastaODTInfo','arquivos');
  assign('#v24TrocaAtualizacoes','arquivos');
  assign('#abdPaginaAuditoria','auditoria');
  const sidebar=document.querySelector('.abd-sidebar');
  const menubtn=document.getElementById('abdAlternarMenu');
  document.querySelectorAll('[data-abd-nav]').forEach(btn=>{
    // Os ícones e os textos já estão separados no HTML. Não dividir novamente.
    const icon=btn.querySelector(':scope > .abd-nav-icon');
    const text=btn.querySelector(':scope > .abd-nav-label');
    if(!icon || !text){
      const label=btn.textContent.trim();const i=label.indexOf(' ');
      if(i>0){
        btn.textContent='';
        const ico=document.createElement('span');ico.className='abd-nav-icon';ico.textContent=label.slice(0,i);
        const nome=document.createElement('span');nome.className='abd-nav-label';nome.textContent=label.slice(i+1);
        btn.append(ico,nome);
      }
    }
    btn.title=btn.querySelector('.abd-nav-label')?.textContent.trim()||btn.textContent.trim();
    btn.setAttribute('aria-label',btn.title);
  });
  function expandirMenu(fechado){
    body.classList.toggle('abd-menu-fechado',fechado);
    menubtn.setAttribute('aria-expanded',String(!fechado));
    menubtn.setAttribute('aria-label',fechado?'Abrir menu lateral':'Recolher menu lateral');
    menubtn.title=fechado?'Abrir menu lateral':'Recolher menu lateral';
    try{localStorage.setItem('acolhimento_abd_menu_fechado',fechado?'1':'0')}catch(_){}
  }
  menubtn?.addEventListener('click',()=>expandirMenu(!body.classList.contains('abd-menu-fechado')));
  try{expandirMenu(localStorage.getItem('acolhimento_abd_menu_fechado')==='1')}catch(_){expandirMenu(false)}
  function mudarPagina(page,opts={}){
    if(!titles[page])page='painel';
    if(page==='quartos' && typeof modoQuartosAtual!=='undefined' && modoQuartosAtual==='mapa' && typeof definirModoQuartos==='function')definirModoQuartos('cartoes');
    body.dataset.abdPageActive=page;
    body.classList.add('abd-pages-ready');
    document.querySelectorAll('[data-abd-nav]').forEach(btn=>{
      const active=btn.dataset.abdNav===page;
      btn.classList.toggle('abd-selected',active);
      btn.setAttribute('aria-current',active?'page':'false');
    });
    const heading=document.getElementById('abdTituloPagina');
    if(heading){heading.querySelector('h2').textContent=titles[page][0];heading.querySelector('p').textContent=titles[page][1]}
    if(page==='mapa'){
      if(typeof window.atualizarLayoutABD==='function')window.atualizarLayoutABD();
      else if(typeof atualizarLayoutABD==='function')atualizarLayoutABD();
    }
    if(page==='acesso'){
      const panel=document.getElementById('controleEntradaSaidaPanel');
      panel?.classList.add('aberto');
      if(typeof renderControleEntradaSaida==='function')renderControleEntradaSaida();
    }
    if(page==='historico'){
      document.getElementById('historicoPanel')?.classList.add('aberto');
      if(typeof pesquisarHistorico==='function')pesquisarHistorico();
    }
    if(!opts.noSave){try{localStorage.setItem('acolhimento_abd_pagina',page)}catch(_){}}
    if(!opts.noScroll)window.scrollTo({top:0,behavior:'instant'});
  }
  // Capture impede a implementação antiga baseada em scrollIntoView.
  sidebar?.addEventListener('click',function(e){
    const target=e.target.closest('[data-abd-nav]');
    if(!target)return;
    e.preventDefault();e.stopImmediatePropagation();
    mudarPagina(target.dataset.abdNav);
  },true);
  // Se os antigos atalhos forem usados, troca-se de aba sem esconder o resultado.
  document.getElementById('btnAbrirControleEntradaSaida')?.addEventListener('click',e=>{e.stopImmediatePropagation();mudarPagina('acesso')},true);
  document.getElementById('btnAbrirHistorico')?.addEventListener('click',()=>mudarPagina('historico'),true);
  document.getElementById('abdAbrirAuditoria')?.addEventListener('click',()=>document.getElementById('authAuditBtn')?.click());
  // O mapa e os cartões devem permitir voltar ao cadastro detalhado.
  document.getElementById('abdMapaQuartos')?.addEventListener('click',e=>{
    if(e.target.closest('.abd-map-cell'))mudarPagina('quartos');
  },true);
  for(const [id,mode] of [['modoQuartosCartoes','quartos'],['modoQuartosDetalhes','quartos'],['modoQuartosMapa','mapa']]){
    document.getElementById(id)?.addEventListener('click',()=>mudarPagina(mode),true);
  }
  const inicial=(()=>{try{return localStorage.getItem('acolhimento_abd_pagina')||'painel'}catch(_){return 'painel'}})();
  mudarPagina(inicial,{noSave:true,noScroll:true});
  window.abrirAbaAcolhimento=mudarPagina;
})();
