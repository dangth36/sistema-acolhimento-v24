
(function(){
'use strict';
const dialog=document.getElementById('cadastroAnteriorDialog');
const form=document.getElementById('cadastroAnteriorForm');
const abrir=document.getElementById('btnCriarCadastroAnterior');
if(!dialog||!form||!abrir)return;
function hojeLocal(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
abrir.addEventListener('click',()=>{
 form.reset();
 const select=form.elements.namedItem('quarto');select.replaceChildren();
 Object.values(state.rooms||{}).sort((a,b)=>Number(a.numero)-Number(b.numero)).forEach(room=>{
  const opt=document.createElement('option');opt.value=String(room.numero);opt.textContent='Quarto '+room.numero+' — '+(room.tipoQuarto||'');select.appendChild(opt);
 });
 if(!select.options.length){alert('Não há quartos cadastrados.');return;}
 const hoje=hojeLocal();form.elements.namedItem('entrada').max=hoje;form.elements.namedItem('saida').max=hoje;
 dialog.showModal();
});
document.getElementById('cadastroAnteriorCancelar').addEventListener('click',()=>dialog.close());
form.addEventListener('submit',ev=>{
 ev.preventDefault();
 const data=Object.fromEntries(new FormData(form).entries());
 const room=state.rooms[data.quarto];
 const nome=String(data.nome||'').trim();
 const entrada=String(data.entrada||'');const saida=String(data.saida||'');
 const hoje=hojeLocal();
 if(!nome||!room){alert('Informe o nome e o quarto utilizado.');return;}
 if(!entrada||!saida||entrada>saida||entrada>hoje||saida>hoje){alert('Informe datas anteriores ou até hoje, com a saída igual ou posterior à entrada.');return;}
 const p=pessoaVazia();
 ['nascimento','genero','cpf','identidade','cartaoSus','origemNacionalidade','responsavel','entrada','saida','observacao','necessidadeAcessibilidade'].forEach(k=>p[k]=String(data[k]||'').trim());
 p.nome=nome;p.advertencia=Math.min(10,Math.max(0,Number(data.advertencia)||0));p.acessibilidade=data.acessibilidade==='sim';
 const chave=[p.id||'',entrada,saida,nome].join('|');
 const duplicado=acolhimentosHistorico.some(h=>normalizarBuscaHistorico(h.nome)===normalizarBuscaHistorico(nome)&&h.entrada===entrada&&h.saida===saida&&String(h.quarto)===String(room.numero));
 if(duplicado&&!confirm('Já existe um registro com mesmo nome, quarto e período. Deseja cadastrar outra passagem mesmo assim?'))return;
 try{
  snapshotAntes();
  if(!criarRegistroHistoricoAcolhimento(room,p))throw new Error('Não foi possível registrar a passagem anterior.');
  dialog.close();
  if(typeof pesquisarHistorico==='function')pesquisarHistorico();
  if(typeof setStatus==='function')setStatus('✓ Cadastro anterior salvo exclusivamente no Histórico de Acolhimentos.');
 }catch(error){alert(error.message||'Erro ao salvar cadastro anterior.');}
});
})();
