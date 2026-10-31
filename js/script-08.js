
(function(){
 let pastaAtual=null,arquivoAtual='';
 const el=id=>document.getElementById(id);
 function abrirConfirmacaoArquivoGerado(tipo,nome,pasta){
  pastaAtual=pasta||null; arquivoAtual=String(nome||'');
  el('tituloArquivoGerado').textContent='✅ '+tipo+' Gerado'+(tipo==='Backup'?'':'a');
  el('nomeArquivoGerado').textContent=arquivoAtual;
  el('descricaoArquivoGerado').textContent=pastaAtual?'Arquivo salvo na pasta autorizada: '+pastaAtual.name:'Download iniciado. O navegador não informa qual pasta recebeu o arquivo.';
  el('btnVisualizarPastaGerada').hidden=!pastaAtual;
  el('exploradorArquivoGerado').hidden=true;
  el('listaExploradorArquivoGerado').replaceChildren();
  el('modalArquivoGerado').classList.add('aberto');
 }
 async function listarPastaGerada(){
  if(!pastaAtual)return;
  const lista=el('listaExploradorArquivoGerado');
  el('exploradorArquivoGerado').hidden=false;
  el('tituloExploradorArquivoGerado').textContent='📁 '+pastaAtual.name;
  lista.textContent='Consultando arquivos...';
  try{
   const status=await pastaAtual.queryPermission({mode:'read'});
   if(status!=='granted'){lista.textContent='O navegador precisa de autorização para consultar novamente esta pasta. Selecione a pasta no botão Local correspondente.';return;}
   const itens=[];
   for await (const [nome,handle] of pastaAtual.entries())itens.push({nome,tipo:handle.kind});
   itens.sort((a,b)=>(a.nome===arquivoAtual?-1:b.nome===arquivoAtual?1:a.nome.localeCompare(b.nome,'pt-BR')));
   lista.replaceChildren();
   if(!itens.length){lista.textContent='Pasta vazia.';return;}
   for(const item of itens){
    const linha=document.createElement('div');linha.className='arquivo-gerado-linha'+(item.nome===arquivoAtual?' destaque':'');
    const icone=document.createElement('span');icone.textContent=item.tipo==='directory'?'📁':'📄';
    const nome=document.createElement('span');nome.textContent=item.nome+(item.nome===arquivoAtual?'  ✓ Arquivo recém-gerado':'');
    linha.append(icone,nome);lista.appendChild(linha);
   }
  }catch(err){lista.textContent='Não foi possível listar a pasta: '+(err?.message||err);}
 }
 el('btnVisualizarPastaGerada').addEventListener('click',listarPastaGerada);
 el('btnFecharArquivoGerado').addEventListener('click',()=>el('modalArquivoGerado').classList.remove('aberto'));
 window.confirmarArquivoGerado=abrirConfirmacaoArquivoGerado;
})();
