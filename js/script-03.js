
(function(){
'use strict';
const dialog=document.getElementById('cadastroAcessoDialog');
const form=document.getElementById('cadastroAcessoForm');
const botao=document.getElementById('btnCriarCadastroAcesso');
if(!dialog||!form||!botao)return;
function vagasParaCadastro(room){
 if(!room || room.status==='indisponivel')return 0;
 const capacidade=capacidadeEfetivaRoom(room);
 // O cadastro preenche uma vaga existente; linhas vazias não são ocupantes.
 const ocupadas=contarOcupantes(room);
 return Math.max(0,capacidade-ocupadas);
}
function atualizarQuartosCadastro(){
 const select=form.elements.namedItem('quarto');
 const anterior=select.value;
 select.replaceChildren();
 Object.values(state.rooms).sort((a,b)=>Number(a.numero)-Number(b.numero)).forEach(room=>{
  const vagas=vagasParaCadastro(room);
  if(!vagas)return;
  const option=document.createElement('option');
  option.value=String(room.numero);
  option.textContent='Quarto '+room.numero+' — '+(room.tipoQuarto||'')+' — '+vagas+' vaga(s)';
  select.appendChild(option);
 });
 if(anterior && Array.from(select.options).some(o=>o.value===anterior)) select.value=anterior;
 if(!select.options.length){
  const option=document.createElement('option');
  option.value=''; option.textContent='Nenhum quarto com vagas disponíveis';
  select.appendChild(option);
  return false;
 }
 return true;
}
botao.addEventListener('click',function(){
 form.reset();
 if(!atualizarQuartosCadastro()){alert('Não há quartos disponíveis com vagas para cadastro.');return;}
 dialog.showModal();
});
// Reconsulta o estado das áreas quando o usuário abre o seletor.
form.elements.namedItem('quarto').addEventListener('focus',atualizarQuartosCadastro);
form.elements.namedItem('quarto').addEventListener('pointerdown',atualizarQuartosCadastro);
document.getElementById('cadastroAcessoCancelar').addEventListener('click',()=>dialog.close());
form.addEventListener('submit',function(ev){
 ev.preventDefault();
 const data=Object.fromEntries(new FormData(form).entries());
 const room=state.rooms[data.quarto];
 if(!room || vagasParaCadastro(room)<1){alert('O quarto selecionado não possui mais vagas. Escolha outro quarto.');return;}
 const nome=String(data.nome||'').trim();
 if(!nome){alert('Informe o nome da pessoa.');return;}
 if(data.entrada && data.saida && data.saida<data.entrada){alert('A data de saída não pode ser anterior à entrada.');return;}
 const p=pessoaVazia();
 ['nascimento','genero','cpf','identidade','cartaoSus','origemNacionalidade','responsavel','entrada','saida','observacao','necessidadeAcessibilidade'].forEach(k=>p[k]=String(data[k]||'').trim());
 p.nome=nome;
 p.advertencia=Math.min(10,Math.max(0,Number(data.advertencia)||0));
 p.acessibilidade=data.acessibilidade==='sim';
 snapshotAntes();
 const livre=(room.pessoas||[]).findIndex(x=>!pessoaOcupada(x));
 if(livre>=0)room.pessoas[livre]=p; else room.pessoas.push(p);
 salvarNoStorage();
 dialog.close();
 render();
 if(typeof agendarIndicacaoSalvo==='function')agendarIndicacaoSalvo();
});

})();
