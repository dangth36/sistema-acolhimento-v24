
'use strict';

/* ============================================================
   SISTEMA OFFLINE ROBUSTO
   - Estado estruturado em JSON (não salva HTML inteiro)
   - Histórico persistente de desfazer/refazer
   - Validação de capacidade
   - Backup versionado com metadados
   - Migração opcional do formato antigo
   ============================================================ */

const STORAGE_KEY = 'sistema_plantao_dados_v2';
const HISTORY_KEY = 'sistema_plantao_historico_v2';
const LAST_BACKUP_KEY = 'sistema_plantao_ultimo_backup_v2';
const SCHEMA_VERSION = 2;
const MAX_HISTORY = 30;
const UNDO_WINDOW_MS = 60 * 60 * 1000;

const ROOM_GROUPS = {
    feminina: [121,122,123,125,126,127,130,131,132,133,134],
    idoso: [101,102,103,104,105,106],
    masculina: [113,114,115,116,117,118,119,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150]
};

const FUNCOES_PLANTONISTA = [
    '',
    'Aux. Serv. Sociais',
    'Aux. Serv. Gerais',
    'Cuidador Social',
    'Educador Social',
    'Assist. Social',
    'Cozinheiro(a)',
    'Coordenador',
    'Psicologo'
];

let state = null;
let history = [];
let future = [];
let autosaveTimer = null;
let pendingConfig = null;

function uid(prefix='id'){
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
}

function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }

function tipoQuartoPadrao(ala){
    return ala==='feminina' ? 'Feminino' : ala==='idoso' ? 'Idoso' : 'Masculino';
}

const TIPOS_QUARTO = ['Feminino','Masculino','Idoso','VEPEMA','Trans','Outro'];

function defaultRoom(num, ala){
    let tipo = 'beliche', capacidadePadrao = 2, descricao = '';
    if(ala === 'feminina'){ tipo='solteiro'; capacidadePadrao=2; descricao=''; }
    if(ala === 'idoso'){ tipo='beliche'; capacidadePadrao=1; descricao=''; }
    return {
        id: String(num), numero: num, ala, tipoQuarto:tipoQuartoPadrao(ala), status:'disponivel', tipo,
        capacidadePadrao, capacidadeExcedente:0, capacidade:capacidadePadrao,
        descricao, pessoas:[]
    };
}

function pessoaVazia(){
    return {id:uid('p'), nome:'', cpf:'', cartaoSus:'', genero:'', acessibilidade:false, necessidadeAcessibilidade:'', origemNacionalidade:'', nomeDemanda:'', observacao:'', responsavel:'', responsavelId:'', nascimento:'', entrada:'', saida:'', advertencia:0, idadeManual:null};
}

function pessoaOcupada(p){
    return !!(p && [p.nome,p.nascimento,p.entrada,p.saida].some(v=>String(v||'').trim()));
}
// Remove apenas cadastros realmente vazios que estão acima de um acolhido ativo.
// Não apaga registros desligados, campos parcialmente preenchidos nem o histórico.
function cadastroTotalmenteVazio(p){
    if(!p)return true;
    const campos=['nome','cpf','cartaoSus','genero','necessidadeAcessibilidade','origemNacionalidade',
        'nomeDemanda','observacao','responsavel','responsavelId','nascimento','entrada','saida',
        'identidade','origem','nacionalidade'];
    return !campos.some(c=>String(p[c]??'').trim()) && !p.acessibilidade &&
        !(Number(p.advertencia)||0) && (p.idadeManual===null || p.idadeManual===undefined || p.idadeManual==='');
}
function compactarPrimeiroCadastroVazio(room){
    if(!Array.isArray(room?.pessoas) || room.pessoas.length<2)return false;
    if(!room.pessoas.some(p=>pessoaOcupada(p) && !String(p.saida||'').trim()))return false;
    let mudou=false;
    while(room.pessoas.length>1 && cadastroTotalmenteVazio(room.pessoas[0])){
        room.pessoas.shift();
        mudou=true;
    }
    return mudou;
}
function contarOcupantes(room){ return (room?.pessoas||[]).filter(p => pessoaOcupada(p) && !String(p?.saida||'').trim()).length; }

function capacidadePadraoRoom(room){
    const valor=Number(room?.capacidadePadrao);
    if(Number.isFinite(valor) && valor>=0) return Math.floor(valor);
    return Math.max(0,Math.floor(Number(room?.capacidade)||0));
}
function capacidadeExcedenteRoom(room){
    const valor=Number(room?.capacidadeExcedente);
    return Number.isFinite(valor) && valor>=0 ? Math.floor(valor) : 0;
}
function capacidadeEfetivaRoom(room){
    if(!room || room.status==='indisponivel') return 0;
    return capacidadePadraoRoom(room)+capacidadeExcedenteRoom(room);
}
function sincronizarCapacidadeRoom(room){
    if(!room) return;
    room.capacidade=room.status==='indisponivel' ? 0 : capacidadeEfetivaRoom(room);
}

function criarEstadoInicial(){
    const rooms = {};
    ROOM_GROUPS.feminina.forEach(n=>rooms[n]=defaultRoom(n,'feminina'));
    rooms[128] = {id:'128',numero:128,ala:'feminina',status:'indisponivel',tipo:'solteiro',
        capacidadePadrao:0,capacidadeExcedente:0,capacidade:0,descricao:'Quarto de descanso dos Funcionários',pessoas:[]};
    ROOM_GROUPS.idoso.forEach(n=>rooms[n]=defaultRoom(n,'idoso'));
    ROOM_GROUPS.masculina.forEach(n=>rooms[n]=defaultRoom(n,'masculina'));

    // Novas instalações começam sem informações pessoais embutidas no HTML.
    // Registros existentes serão importados exclusivamente do armazenamento criptografado.
    const indisponivel=(num,descricao)=>{rooms[num].status='indisponivel';rooms[num].capacidadePadrao=0;rooms[num].capacidadeExcedente=0;rooms[num].capacidade=0;rooms[num].pessoas=[];rooms[num].descricao=descricao;};

    indisponivel(121,'INTERDITADO Esgoto retornando no ralo e sanitário, sem lâmpada no banheiro.');
    indisponivel(122,'INTERDITADO Mofo, goteiras e infiltração, tomadas queimadas.');
    indisponivel(123,'INTERDITADO mofo, goteiras e infiltração, sem ventilador.');
    rooms[125].capacidadePadrao=1; rooms[125].capacidadeExcedente=0; rooms[125].capacidade=1;
    indisponivel(126,'Sem condições de acolhimento e sem ventilador.');
    indisponivel(127,'Vaso sem assento, chuveiro sem registro e sem lâmpada.');
    indisponivel(128,'FUNCIONÁRIOS / DESCANSO');
    indisponivel(133,'INTERDITADO');
    indisponivel(134,'GOTEIRA');

    indisponivel(101,'Sala de reunião');
    indisponivel(102,'Atendimento técnico');
    indisponivel(103,'Atendimento técnico');
    rooms[105].descricao='Vaso trincado na parte de baixo, registro cuspido no chuveiro.';

    indisponivel(116,'Sem condições de uso, registro de chuveiro quebrado, sem lâmpadas.');
    indisponivel(118,'Sem condições de uso, registro de chuveiro quebrado.');
    indisponivel(137,'Depósito de roupas');
    indisponivel(138,'Sem condições de uso mofo, goteiras.');
    indisponivel(139,'Sem condições de uso mofo, goteiras.');
    indisponivel(140,'Sem condições de uso mofo, goteiras.');
    indisponivel(141,'Sem condições de uso mofo, descarga quebrada.');
    indisponivel(142,'Sem condições de uso, privada do banheiro quebrada.');
    indisponivel(144,'Banheiro com vaso sem condições de uso.');
    indisponivel(145,'Goteiras em cima da cama.');
    indisponivel(146,'');
    rooms[148].tipoQuarto='VEPEMA'; rooms[148].capacidadePadrao=2; rooms[148].capacidadeExcedente=0; rooms[148].capacidade=2; rooms[148].descricao='Camas';
    indisponivel(149,'Sem condições de uso mofo, goteiras');
    rooms[150].tipoQuarto='VEPEMA'; rooms[150].capacidadePadrao=2; rooms[150].capacidadeExcedente=0; rooms[150].capacidade=2; rooms[150].descricao='Camas';
    rooms[150].descricao='DESCARGA COM PROBLEMA, SEM INTERRUPTOR';

    const employees={plantonistas:[],vigilantes:[]};
    return {equipesAbas:{plantonistas:{ativo:1,proximo:2,abas:[{numero:1,funcionarios:[]}]},vigilantes:{ativo:1,proximo:2,abas:[{numero:1,funcionarios:[]}]}},schemaVersion:SCHEMA_VERSION,atualizadoEm:new Date().toISOString(),selectPlantao:'Plantao 1',dataInicioPlantao:'',dataInicioPlantaoAnterior:'',plantonistasAnterior:[],rooms,employees,controleEntradaSaida:{},medicamentos:{produtos:[],lotes:[],prescricoes:[],administracoes:[],movimentos:[]}};
}

function normalizarPessoa(p){
    return {
        id:p.id || uid('p'),
        nome:String(p.nome || ''),
        cpf:String(p.cpf || ''),
        identidade:String(p.identidade || ''),
        cartaoSus:String(p.cartaoSus || ''),
        genero:['Feminino','Masculino','Idoso','Outro','Trans'].includes(p.genero)?p.genero:'',
        acessibilidade:p.acessibilidade===true,
        necessidadeAcessibilidade:String(p.necessidadeAcessibilidade || ''),
        origemNacionalidade:String(p.origemNacionalidade || ''),
        nomeDemanda:String(p.nomeDemanda || ''),
        observacao:String(p.observacao || ''),
        responsavel:String(p.responsavel || ''),
        responsavelId:String(p.responsavelId || ''),
        nascimento:String(p.nascimento || ''),
        entrada:String(p.entrada || ''),
        saida:String(p.saida || ''),
        advertencia:Math.max(0,Math.min(10,parseInt(p.advertencia,10)||0)),
        advertenciasMotivos:Array.isArray(p.advertenciasMotivos)?p.advertenciasMotivos:[],
        operadoresRegistro:p.operadoresRegistro||{},
        idadeManual:(p.idadeManual!==null && p.idadeManual!==undefined && String(p.idadeManual).trim()!=='' && Number.isFinite(Number(p.idadeManual))) ? Number(p.idadeManual) : null
    };
}

function normalizarEstado(s){
    const base=criarEstadoInicial();
    if(!s || typeof s!=='object') return base;
    const out={
        schemaVersion:SCHEMA_VERSION,
        atualizadoEm:s.atualizadoEm || new Date().toISOString(),
        selectPlantao:s.selectPlantao || 'Plantao 1',
        dataInicioPlantao:String(s.dataInicioPlantao || ''),
        dataInicioPlantaoAnterior:String(s.dataInicioPlantaoAnterior || ''),
        plantonistasAnterior:Array.isArray(s.plantonistasAnterior)?s.plantonistasAnterior.map(x=>({
            id:x.id||uid('fp'), nome:String(x.nome||''), escala:x.escala||'12x36',
            funcao:FUNCOES_PLANTONISTA.includes(x.funcao)?x.funcao:''
        })).filter(x=>x.nome.trim()):[],
        rooms:{},
        employees:{plantonistas:[],vigilantes:[]},
        controleEntradaSaida:(s.controleEntradaSaida && typeof s.controleEntradaSaida==='object') ? deepClone(s.controleEntradaSaida) : {},
        medicamentos:(()=>{const m=s.medicamentos||{};return {produtos:Array.isArray(m.produtos)?deepClone(m.produtos):[],lotes:Array.isArray(m.lotes)?deepClone(m.lotes):[],prescricoes:Array.isArray(m.prescricoes)?deepClone(m.prescricoes):[],administracoes:Array.isArray(m.administracoes)?deepClone(m.administracoes):[],movimentos:Array.isArray(m.movimentos)?deepClone(m.movimentos):[],ultimoRegistroParaDesfazer:m.ultimoRegistroParaDesfazer&&typeof m.ultimoRegistroParaDesfazer==='object'?deepClone(m.ultimoRegistroParaDesfazer):null}})()
    };
    Object.keys(base.rooms).forEach(k=>{
        const r=s.rooms && s.rooms[k] ? s.rooms[k] : base.rooms[k];
        out.rooms[k]={
            id:String(r.id||k), numero:parseInt(r.numero,10)||parseInt(k,10),
            ala:r.ala||base.rooms[k].ala,
            tipoQuarto:TIPOS_QUARTO.includes(r.tipoQuarto)?r.tipoQuarto:tipoQuartoPadrao(r.ala||base.rooms[k].ala),
            status:r.status==='indisponivel'?'indisponivel':'disponivel',
            tipo:['solteiro','beliche','berco'].includes(r.tipo)?r.tipo:'solteiro',
            capacidadePadrao:Math.max(0,parseInt(r.capacidadePadrao ?? r.capacidade,10)||0),
            capacidadeExcedente:Math.max(0,parseInt(r.capacidadeExcedente,10)||0),
            capacidade:Math.max(0,parseInt(r.capacidade,10)||0),
            descricao:String(r.descricao||''),
            pessoas:Array.isArray(r.pessoas)?r.pessoas.map(normalizarPessoa):[]
        };
        if(out.rooms[k].status==='indisponivel'){
            out.rooms[k].capacidadePadrao=0;
            out.rooms[k].capacidadeExcedente=0;
            out.rooms[k].capacidade=0;
        }else{
            // Nunca aumentar silenciosamente a capacidade padrão para acomodar
            // dados que já estejam acima do limite. A capacidade só pode mudar
            // por uma alteração explícita feita na configuração do quarto.
            out.rooms[k].capacidade=out.rooms[k].capacidadePadrao+out.rooms[k].capacidadeExcedente;
        }
    });
    ['plantonistas','vigilantes'].forEach(grupo=>{
        const arr=s.employees && Array.isArray(s.employees[grupo])?s.employees[grupo]:base.employees[grupo];
        out.employees[grupo]=arr.map(x=>({
            id:x.id||uid('f'),
            nome:String(x.nome||''),
            escala:x.escala||'12x36',
            ...(grupo==='plantonistas'?{funcao:FUNCOES_PLANTONISTA.includes(x.funcao)?x.funcao:''}:{}),
            ...(grupo==='vigilantes'?{turno:['Dia','Noite'].includes(x.turno)?x.turno:'Dia'}:{})
        })).filter(x=>x.nome.trim());
    });
    // Migração: backups antigos possuem somente a lista de funcionários ativa.
    out.equipesAbas={};
    ['plantonistas','vigilantes'].forEach(grupo=>{
        const salvo=s.equipesAbas?.[grupo];
        let abas=Array.isArray(salvo?.abas)?salvo.abas.filter(a=>Number.isInteger(a.numero)&&a.numero>=1).map(a=>({numero:a.numero,funcionarios:Array.isArray(a.funcionarios)?deepClone(a.funcionarios):[]})):[];
        if(!abas.some(a=>a.numero===1))abas.unshift({numero:1,funcionarios:deepClone(out.employees[grupo])});
        const numeros=new Set(); abas=abas.filter(a=>{if(numeros.has(a.numero))return false;numeros.add(a.numero);return true;});
        abas.sort((a,b)=>a.numero-b.numero);
        const ativo=abas.some(a=>a.numero===salvo?.ativo)?salvo.ativo:1;
        // A lista ativa continua sendo a fonte para impressão, operador e relatórios.
        const abaAtiva=abas.find(a=>a.numero===ativo);
        if(salvo)out.employees[grupo]=deepClone(abaAtiva.funcionarios);
        else abaAtiva.funcionarios=deepClone(out.employees[grupo]);
        out.equipesAbas[grupo]={ativo,proximo:Math.max(Number(salvo?.proximo)||2,...abas.map(a=>a.numero+1)),abas};
    });
    return out;
}

function estadoParaHistorico(){ return deepClone(state); }

function salvarNoStorage(){
    if(state?.equipesAbas){salvarEquipeNaAba('plantonistas');salvarEquipeNaAba('vigilantes');}
    if(window.__auditCommit)window.__auditCommit();
    state.atualizadoEm=new Date().toISOString();
    localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
}

function registrarHistorico(){
    const atual=estadoParaHistorico();
    const anterior=history.length ? history[history.length-1].dados : null;
    if(anterior && JSON.stringify(anterior)===JSON.stringify(atual)) return;
    history.push({timestamp:Date.now(),dados:atual});
    if(history.length>MAX_HISTORY) history.shift();
    future=[];
    salvarHistorico();
}

function salvarHistorico(){
    localStorage.setItem(HISTORY_KEY,JSON.stringify({history,future}));
}

function carregarHistorico(){
    try{
        const raw=JSON.parse(localStorage.getItem(HISTORY_KEY)||'{}');
        history=Array.isArray(raw.history)?raw.history.map(x=>({timestamp:x.timestamp,dados:normalizarEstado(x.dados)})):[];
        future=Array.isArray(raw.future)?raw.future.map(x=>({timestamp:x.timestamp,dados:normalizarEstado(x.dados)})):[];
    }catch(e){history=[];future=[];}
}

function salvarComHistorico(){
    registrarHistorico();
    salvarNoStorage();
    render();
    agendarIndicacaoSalvo();
}

function agendarIndicacaoSalvo(){
    clearTimeout(autosaveTimer);
    autosaveTimer=setTimeout(()=>setStatus('✓ Dados salvos automaticamente em '+new Date().toLocaleTimeString('pt-BR')),150);
}

function setStatus(msg,erro=false){
    const el=document.getElementById('statusBar');
    el.textContent=msg;
    el.classList.toggle('erro',!!erro);
}

function carregarEstado(){
    try{
        const raw=localStorage.getItem(STORAGE_KEY);
        if(raw){
            const parsed=JSON.parse(raw);
            if(parsed.schemaVersion===SCHEMA_VERSION && parsed.rooms) return normalizarEstado(parsed);
        }
    }catch(e){}
    return migrarFormatoAntigo() || criarEstadoInicial();
}

function migrarFormatoAntigo(){
    try{
        const raw=localStorage.getItem('sistema_plantao_dados');
        if(!raw) return null;
        const old=JSON.parse(raw);
        if(!old.htmlFem && !old.htmlIdoso && !old.htmlMasc) return null;

        const novo=criarEstadoInicial();
        if(old.selectPlantao) novo.selectPlantao=old.selectPlantao;
        const parser=document.createElement('tbody');

        function migrarHTML(html){
            if(!html) return;
            parser.innerHTML=html;
            parser.querySelectorAll('tr[data-quarto]').forEach(tr=>{
                const num=tr.dataset.quarto, r=novo.rooms[num];
                if(!r) return;
                const status=tr.querySelector('.select-status');
                if(status && status.value==='indisponivel'){r.status='indisponivel';r.capacidadePadrao=0;r.capacidadeExcedente=0;r.capacidade=0;}
                const tipo=tr.querySelector('.select-tipo-cama');
                if(tipo) r.tipo=tipo.value;
                const cap=tr.getAttribute('data-capacidade');
                if(r.status==='disponivel' && cap){r.capacidadePadrao=parseInt(cap,10)||r.capacidadePadrao;r.capacidadeExcedente=0;r.capacidade=r.capacidadePadrao;}
                const nome=tr.querySelector('.celula-nome');
                const dates=tr.querySelectorAll('input[type="date"]');
                const adv=tr.querySelector('input[type="number"]');
                if(nome){
                    const p={id:uid('p'),nome:nome.textContent.trim(),
                        nascimento:dates[0]?.value||'',entrada:dates[1]?.value||'',saida:dates[2]?.value||'',
                        advertencia:parseInt(adv?.value,10)||0};
                    if(p.nome||p.nascimento||p.entrada||p.saida||p.advertencia) r.pessoas.push(p);
                }
            });
        }
        migrarHTML(old.htmlFem); migrarHTML(old.htmlIdoso); migrarHTML(old.htmlMasc);
        if(old.htmlPlantonistas){
            parser.innerHTML=old.htmlPlantonistas;
            const lists=parser.querySelectorAll('ul');
            lists.forEach(ul=>{
                const alvo=ul.id==='ulVigilantes'?novo.employees.vigilantes:novo.employees.plantonistas;
                alvo.length=0;
                ul.querySelectorAll('li').forEach(li=>{
                    const nome=li.querySelector('span')?.textContent.trim();
                    const escala=li.querySelector('select')?.value||'12x36';
                    if(nome) alvo.push({id:uid('f'),nome,escala});
                });
            });
        }
        novo.atualizadoEm=new Date().toISOString();
        localStorage.setItem(STORAGE_KEY,JSON.stringify(novo));
        setTimeout(()=>setStatus('✓ Dados do sistema anterior foram migrados para a versão robusta.'),0);
        return novo;
    }catch(e){
        console.warn('Falha na migração',e);
        return null;
    }
}

function nomeAla(ala){return ala==='feminina'?'Ala Feminina':ala==='idoso'?'Ala do Idoso':'Ala Masculina';}

function idade(nascimento){
    if(!nascimento) return null;

    // O campo <input type="date"> fornece a data no formato YYYY-MM-DD.
    // A data é criada manualmente para evitar diferenças de fuso horário.
    const partes=String(nascimento).trim().split('-').map(Number);
    if(partes.length!==3 || partes.some(n=>!Number.isInteger(n))) return null;

    const [ano,mes,dia]=partes;
    if(ano<1900 || mes<1 || mes>12 || dia<1 || dia>31) return null;

    const hoje=new Date();
    const nascimentoData=new Date(ano,mes-1,dia);

    // Impede que uma data inexistente seja aceita pelo JavaScript.
    if(nascimentoData.getFullYear()!==ano || nascimentoData.getMonth()!==mes-1 || nascimentoData.getDate()!==dia) return null;

    if(nascimentoData>hoje) return null;

    let anos=hoje.getFullYear()-ano;
    const aniversarioAindaNaoOcorreu =
        hoje.getMonth() < mes-1 ||
        (hoje.getMonth() === mes-1 && hoje.getDate() < dia);

    if(aniversarioAindaNaoOcorreu) anos--;
    return anos>=0 ? anos : null;
}

function idadeDaPessoa(p){
    if(!p) return null;

    // Quando existe data de nascimento, ela sempre tem prioridade.
    // Isso evita que uma idadeManual antiga impeça o recálculo automático.
    if(String(p.nascimento||'').trim()){
        const idadeCalculada=idade(p.nascimento);
        if(idadeCalculada!==null) return idadeCalculada;
    }

    // idadeManual continua como fallback para registros antigos que ainda
    // não possuem data de nascimento cadastrada.
    if(Number.isFinite(Number(p.idadeManual)) && Number(p.idadeManual)>=0) return Number(p.idadeManual);
    return null;
}

function escapar(texto){
    return String(texto).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}


// A ordem diária é persistida no backup do sistema, independente dos horários e das checkboxes.
// A data corresponde à lista de trabalho; não muda automaticamente a data dos registros existentes.
const controleESDataLocal=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
function controleESPreferenciasOrdem(){
 if(!state.controleEntradaSaida||typeof state.controleEntradaSaida!=='object')state.controleEntradaSaida={};
 const c=state.controleEntradaSaida;
 if(!c.ordensPorData||typeof c.ordensPorData!=='object'||Array.isArray(c.ordensPorData))c.ordensPorData={};
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(c.dataLista||'')))c.dataLista=controleESDataLocal();
 c.usarOrdemOntem=c.usarOrdemOntem===true;
 return c;
}
function controleESDataAnterior(data){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(data||'')))return '';
 const d=new Date(data+'T12:00:00Z');if(Number.isNaN(d.getTime()))return '';
 d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10);
}
function controleESOrdemNormal(){
 const lista=[];
 Object.values(state.rooms||{}).filter(room=>room && room.status!=='indisponivel').forEach(room=>{
  (room.pessoas||[]).filter(p=>pessoaAtivaResumo(p) && String(p.nome||'').trim()).forEach(p=>lista.push({room,p}));
 });
 const minutos=valor=>{if(!valor)return null;const [h,m]=String(valor).split(':').map(Number);return Number.isFinite(h)&&Number.isFinite(m)?h*60+m:null;};
 const primeiro=item=>{const r=controleESRegistro(item.p);const hs=[r.s1,r.s2].map(minutos).filter(v=>v!==null);return hs.length?Math.min(...hs):null;};
 lista.sort((a,b)=>{
  const ha=primeiro(a),hb=primeiro(b);
  if(ha===null&&hb===null)return (Number(a.room.numero)||0)-(Number(b.room.numero)||0)||String(a.p.nome).localeCompare(String(b.p.nome),'pt-BR');
  if(ha===null)return 1;if(hb===null)return -1;
  return ha-hb||(Number(a.room.numero)||0)-(Number(b.room.numero)||0)||String(a.p.nome).localeCompare(String(b.p.nome),'pt-BR');
 });
 return lista;
}
function obterPessoasControleEntradaSaida(){
 const lista=controleESOrdemNormal(),cfg=controleESPreferenciasOrdem();
 if(!cfg.usarOrdemOntem)return lista;
 const anterior=cfg.ordensPorData[controleESDataAnterior(cfg.dataLista)];
 if(!Array.isArray(anterior)||!anterior.length)return lista;
 const pos=new Map(anterior.map((id,i)=>[String(id),i]));
 // Estável: quem não constava da lista de ontem permanece ao final, na ordem normal.
 return lista.sort((a,b)=>{
  const ia=pos.has(String(a.p.id))?pos.get(String(a.p.id)):Infinity;
  const ib=pos.has(String(b.p.id))?pos.get(String(b.p.id)):Infinity;
  return ia-ib;
 });
}
function controleESSalvarOrdemDia(){
 if(!state?.rooms)return;
 const cfg=controleESPreferenciasOrdem();
 const ids=obterPessoasControleEntradaSaida().map(({p})=>String(p.id));
 if(!ids.length)return;
 const possuiSaidas=ids.some(id=>{const r=cfg[id];return r&&(r.s1||r.s2);});
 // Não apagar sequência diária existente se todos os horários acabaram de ser limpos.
 if(!possuiSaidas&&Array.isArray(cfg.ordensPorData[cfg.dataLista])&&cfg.ordensPorData[cfg.dataLista].length)return;
 cfg.ordensPorData[cfg.dataLista]=ids;
 const datas=Object.keys(cfg.ordensPorData).sort();
 if(datas.length>120)datas.slice(0,datas.length-120).forEach(d=>delete cfg.ordensPorData[d]);
}
function controleESAtualizarOrdemUI(){
 const cfg=controleESPreferenciasOrdem();
 const data=document.getElementById('controleESDataLista');if(data)data.value=cfg.dataLista;
 const checkbox=document.getElementById('controleESUsarOrdemOntem');if(checkbox)checkbox.checked=cfg.usarOrdemOntem;
 const info=document.getElementById('controleESOrdemMensagem');
 if(info){const anterior=controleESDataAnterior(cfg.dataLista),ordem=cfg.ordensPorData[anterior];
  const [a,m,d]=anterior.split('-');
  info.textContent=Array.isArray(ordem)&&ordem.length
   ?'Ordem de '+d+'/'+m+'/'+a+' disponível ('+ordem.length+' nomes). '+(cfg.usarOrdemOntem?'Aplicada à lista atual.':'Marque a opção para utilizá-la.')
   :'Nenhuma ordem salva para '+d+'/'+m+'/'+a+'. A ordenação normal será utilizada.';
 }
}


function controleESRegistro(p){
    if(!state.controleEntradaSaida) state.controleEntradaSaida={};
    if(!state.controleEntradaSaida[p.id]) state.controleEntradaSaida[p.id]={s1:'',e1:'',s2:'',e2:'',observacao:'',chave:'pessoa',autorizacao:false,motivoAutorizacao:'',horariosSalvos:false};
    const r=state.controleEntradaSaida[p.id];
    r.s1=String(r.s1||''); r.e1=String(r.e1||''); r.s2=String(r.s2||''); r.e2=String(r.e2||'');
    r.observacao=String(r.observacao||'');
    r.horariosSalvos=r.horariosSalvos===true;
    // Travas distintas: horariosSalvos = edição manual global;
    // horariosConfirmados[campo] = apenas confirmação individual pela checkbox.
    if(!r.horariosConfirmados || typeof r.horariosConfirmados!=='object' || Array.isArray(r.horariosConfirmados))r.horariosConfirmados={};
    ['s1','e1','s2','e2'].forEach(c=>{
        if(r.horariosConfirmados[c]!==true && r.horariosConfirmados[c]!==false)r.horariosConfirmados[c]=false;
    });
    r.autorizacao = r.autorizacao === true;
    r.motivoAutorizacao = String(r.motivoAutorizacao||'');
    if(!r.ocorrenciaChave || typeof r.ocorrenciaChave!=='object') r.ocorrenciaChave=null;
    if(!['pessoa','recepcao','quarto','outro'].includes(r.chave)) r.chave='pessoa';
    return r;
}

function chavePerdidaNoQuarto(room){
    if(!state.controleEntradaSaida) state.controleEntradaSaida={};
    if(!state.controleEntradaSaida.quartos) state.controleEntradaSaida.quartos={};
    return state.controleEntradaSaida.quartos[String(room.numero)]?.chavePerdida===true;
}

function marcarChavePerdida(room){
    if(!state.controleEntradaSaida) state.controleEntradaSaida={};
    if(!state.controleEntradaSaida.quartos) state.controleEntradaSaida.quartos={};
    state.controleEntradaSaida.quartos[String(room.numero)]={chavePerdida:true};
    salvarControleES();
}

function existeEntregaNaRecepcao(room){
    return pessoasDoMesmoQuarto(room).some(p=>controleESRegistro(p).chave==='recepcao');
}

function abrirOpcaoChavePerdida(p,room){
    if(!room) return;
    if(chavePerdidaNoQuarto(room)) return;
    if(existeEntregaNaRecepcao(room)){
        alert('A chave deste quarto está registrada como entregue na recepção.');
        return;
    }
    if(confirm('Deseja registrar a chave do quarto '+room.numero+' como PERDIDA?')){
        marcarChavePerdida(room);
    }
}

function pessoasDoMesmoQuarto(room){
    return (room?.pessoas||[]).filter(p=>pessoaAtivaResumo(p) && String(p.nome||'').trim());
}

// Esmaecer só quem permanece presente E ainda não possui nenhum horário do controle.
function deveEsmaecerPessoaNoControle(p){
    const r=controleESRegistro(p);
    const temHorario=['s1','e1','s2','e2'].some(c=>String(r[c]||'').trim()!=='');
    return !temHorario && !pessoaEstaForaNoControle(p);
}

function pessoaEstaForaNoControle(p){
    const r=controleESRegistro(p);
    // A última movimentação preenchida determina se a pessoa está fora.
    // A Entrada 2 também encerra uma Saída 1 sem Entrada 1 (por exemplo,
    // saída 07:41 e retorno 16:29 no último campo).
    // A ordem dos campos é Saída 1 → Entrada 1 → Saída 2 → Entrada 2.
    if(r.e2) return false;
    if(r.s2) return true;
    if(r.e1) return false;
    if(r.s1) return true;
    return false;
}

function todosComEntradaRegistrada(room){
    const pessoas=pessoasDoMesmoQuarto(room);
    if(!pessoas.length) return false;
    const houveSaida=pessoas.some(p=>{const r=controleESRegistro(p); return !!(r.s1||r.s2);});
    if(!houveSaida) return true;
    return pessoas.every(p=>!pessoaEstaForaNoControle(p));
}

function todosEstaoForaNoControle(room){
    const pessoas=pessoasDoMesmoQuarto(room);
    if(!pessoas.length) return false;
    return pessoas.every(p=>pessoaEstaForaNoControle(p));
}

function chaveEstaComPessoa(p,room){
    // Quem está fora sempre exibe a seta. Quem está dentro e foi definido
    // como portador da chave exibe o cadeado. Se ainda não houver um portador
    // registrado, a pessoa que permaneceu no quarto continua com a chave.
    if(pessoaEstaForaNoControle(p)) return false;
    const pessoas=pessoasDoMesmoQuarto(room);
    const existePortador=pessoas.some(x=>controleESRegistro(x).chave==='pessoa');
    return controleESRegistro(p).chave==='pessoa' || !existePortador;
}

function abrirPerguntaChave(p,room,qualSaida){
    const backdrop=document.getElementById('controleChaveModalBackdrop');
    const pergunta=document.getElementById('controleChavePergunta');
    const opcoes=document.getElementById('controleChaveOpcoes');
    if(!backdrop||!pergunta||!opcoes) return;
    pergunta.textContent=`${p.nome}: esta pessoa entregou a chave na recepção após registrar ${qualSaida}?`;
    opcoes.innerHTML='';
    const adicionar=(texto,classe,acao)=>{
        const b=document.createElement('button'); b.type='button'; b.className=classe; b.textContent=texto; b.onclick=()=>{acao();fecharPerguntaChave();}; opcoes.appendChild(b);
    };
    adicionar('Sim — entregou a chave na recepção','opcao-sim',()=>{
        const r=controleESRegistro(p);
        r.chave='recepcao';
        pessoasDoMesmoQuarto(room).forEach(x=>{
            if(x.id!==p.id && !pessoaEstaForaNoControle(x)) controleESRegistro(x).chave='pessoa';
        });
        salvarControleES();
    });
    adicionar('Não — a chave está no quarto (Azul)', 'opcao-azul',()=>{
        const r=controleESRegistro(p);
        r.chave='quarto';
        pessoasDoMesmoQuarto(room).forEach(x=>{
            if(x.id!==p.id && !pessoaEstaForaNoControle(x)) controleESRegistro(x).chave='pessoa';
        });
        salvarControleES();
    });
    adicionar('Não — a chave está com outro acolhido (Amarelo)', 'opcao-amarelo',()=>{
        abrirSelecaoOutroAcolhido(p,room);
    });
    backdrop.classList.add('aberto'); backdrop.setAttribute('aria-hidden','false');
}

function abrirSelecaoOutroAcolhido(p,room){
    const backdrop=document.getElementById('controleChaveModalBackdrop');
    const pergunta=document.getElementById('controleChavePergunta');
    const opcoes=document.getElementById('controleChaveOpcoes');
    if(!backdrop||!pergunta||!opcoes) return;

    const outros=pessoasDoMesmoQuarto(room).filter(x=>x.id!==p.id && String(x.nome||'').trim() && !String(x.saida||'').trim());
    if(!outros.length){
        alert('Não há outro acolhido ativo neste quarto para receber a chave.');
        return;
    }

    pergunta.textContent=`Selecione o acolhido do quarto ${room.numero} que ficará com a chave:`;
    opcoes.innerHTML='';

    const select=document.createElement('select');
    select.className='controle-chave-select-outro';
    select.setAttribute('aria-label','Acolhido que ficará com a chave');

    const primeira=document.createElement('option');
    primeira.value='';
    primeira.textContent='Selecione o nome...';
    primeira.disabled=true;
    primeira.selected=true;
    select.appendChild(primeira);

    outros.forEach(x=>{
        const option=document.createElement('option');
        option.value=x.id;
        option.textContent=x.nome;
        select.appendChild(option);
    });

    const confirmar=document.createElement('button');
    confirmar.type='button';
    confirmar.className='opcao-amarelo';
    confirmar.textContent='Confirmar';
    confirmar.disabled=true;
    confirmar.onclick=()=>{
        const selecionado=outros.find(x=>x.id===select.value);
        if(!selecionado) return;
        Object.values(state.controleEntradaSaida||{}).forEach(r=>{
            if(r.chave==='outro') r.chave='pessoa';
        });
        controleESRegistro(p).chave='outro';
        controleESRegistro(selecionado).chave='pessoa';
        salvarControleES();
        fecharPerguntaChave();
    };

    select.onchange=()=>{ confirmar.disabled=!select.value; };
    opcoes.appendChild(select);
    opcoes.appendChild(confirmar);
    backdrop.classList.add('aberto');
    backdrop.setAttribute('aria-hidden','false');
}

function fecharPerguntaChave(){
    const backdrop=document.getElementById('controleChaveModalBackdrop');
    if(backdrop){backdrop.classList.remove('aberto');backdrop.setAttribute('aria-hidden','true');}
}

function atualizarIndicadoresPresencaABD(){
    document.querySelectorAll('[data-abd-presenca-id]').forEach(el=>{
        const id=el.getAttribute('data-abd-presenca-id');
        let pessoa=null;
        for(const quarto of Object.values(state.rooms||{})){
            pessoa=(quarto.pessoas||[]).find(p=>String(p.id)===id);
            if(pessoa)break;
        }
        if(!pessoa)return;
        const fora=pessoaEstaForaNoControle(pessoa);
        el.classList.toggle('abd-presenca-ausente',fora);
        el.classList.toggle('abd-presenca-presente',!fora);
        el.title=(fora?'Ausente — última movimentação: saída':'Presente — entrada registrada ou sem saída pendente')+' — '+(pessoa.nome||'acolhido');
        el.setAttribute('aria-label',el.title);
    });
    // O destaque acompanha os mesmos registros usados pelos indicadores de presença.
    document.querySelectorAll('#controleEntradaSaidaBody tr[data-controle-presenca-id]').forEach(linha=>{
        const id=linha.dataset.controlePresencaId;
        let pessoa;
        for(const quarto of Object.values(state.rooms||{})){
            pessoa=(quarto.pessoas||[]).find(p=>String(p.id)===id);
            if(pessoa)break;
        }
        if(pessoa)linha.classList.toggle('abd-controle-presente-esmaecido',deveEsmaecerPessoaNoControle(pessoa));
    });
    if(typeof atualizarLayoutABD==='function')atualizarLayoutABD();
}
function salvarControleES(){
    controleESSalvarOrdemDia();
    salvarNoStorage();
    renderControleEntradaSaida();
    atualizarIndicadoresPresencaABD();
    setStatus('✓ Controle de entrada e saída salvo.');
}

function atualizarControleHorario(id,campo,valor){
    const pEncontrada=obterPessoasControleEntradaSaida().find(x=>x.p.id===id);
    if(!pEncontrada) return;
    const r=controleESRegistro(pEncontrada.p);
    if(r[campo] && r.horariosConfirmados?.[campo]!==false) return;
    r[campo]=valor;
    // A saída é registrada normalmente. A pergunta sobre a chave só abre
    // quando o operador confirma explicitamente a célula com Enter.
    // Não abrir modal ao digitar, sair do campo, marcar checkbox ou salvar.

    // Ao registrar uma entrada, se todos os ocupantes do quarto já tiverem entrada,
    // todos passam a exibir a chave, conforme a regra solicitada.
    if(campo==='e1' || campo==='e2'){
        // Ao registrar uma entrada, esta pessoa volta a ser considerada na casa
        // e automaticamente passa a ser considerada com a chave.
        const room=pEncontrada.room;
        if(state.controleEntradaSaida?.quartos?.[String(room.numero)]){
            state.controleEntradaSaida.quartos[String(room.numero)].chavePerdida=false;
        }
        // Ao registrar a entrada, esta própria pessoa passa automaticamente
        // a ser considerada portadora da chave.
        r.chave='pessoa';
    }
    salvarControleES();
}

function abrirMensagemAutorizacao(p){
    const r=controleESRegistro(p),b=document.getElementById('controleAutorizacaoModalBackdrop'),m=document.getElementById('controleAutorizacaoMensagem');
    if(!b||!m)return; m.textContent=r.motivoAutorizacao||'Autorização registrada, mas sem motivo informado.'; b.classList.add('aberto'); b.setAttribute('aria-hidden','false');
}
function fecharMensagemAutorizacao(){
    const b=document.getElementById('controleAutorizacaoModalBackdrop'); if(b){b.classList.remove('aberto');b.setAttribute('aria-hidden','true');}
}
function salvarAutorizacaoControleES(id,habilitada,motivo){
    const item=obterPessoasControleEntradaSaida().find(x=>x.p.id===id); if(!item)return; const r=controleESRegistro(item.p);
    r.autorizacao=habilitada===true; r.motivoAutorizacao=String(motivo||'').trim(); if(!r.autorizacao)r.motivoAutorizacao=''; salvarControleES();
}
/* Registro individual de quebra / extravio, com duas confirmações e auditoria. */
let pendenciaOcorrenciaChave=null;
function abrirOcorrenciaChave(p,room,tipo,acao){
    const modal=document.getElementById('modalOcorrenciaChave');
    if(!modal)return;
    pendenciaOcorrenciaChave={pessoaId:String(p.id),numero:String(room.numero),tipo,acao,etapa:'confirmacao'};
    document.getElementById('tituloOcorrenciaChave').textContent=acao==='resolver'?'🔑 Solução da ocorrência de chave':'🔑 Confirmar quebra / extravio de chave';
    document.getElementById('perguntaOcorrenciaChave').textContent=acao==='resolver'
       ?'A situação da chave de '+(p.nome||'esta demanda')+' foi solucionada?'
       :'Deseja realmente registrar uma QUEBRA ou EXTRAVIO de chave para esta demanda ('+(p.nome||'sem nome')+' — quarto '+room.numero+')?';
    document.getElementById('tipoOcorrenciaChaveWrap').hidden=acao!=='registrar';
    document.getElementById('tipoOcorrenciaChave').value=tipo||'quebrado';
    document.getElementById('campoObservacaoOcorrenciaChave').hidden=true;
    document.getElementById('observacaoOcorrenciaChave').value='';
    modal.hidden=false;
    document.getElementById('confirmarOcorrenciaChave').focus();
}
function fecharOcorrenciaChave(){
    document.getElementById('modalOcorrenciaChave').hidden=true;
    pendenciaOcorrenciaChave=null;
}
function confirmarOcorrenciaChave(){
    const pend=pendenciaOcorrenciaChave;
    if(!pend)return;
    const item=obterPessoasControleEntradaSaida().find(x=>String(x.p.id)===pend.pessoaId && String(x.room.numero)===pend.numero);
    if(!item){fecharOcorrenciaChave();alert('Cadastro não encontrado. A ocorrência não foi alterada.');return;}
    const campo=document.getElementById('campoObservacaoOcorrenciaChave');
    const obs=document.getElementById('observacaoOcorrenciaChave');
    if(pend.etapa==='confirmacao'){
        if(pend.acao==='registrar') pend.tipo=document.getElementById('tipoOcorrenciaChave').value;
        pend.etapa='observacao';campo.hidden=false;document.getElementById('tipoOcorrenciaChaveWrap').hidden=true;
        document.getElementById('perguntaOcorrenciaChave').textContent=pend.acao==='resolver'
           ?'Descreva como a situação da chave foi solucionada:'
           :'Descreva a ocorrência de '+(pend.tipo==='quebrado'?'quebra':'extravio')+' da chave:';
        obs.focus();return;
    }
    const texto=obs.value.trim();
    if(!texto){alert('A observação é obrigatória. Informe o ocorrido ou a solução.');obs.focus();return;}
    const reg=controleESRegistro(item.p);
    const anterior=reg.ocorrenciaChave;
    const agora=new Date().toISOString();
    if(pend.acao==='registrar'){
        if(anterior?.ativa){fecharOcorrenciaChave();return;}
        reg.ocorrenciaChave={ativa:true,tipo:pend.tipo,observacao:texto,registradoEm:agora,registradoPor:window.__operadorAtual?.()||'Operador não identificado'};
        window.__auditarOcorrenciaChave?.({personId:pend.pessoaId,personName:item.p.nome||'',quarto:pend.numero,field:'quebra / extravio de chave — '+pend.tipo,previous:'Sem ocorrência',next:'Ocorrência confirmada; observação: '+texto,origin:'controle de chaves'});
    }else{
        if(!anterior?.ativa){fecharOcorrenciaChave();return;}
        reg.ocorrenciaChave={...anterior,ativa:false,solucao:texto,solucionadoEm:agora,solucionadoPor:window.__operadorAtual?.()||'Operador não identificado'};
        window.__auditarOcorrenciaChave?.({personId:pend.pessoaId,personName:item.p.nome||'',quarto:pend.numero,field:'solução de '+(anterior.tipo==='quebrado'?'quebra':'extravio')+' de chave',previous:'Ocorrência pendente',next:'Situação solucionada; como foi solucionada: '+texto,origin:'controle de chaves'});
    }
    fecharOcorrenciaChave();
    salvarControleES();
}
document.getElementById('cancelarOcorrenciaChave')?.addEventListener('click',fecharOcorrenciaChave);
document.getElementById('confirmarOcorrenciaChave')?.addEventListener('click',confirmarOcorrenciaChave);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.getElementById('modalOcorrenciaChave')?.hidden){e.preventDefault();fecharOcorrenciaChave();}});

function abrirHistoricoOcorrenciaChave(p,room){
    const modal=document.getElementById('modalHistoricoOcorrenciaChave');if(!modal)return;
    const registro=controleESRegistro(p).ocorrenciaChave;
    document.getElementById('tituloHistoricoOcorrenciaChave').textContent='💥 Auditoria de chave — '+(p.nome||'Acolhido');
    const resumo=document.getElementById('resumoHistoricoOcorrenciaChave');
    resumo.textContent='Quarto '+room.numero+' | '+(registro?.ativa?'Ocorrência pendente':'Ocorrência solucionada');
    const lista=document.getElementById('listaHistoricoOcorrenciaChave');lista.replaceChildren();
    const registros=window.__lerAuditoriaOcorrenciaChave?.(p.id)||[];
    if(registros.length){
        for(const item of registros){
            const bloco=document.createElement('div');bloco.className='item-ocorrencia-chave';
            const data=item.at?new Date(item.at).toLocaleString('pt-BR'):'Data não informada';
            bloco.textContent=data+' | Operador: '+(item.user||'Não informado')+'\n'+(item.field||'Ocorrência')+'\n'+(item.next||'');
            lista.appendChild(bloco);
        }
    }else if(registro){
        const bloco=document.createElement('div');bloco.className='item-ocorrencia-chave';
        bloco.textContent='Ocorrência: '+(registro.tipo==='extravio'?'Extravio':'Quebra')+'\nObservação: '+(registro.observacao||'Não informada')+(registro.solucao?'\nSolução: '+registro.solucao:'');
        lista.appendChild(bloco);
    }else{lista.textContent='Nenhum registro de ocorrência encontrado para este acolhido.';}
    modal.hidden=false;
    document.getElementById('fecharHistoricoOcorrenciaChave').focus();
}
function fecharHistoricoOcorrenciaChave(){document.getElementById('modalHistoricoOcorrenciaChave').hidden=true;}
document.getElementById('fecharHistoricoOcorrenciaChave')?.addEventListener('click',fecharHistoricoOcorrenciaChave);
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.getElementById('modalHistoricoOcorrenciaChave')?.hidden){fecharHistoricoOcorrenciaChave();}});

function limparTodosHorariosControleES(){
    controleESSalvarOrdemDia();
    if(!state||!state.controleEntradaSaida){setStatus('Nenhum horário de entrada e saída para limpar.');return;}
    const campos=['s1','e1','s2','e2'];
    const ids=Object.keys(state.controleEntradaSaida).filter(id=>id!=='quartos' && state.controleEntradaSaida[id] && typeof state.controleEntradaSaida[id]==='object');
    const afetados=ids.map(id=>({id,reg:state.controleEntradaSaida[id]})).filter(({reg})=>campos.some(c=>!!reg[c])||reg.horariosSalvos===true||campos.some(c=>reg.horariosConfirmados?.[c]===true));
    if(!afetados.length){setStatus('✓ Todos os horários já estão vazios. Checkboxes disponíveis para novas marcações.');renderControleEntradaSaida();return;}
    const primeiraConfirmacao='Limpar TODOS os horários registrados de '+afetados.length+' registro(s)?\n\nSerão apagados Saída 1, Entrada 1, Saída 2 e Entrada 2, além das confirmações (checkboxes).\n\nObservações, chaves, autorizações e cadastros serão preservados. Esta ação será registrada na auditoria.';
    if(!confirm(primeiraConfirmacao))return;
    if(!confirm('CONFIRMAÇÃO FINAL: apagar os horários de TODOS os acolhidos, inclusive os que não aparecem na pesquisa atual?\n\nFaça um backup antes de continuar se precisar preservar esses horários.'))return;
    const pessoas=new Map();
    Object.values(state.rooms||{}).forEach(room=>(room?.pessoas||[]).forEach(p=>pessoas.set(String(p.id),{p,room})));
    let qtdCampos=0;
    afetados.forEach(({id,reg})=>{
        const anterior=campos.filter(c=>reg[c]).map(c=>c.toUpperCase()+': '+reg[c]).join(' | ')||'Horários travados sem valores';
        qtdCampos+=campos.filter(c=>!!reg[c]).length;
        campos.forEach(c=>{reg[c]='';});
        reg.horariosConfirmados={s1:false,e1:false,s2:false,e2:false};
        reg.horariosSalvos=false;
        const dado=pessoas.get(String(id));
        window.__auditarOcorrenciaChave?.({
            personId:String(id),personName:String(dado?.p?.nome||'Registro de acesso'),
            quarto:String(dado?.room?.numero??''),
            field:'entrada e saída — Limpar Tudo (reinício de horários)',
            previous:anterior,next:'Saída 1, Entrada 1, Saída 2 e Entrada 2 vazios; checkboxes liberadas',
            origin:'controle de entrada e saída'
        });
    });
    salvarNoStorage();
    renderControleEntradaSaida();
    atualizarIndicadoresPresencaABD();
    setStatus('✓ Limpar Tudo concluído: '+qtdCampos+' horário(s) apagado(s), '+afetados.length+' registro(s) reiniciado(s).');
}

function renderControleEntradaSaida(){
    controleESAtualizarOrdemUI();
    const body=document.getElementById('controleEntradaSaidaBody'); if(!body)return; body.innerHTML='';
    const termo=String(document.getElementById('controleEntradaSaidaBusca')?.value||'').trim().toLocaleLowerCase('pt-BR');
    const lista=obterPessoasControleEntradaSaida().filter(({room,p})=>!termo || String(p.nome||'').toLocaleLowerCase('pt-BR').includes(termo) || String(room.numero||'').includes(termo));
    if(!lista.length){body.innerHTML='<tr><td colspan="8" class="controle-vazio">Nenhum acolhido encontrado.</td></tr>';return;}
    let numeroQuartoAnterior=null,alternanciaQuarto=false;
    lista.forEach(({room,p})=>{
        const r=controleESRegistro(p),tr=document.createElement('tr'),numeroQuartoAtual=String(room.numero);
        if(numeroQuartoAtual!==numeroQuartoAnterior){alternanciaQuarto=!alternanciaQuarto;numeroQuartoAnterior=numeroQuartoAtual;}
        tr.classList.add(alternanciaQuarto?'controle-quarto-cinza':'controle-quarto-branco');
        tr.classList.toggle('abd-controle-presente-esmaecido',deveEsmaecerPessoaNoControle(p));
        tr.dataset.controlePresencaId=String(p.id);
        const idadeControle=idadeDaPessoa(p); if((idadeControle!==null&&idadeControle>=60)||p.acessibilidade===true)tr.classList.add('controle-pessoa-amarela');
        const tdQ=document.createElement('td');tdQ.className='controle-quarto';tdQ.dataset.label='Quarto';tdQ.textContent=room.numero;tr.appendChild(tdQ);
        const tdN=document.createElement('td');tdN.className='controle-nome';tdN.dataset.label='Acolhido';
        const autorizacaoWrap=document.createElement('div');autorizacaoWrap.className='controle-autorizacao';
        const mostrarEditor=()=>{
            if(tdN.querySelector('.controle-autorizacao-editor'))return;
            const ed=document.createElement('div');ed.className='controle-autorizacao-editor';
            const check=document.createElement('input');check.type='checkbox';check.checked=r.autorizacao;
            const label=document.createElement('label');label.className='controle-autorizacao-check';label.appendChild(check);label.appendChild(document.createTextNode('Autorização fora de horário'));
            const input=document.createElement('input');input.type='text';input.value=r.motivoAutorizacao||'';input.placeholder='Motivo da autorização';
            const save=document.createElement('button');save.type='button';save.className='btn-success';save.textContent='Salvar';
            const cancel=document.createElement('button');cancel.type='button';cancel.className='btn-secondary';cancel.textContent='Cancelar';
            ed.append(label,input,save,cancel);tdN.appendChild(ed);
            const sync=()=>input.style.display=check.checked?'':'none';check.onchange=sync;sync();
            save.onclick=()=>{if(check.checked&&!String(input.value).trim()){alert('Informe o motivo da autorização.');input.focus();return;}salvarAutorizacaoControleES(p.id,check.checked,input.value);};
            cancel.onclick=()=>ed.remove();
        };
        if(r.autorizacao&&r.motivoAutorizacao){
            const edit=document.createElement('button');edit.type='button';edit.className='btn-autorizacao editar';edit.textContent='✏️';edit.title='Editar autorização';edit.onclick=e=>{e.stopPropagation();mostrarEditor();};
            const ok=document.createElement('button');ok.type='button';ok.className='btn-autorizacao';ok.textContent='👍';ok.title=r.motivoAutorizacao;ok.onclick=e=>{e.stopPropagation();abrirMensagemAutorizacao(p);};
            autorizacaoWrap.append(edit,ok);
        }else{
            const add=document.createElement('button');add.type='button';add.className='btn-autorizacao adicionar-autorizacao';add.textContent='+';add.title='Adicionar autorização de entrada e saída fora de horário';add.onclick=e=>{e.stopPropagation();mostrarEditor();};autorizacaoWrap.appendChild(add);
        }
        tdN.appendChild(autorizacaoWrap);
        const nome=document.createElement('div');nome.className='abd-controle-nome-linha';
        const nomeTexto=document.createElement('span');nomeTexto.textContent=p.nome||'';
        const pontoPresenca=document.createElement('span');pontoPresenca.className='abd-presenca-ponto '+(pessoaEstaForaNoControle(p)?'abd-presenca-ausente':'abd-presenca-presente');
        pontoPresenca.setAttribute('data-abd-presenca-id',String(p.id));
        pontoPresenca.title=(pessoaEstaForaNoControle(p)?'Ausente':'Presente')+' — '+(p.nome||'acolhido');
        pontoPresenca.setAttribute('aria-label',pontoPresenca.title);
        nome.append(nomeTexto,pontoPresenca);tdN.appendChild(nome);
        if(idadeControle!==null){const idade=document.createElement('span');idade.className='controle-idade';idade.textContent=idadeControle+' anos';tdN.appendChild(idade);}
        tr.appendChild(tdN);
        const tdK=document.createElement('td');tdK.className='controle-chave';tdK.dataset.label='Chave';const keyBtn=document.createElement('button');keyBtn.type='button';keyBtn.className='btn-chave-controle';const estado=r.chave,estaFora=pessoaEstaForaNoControle(p),todosFora=todosEstaoForaNoControle(room),perdida=chavePerdidaNoQuarto(room),mostrar=chaveEstaComPessoa(p,room);
        if(perdida){keyBtn.textContent='⚠️';keyBtn.title='Chave registrada como perdida. Clique para retirar este registro.';keyBtn.classList.add('chave-perdida');}else if(estaFora){keyBtn.textContent='🚪➡️';keyBtn.title=todosFora&&!existeEntregaNaRecepcao(room)?'Todos estão fora e a chave não foi entregue na recepção. Clique para registrar a chave como perdida.':'Esta pessoa está fora da unidade.';}else{keyBtn.textContent='🔑';keyBtn.title=mostrar?'Esta pessoa está na casa e é considerada com a chave.':'Esta pessoa está na casa.';}
        if(estado==='quarto')tdK.classList.add('chave-estado-quarto');if(estado==='outro')tdK.classList.add('chave-estado-outro');if(estado==='recepcao')tdK.classList.add('chave-estado-recepcao');
        keyBtn.onclick=event=>{if(event){event.preventDefault();event.stopPropagation();}if(perdida){if(confirm('Retirar o registro de chave perdida do quarto '+room.numero+'?')){if(state.controleEntradaSaida?.quartos?.[String(room.numero)])state.controleEntradaSaida.quartos[String(room.numero)].chavePerdida=false;salvarControleES();}return;}if(keyBtn.textContent==='🚪➡️'){abrirOpcaoChavePerdida(p,room);return;}pessoasDoMesmoQuarto(room).forEach(x=>{if(!pessoaEstaForaNoControle(x))controleESRegistro(x).chave='pessoa';});controleESRegistro(p).chave='pessoa';salvarControleES();};
        const linhaIcones=document.createElement('div');linhaIcones.className='controle-chave-icones';
        linhaIcones.appendChild(keyBtn);
        const ocorrenciaAtual=r.ocorrenciaChave?.ativa?r.ocorrenciaChave:null;
        if(ocorrenciaAtual){
            const alerta=document.createElement('button');alerta.type='button';alerta.className='btn-ocorrencia-chave-alerta';alerta.textContent='💥';
            alerta.title='Ocorrência de chave pendente. Clique para visualizar a auditoria.';
            alerta.setAttribute('aria-label','Abrir auditoria da '+(ocorrenciaAtual.tipo==='extravio'?'chave extraviada':'chave quebrada')+' de '+(p.nome||'acolhido'));
            alerta.onclick=e=>{e.preventDefault();e.stopPropagation();abrirHistoricoOcorrenciaChave(p,room);};
            linhaIcones.appendChild(alerta);
        }
        tdK.appendChild(linhaIcones);
        const chavesCheck=document.createElement('div');chavesCheck.className='ocorrencia-chave-grupo';
        const label=document.createElement('label');label.className='ocorrencia-chave-opcao'+(ocorrenciaAtual?' ativo':'');
        const check=document.createElement('input');check.type='checkbox';check.checked=!!ocorrenciaAtual;
        check.setAttribute('aria-label','Quebra ou extravio da chave de '+(p.nome||'acolhido'));
        check.addEventListener('change',()=>{
            const atual=controleESRegistro(p).ocorrenciaChave;
            check.checked=!!atual?.ativa; // só altera após confirmação e observação
            abrirOcorrenciaChave(p,room,atual?.ativa?atual.tipo:'quebrado',atual?.ativa?'resolver':'registrar');
        });
        const texto=document.createElement('span');texto.className='ocorrencia-chave-legenda';texto.append('Quebrado',document.createElement('br'),'Extravio');
        label.append(check,texto);chavesCheck.appendChild(label);tdK.appendChild(chavesCheck);
        const legenda=document.createElement('span');legenda.className='controle-chave-ajuda';legenda.textContent=estado==='recepcao'?'Recepção':estado==='quarto'?'No quarto':estado==='outro'?'Com outro acolhido':'';if(legenda.textContent)tdK.appendChild(legenda);tr.appendChild(tdK);
        [['s1','e1'],['s2','e2']].flat().forEach(campo=>{
            const td=document.createElement('td');td.className='controle-horario';
            const labelCampo=campo==='s1'?'Saída 1':campo==='e1'?'Entrada 1':campo==='s2'?'Saída 2':'Entrada 2';
            td.dataset.label=labelCampo;
            // O botão trava/libera edição manual; a checkbox confirma cada horário separadamente.
            const confirmadoPelaCheckbox=r.horariosConfirmados[campo]===true;
            const travado=confirmadoPelaCheckbox || r.horariosSalvos;
            const input=document.createElement('input');
            input.type='time';input.value=r[campo]||'';input.title=labelCampo;
            input.disabled=travado;
            const marcar=document.createElement('input');
            marcar.type='checkbox';marcar.className='controle-horario-agora';
            marcar.checked=confirmadoPelaCheckbox;
            marcar.title=confirmadoPelaCheckbox?'Desmarcar para destravar '+labelCampo:'Marcar para registrar a hora atual em '+labelCampo+' e confirmar';
            marcar.setAttribute('aria-label',marcar.title);
            // A checkbox sempre existe, inclusive para os campos ainda vazios.
            marcar.addEventListener('change',()=>{
                const reg=controleESRegistro(p);
                if(!marcar.checked){
                    // Permite destravar até campos sem horário após Salvar horários.
                    if(reg.horariosConfirmados[campo]===false){renderControleEntradaSaida();return;}
                    if(!confirm('Destravar '+labelCampo+' de '+(p.nome||'esta pessoa')+' ('+reg[campo]+') para corrigir?')){
                        marcar.checked=true;return;
                    }
                    reg.horariosConfirmados[campo]=false;
                    window.__auditarOcorrenciaChave?.({
                        personId:String(p.id),personName:String(p.nome||''),quarto:String(room.numero),
                        field:'entrada e saída — desbloqueio de '+labelCampo,
                        previous:reg[campo]+' · travado',next:reg[campo]+' · liberado',origin:'controle de entrada e saída'
                    });
                    salvarControleES();renderControleEntradaSaida();
                    const linha=[...document.querySelectorAll('#controleEntradaSaidaPanel .controle-es-tabela tbody tr')]
                        .find(x=>x.querySelector('[data-pessoa-id="'+String(p.id)+'"]'));
                    if(linha)linha.querySelector('[data-label="'+labelCampo+'"] input[type=time]')?.focus();
                    return;
                }
                const agora=new Date();
                const horaAtual=String(agora.getHours()).padStart(2,'0')+':'+String(agora.getMinutes()).padStart(2,'0');
                const anterior=reg[campo]||'Não informado';
                if(reg[campo] && reg[campo]!==horaAtual &&
                    !confirm('Substituir o horário '+reg[campo]+' de '+labelCampo+' pelo horário atual '+horaAtual+'?')){
                    marcar.checked=false;return;
                }
                // Reusa o fluxo original (incluindo chaves/presença) e depois trava só o campo confirmado.
                reg.horariosConfirmados[campo]=false;
                const estadoSalvo=reg.horariosSalvos;
                reg.horariosSalvos=false;
                try{
                    atualizarControleHorario(p.id,campo,horaAtual);
                }finally{
                    reg.horariosSalvos=estadoSalvo;
                    reg.horariosConfirmados[campo]=true;
                    window.__auditarOcorrenciaChave?.({
                        personId:String(p.id),personName:String(p.nome||''),quarto:String(room.numero),
                        field:'entrada e saída — horário confirmado por checkbox ('+labelCampo+')',
                        previous:anterior,next:horaAtual+' · travado',origin:'controle de entrada e saída'
                    });
                    salvarControleES();renderControleEntradaSaida();atualizarIndicadoresPresencaABD();
                }
            });
            // Enter confirma a saída e pergunta sobre a chave. A digitação,
            // a mudança de foco e o clique na checkbox NÃO abrem o modal.
            const confirmarChavePeloEnter=()=>{
                if(campo!=='s1'&&campo!=='s2')return;
                const reg=controleESRegistro(p);
                if(!reg[campo])return;
                abrirPerguntaChave(p,room,labelCampo);
            };
            input.addEventListener('keydown',ev=>{
                if(ev.key!=='Enter'||ev.isComposing)return;
                ev.preventDefault();
                ev.stopPropagation();
                // Salva rascunho mesmo se a edição ainda não provocou blur/change.
                const reg=controleESRegistro(p);
                if(!input.disabled&&input.value&&/^([01]\\d|2[0-3]):[0-5]\\d$/.test(input.value)){
                    reg[campo]=input.value;
                    salvarNoStorage();
                }
                confirmarChavePeloEnter();
            });
            // Também permite Enter na checkbox já marcada, sem abrir modal
            // por um clique de mouse ou por marcação automática.
            marcar.addEventListener('keydown',ev=>{
                if(ev.key!=='Enter'||ev.isComposing)return;
                ev.preventDefault();ev.stopPropagation();
                confirmarChavePeloEnter();
            });
            // Digitação manual: guarda a hora mesmo sem marcar a checkbox nem usar Salvar horários.
            // Não bloqueia automaticamente nem recria a linha enquanto o usuário digita.
            const horarioAntesDaEdicao=r[campo]||'';
            input.addEventListener('input',()=>{
                const reg=controleESRegistro(p);
                if(reg.horariosConfirmados[campo]===true || reg.horariosSalvos)return;
                if(input.value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value))return;
                reg[campo]=input.value;
                reg.horariosConfirmados[campo]=false;
                // Persiste o valor atual sem disparar renderização ou confirmação da checkbox.
                salvarNoStorage();
                tr.classList.toggle('abd-controle-presente-esmaecido',deveEsmaecerPessoaNoControle(p));
            });
            input.addEventListener('change',()=>{
                const reg=controleESRegistro(p);
                if(reg.horariosConfirmados[campo]===true || reg.horariosSalvos){
                    renderControleEntradaSaida();return;
                }
                const horario=input.value;
                if(horario&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario))return;
                // O input já salvou o rascunho. Usa o fluxo de horários para atualizar
                // presença, chave e registros, sem travar a célula digitada manualmente.
                reg.horariosConfirmados[campo]=false;
                if(horario!==horarioAntesDaEdicao){
                    atualizarControleHorario(p.id,campo,horario);
                    window.__auditarOcorrenciaChave?.({
                        personId:String(p.id),personName:String(p.nome||''),quarto:String(room.numero),
                        field:'entrada e saída — horário digitado manualmente ('+labelCampo+')',
                        previous:horarioAntesDaEdicao||'Não informado',
                        next:horario||'Não informado',origin:'controle de entrada e saída'
                    });
                }
                salvarNoStorage();
                atualizarIndicadoresPresencaABD();
            });
            td.append(input,marcar);tr.appendChild(td);
        });
        const tdO=document.createElement('td');tdO.className='controle-observacao';tdO.dataset.label='Observação';const ta=document.createElement('textarea');ta.rows=1;ta.value=r.observacao||'';ta.placeholder='Observação';ta.onchange=()=>{controleESRegistro(p).observacao=ta.value;const historico=acolhimentosHistorico.find(h=>String(h.pessoaId||'')===String(p.id||'') && String(h.entrada||'')===String(p.entrada||''));if(historico){historico.observacaoControle=ta.value;salvarHistoricoAcolhimentos();}salvarControleES();};tdO.appendChild(ta);
        const acoes=document.createElement('div');acoes.className='controle-horarios-acoes';
        const botao=document.createElement('button');botao.type='button';
        botao.className=r.horariosSalvos?'btn-secondary':'btn-success';
        botao.textContent=r.horariosSalvos?'Destravar horários':'Salvar horários';
        botao.title=r.horariosSalvos?'Liberar edição dos horários manuais (mantém checkboxes confirmadas)':'Travar edição dos horários manuais (mantém checkboxes confirmadas)';
        botao.onclick=()=>{
            const reg=controleESRegistro(p);
            const proximoEstado=!reg.horariosSalvos;
            // Não modifica valores dos campos nem o estado das quatro checkboxes.
            reg.horariosSalvos=proximoEstado;
            window.__auditarOcorrenciaChave?.({
                personId:String(p.id),personName:String(p.nome||''),quarto:String(room.numero),
                field:'entrada e saída — '+(proximoEstado?'travar':'destravar')+' edição manual',
                previous:proximoEstado?'liberado':'travado',next:proximoEstado?'travado':'liberado',
                origin:'controle de entrada e saída'
            });
            salvarControleES();
        };
        acoes.appendChild(botao);tdO.appendChild(acoes);tr.appendChild(tdO);body.appendChild(tr);
    });
}


function alternarControleEntradaSaida(){
    const panel=document.getElementById('controleEntradaSaidaPanel');
    if(!panel) return;
    const abrir=!panel.classList.contains('aberto');
    panel.classList.toggle('aberto',abrir);
    if(abrir) renderControleEntradaSaida();
}

// Filtros exclusivamente visuais: não alteram quartos, pessoas ou backups.
// Preferências de visualização locais, independentes do operador e dos dados dos acolhidos.
const CHAVE_LAYOUT_QUARTOS='frei_damiao_layout_quartos_v1';
function lerPreferenciasLayout(){
    try{
        const salvo=JSON.parse(localStorage.getItem(CHAVE_LAYOUT_QUARTOS)||'null');
        return salvo && typeof salvo==='object' && !Array.isArray(salvo) ? salvo : {};
    }catch(e){console.warn('Não foi possível recuperar as preferências visuais.',e);return {};}
}
const layoutQuartosSalvo=lerPreferenciasLayout();
const filtroVisualQuartos={disponiveis:true,indisponiveis:true,comVagas:false,comPessoas:false,busca:''};
for(const campo of ['disponiveis','indisponiveis','comVagas','comPessoas']){
    if(typeof layoutQuartosSalvo.filtros?.[campo]==='boolean')filtroVisualQuartos[campo]=layoutQuartosSalvo.filtros[campo];
}
if(typeof layoutQuartosSalvo.filtros?.busca==='string')filtroVisualQuartos.busca=layoutQuartosSalvo.filtros.busca.slice(0,200);
const quartosMinimizados = new Set(Array.isArray(layoutQuartosSalvo.minimizados) ? layoutQuartosSalvo.minimizados.map(String).filter(x=>/^\d+$/.test(x)).slice(0,1000) : []);
function salvarPreferenciasLayout(){
    try{
        localStorage.setItem(CHAVE_LAYOUT_QUARTOS,JSON.stringify({
            filtros:{...filtroVisualQuartos},
            minimizados:[...quartosMinimizados]
        }));
    }catch(e){console.warn('Não foi possível salvar a visualização dos quartos.',e);}
}

function normalizarFiltroQuartos(valor){
    return String(valor??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}
function quartoPassaFiltro(room){
    const indisponivel=normalizarFiltroQuartos(room.status)==='indisponivel';
    if(indisponivel&&!filtroVisualQuartos.indisponiveis)return false;
    if(!indisponivel&&!filtroVisualQuartos.disponiveis)return false;
    // Vagas consideram apenas a capacidade padrão e pessoas ainda acolhidas.
    if(filtroVisualQuartos.comVagas && (indisponivel || capacidadePadraoRoom(room)-contarOcupantes(room)<=0))return false;
    if(filtroVisualQuartos.comPessoas && contarOcupantes(room)<=0)return false;
    const busca=normalizarFiltroQuartos(filtroVisualQuartos.busca);
    if(!busca)return true;
    return normalizarFiltroQuartos(room.numero).includes(busca) ||
        (room.pessoas||[]).some(p=>normalizarFiltroQuartos(p.nome).includes(busca));
}
function atualizarFiltroQuartos(){
    const todos=document.getElementById('filtroTodosQuartos');
    const disponiveis=document.getElementById('filtroQuartosDisponiveis');
    const indisponiveis=document.getElementById('filtroQuartosIndisponiveis');
    if(!todos||!disponiveis||!indisponiveis)return;
    todos.checked=filtroVisualQuartos.disponiveis&&filtroVisualQuartos.indisponiveis;
    disponiveis.checked=filtroVisualQuartos.disponiveis;
    indisponiveis.checked=filtroVisualQuartos.indisponiveis;
    document.getElementById('filtroComVagas').checked=filtroVisualQuartos.comVagas;
    document.getElementById('filtroComPessoas').checked=filtroVisualQuartos.comPessoas;
    document.getElementById('filtroBuscaQuartoPessoa').value=filtroVisualQuartos.busca;
    salvarPreferenciasLayout();
    render();
}
function iniciarFiltroQuartos(){
    document.getElementById('filtroTodosQuartos').addEventListener('change',e=>{
        filtroVisualQuartos.disponiveis=e.target.checked;
        filtroVisualQuartos.indisponiveis=e.target.checked;
        atualizarFiltroQuartos();
    });
    document.getElementById('filtroQuartosDisponiveis').addEventListener('change',e=>{
        filtroVisualQuartos.disponiveis=e.target.checked;
        atualizarFiltroQuartos();
    });
    document.getElementById('filtroQuartosIndisponiveis').addEventListener('change',e=>{
        filtroVisualQuartos.indisponiveis=e.target.checked;
        atualizarFiltroQuartos();
    });
    document.getElementById('filtroComVagas').addEventListener('change',e=>{
        filtroVisualQuartos.comVagas=e.target.checked;
        atualizarFiltroQuartos();
    });
    document.getElementById('filtroComPessoas').addEventListener('change',e=>{
        filtroVisualQuartos.comPessoas=e.target.checked;
        atualizarFiltroQuartos();
    });
    document.getElementById('filtroBuscaQuartoPessoa').addEventListener('input',e=>{
        filtroVisualQuartos.busca=e.target.value;
        salvarPreferenciasLayout();
        render();
    });
    document.getElementById('filtroLimparBusca').addEventListener('click',()=>{
        filtroVisualQuartos.busca='';
        document.getElementById('filtroBuscaQuartoPessoa').value='';
        salvarPreferenciasLayout();
        render();
    });
    // Reaplica as opções visuais restauradas sem alterar os dados persistidos.
    atualizarFiltroQuartos();
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',iniciarFiltroQuartos);
else iniciarFiltroQuartos();


// Resumo em tempo real: usa as mesmas regras dos relatórios ODT e impressão.
// A pesquisa apenas oculta quartos; não altera estes totais gerais.
function atualizarResumoFiltroQuartos(){
    const idade = p => idadeDaPessoa(p);
    const crianca = p => idade(p)!==null && idade(p)<12;
    const adolescente = p => idade(p)!==null && idade(p)>=12 && idade(p)<18;
    const idoso = p => idade(p)!==null && idade(p)>=60;
    const genero = nome => contarCategoria(p=>
        !crianca(p) && !adolescente(p) && !idoso(p) &&
        normalizarGenero(p.genero)===normalizarGenero(nome));
    const vagasMulher=contarVagasPorTipo('Mulher');
    const vagasHomem=contarVagasPorTipo('Homem');
    const vagasIdoso=contarVagasPorTipo('Idoso');
    const vagasVepema=contarVagasPorTipo('VEPEMA');
    const vagasTrans=contarVagasPorTipo('Trans');
    const vagasOutro=contarVagasPorTipo('Outro');
    const valores={
        resumoTotalAcolhidos:contarCategoria(()=>true),
        resumoMulheres:genero('feminino'),
        resumoHomens:genero('masculino'),
        resumoCriancas:contarCategoria(crianca),
        resumoAdolescentes:contarCategoria(adolescente),
        resumoIdosos:contarCategoria(idoso),
        resumoTrans:genero('trans'),
        resumoTotalVagas:vagasMulher+vagasHomem+vagasIdoso+vagasTrans+vagasOutro,
        resumoVagasMulher:vagasMulher,
        resumoVagasHomem:vagasHomem,
        resumoVagasIdoso:vagasIdoso,
        resumoVagasVepema:vagasVepema,
        resumoVagasTrans:vagasTrans,
        resumoVagasOutro:vagasOutro
    };
    for(const [id,valor] of Object.entries(valores)){
        const el=document.getElementById(id);
        if(el)el.textContent=String(valor);
    }
}

/* Modelo 2: painel de leitura rápida. Os editores originais não são recriados. */
const CHAVE_MODO_QUARTOS='acolhimento_modo_quartos_modelo2';
let modoQuartosAtual=(()=>{try{return (['detalhes','mapa'].includes(localStorage.getItem(CHAVE_MODO_QUARTOS))?localStorage.getItem(CHAVE_MODO_QUARTOS):'cartoes');}catch(_){return 'cartoes';}})();
function aplicarModoQuartos(){
    document.body.classList.toggle('layout-cartoes-ativo',modoQuartosAtual==='cartoes');
    document.body.classList.toggle('layout-detalhes-ativo',modoQuartosAtual==='detalhes');
    document.body.classList.toggle('layout-mapa-ativo',modoQuartosAtual==='mapa');
    const a=document.getElementById('modoQuartosCartoes'),b=document.getElementById('modoQuartosDetalhes');
    if(a)a.setAttribute('aria-pressed',String(modoQuartosAtual==='cartoes'));
    if(b)b.setAttribute('aria-pressed',String(modoQuartosAtual==='detalhes'));
    const mapa=document.getElementById('modoQuartosMapa');if(mapa)mapa.setAttribute('aria-pressed',String(modoQuartosAtual==='mapa'));
}
function definirModoQuartos(modo,numero){
    if(typeof fecharModalQuartoABD==='function' && modalQuartoABD.numero!==null)fecharModalQuartoABD(true);
    modoQuartosAtual=['detalhes','mapa'].includes(modo)?modo:'cartoes';
    try{localStorage.setItem(CHAVE_MODO_QUARTOS,modoQuartosAtual);}catch(_){}
    aplicarModoQuartos();
    if(numero!==undefined){
        const card=[...document.querySelectorAll('#areas .quarto-card')].find(x=>x.dataset.quarto===String(numero));
        if(card){
            if(modoQuartosAtual==='detalhes' && quartosMinimizados.has(String(numero))){
                const btn=card.querySelector('.btn-minimizar-quarto');
                if(btn)alternarResumoQuarto(numero,card,btn);
            }
            card.scrollIntoView({block:'start',behavior:'smooth'});
        }
    }
}
const modalQuartoABD={numero:null,aba:'tudo',pessoaIndex:null,focoAnterior:null};
function montarModelo1Modal(card,room){
    const header=card.querySelector('.quarto-header');
    if(header && !header.querySelector('.abd-m1-secao')){
        const identificacao=document.createElement('section');identificacao.className='abd-m1-secao abd-m1-identificacao';
        const tituloId=document.createElement('h3');tituloId.textContent='🏠 Identificação do quarto';identificacao.append(tituloId);
        [...header.children].forEach(el=>identificacao.append(el));
        const identificacaoCampos=identificacao.querySelector('.quarto-identificacao');
        const classificacao=identificacao.querySelector(':scope > .quarto-classificacao');
        const configuracao=identificacao.querySelector('.capacidade-configuracao');
        if(identificacaoCampos){
            if(classificacao)identificacaoCampos.append(classificacao);
            if(configuracao){
                [...configuracao.children].filter(el=>el.matches('.capacidade-padrao-linha,.capacidade-excedente-linha')).forEach(el=>identificacaoCampos.append(el));
                const label=identificacaoCampos.querySelector('.capacidade-padrao-linha label');
                if(label){label.dataset.abdTextoOriginal=label.textContent;label.textContent='🛏️ Nº de camas padrão:';}
            }
            const envolverSelect=(seletor,titulo)=>{
                const select=identificacaoCampos.querySelector(seletor);
                if(!select||select.closest('.abd-m1-campo-select'))return;
                const rotulo=document.createElement('label');rotulo.className='abd-m1-campo-select';
                const texto=document.createElement('span');texto.textContent=titulo;
                select.before(rotulo);rotulo.append(texto,select);
            };
            envolverSelect('.room-status','Status:');
            envolverSelect('.room-type-classification','Tipo:');
            envolverSelect('.room-type','Tipo de Cama:');
        }
        header.append(identificacao);
    }
    let tabela=card.querySelector(':scope > .abd-m1-acolhidos');
    if(!tabela){tabela=document.createElement('section');tabela.className='abd-m1-acolhidos';card.append(tabela);}
    tabela.replaceChildren();
    const cab=document.createElement('div');cab.className='abd-m1-acolhidos-cab';
    const titulo=document.createElement('h3');titulo.textContent='👥 Acolhidos';
    const adicionar=document.createElement('button');adicionar.type='button';adicionar.className='abd-m1-adicionar';adicionar.textContent='+ Adicionar pessoa';
    const addOriginal=card.querySelector('.btn-adicionar');
    adicionar.disabled=!addOriginal;
    adicionar.addEventListener('click',()=>addOriginal?.click());
    cab.append(titulo,adicionar);tabela.append(cab);
    const rolagem=document.createElement('div');rolagem.className='abd-m1-tabela-rolagem';
    const tabelaHtml=document.createElement('table');tabelaHtml.className='abd-m1-tabela';
    const colunas=document.createElement('colgroup');
    ['30.5%','15%','13%','10.5%','31%'].forEach(largura=>{const col=document.createElement('col');col.style.width=largura;colunas.append(col)});
    tabelaHtml.append(colunas);
    const thead=document.createElement('thead'),trCab=document.createElement('tr');
    ['Nome','Idade','Entrada','Saída','Ações'].forEach(nome=>{const th=document.createElement('th');th.textContent=nome;trCab.append(th);});
    thead.append(trCab);tabelaHtml.append(thead);
    const tbody=document.createElement('tbody');
    (room.pessoas||[]).forEach((p,index)=>{
        const tr=document.createElement('tr');
        const idade=idadeDaPessoa(p);
        const dados=[String(p.nome||'Cadastro sem nome'),idade===null?'—':idade+' anos',resumoDataQuarto(p.entrada),resumoDataQuarto(p.saida)];
        dados.forEach(valor=>{const td=document.createElement('td');td.textContent=valor;tr.append(td);});
        const acoes=document.createElement('td'),editar=document.createElement('button');editar.type='button';editar.className='abd-m1-editar-pessoa';editar.textContent='✏️ Editar';
        editar.setAttribute('aria-label','Editar cadastro de '+String(p.nome||'pessoa '+(index+1)));
        editar.addEventListener('click',()=>{modalQuartoABD.pessoaIndex=index;mostrarEdicaoModelo1(card);card.querySelectorAll('.quarto-pessoa-row')[index]?.scrollIntoView({block:'nearest'});});
        acoes.append(editar);tr.append(acoes);tbody.append(tr);
    });
    if(!tbody.children.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='Nenhuma pessoa cadastrada neste quarto.';tr.append(td);tbody.append(tr);}
    tabelaHtml.append(tbody);rolagem.append(tabelaHtml);tabela.append(rolagem);
    const fecharEdicao=document.createElement('button');fecharEdicao.type='button';fecharEdicao.className='abd-m1-fechar-edicao';fecharEdicao.textContent='Fechar edição do cadastro';
    fecharEdicao.addEventListener('click',()=>{modalQuartoABD.pessoaIndex=null;mostrarEdicaoModelo1(card);});
    tabela.append(fecharEdicao);
    mostrarEdicaoModelo1(card);
}
// Reposiciona os CONTROLES REAIS sem recriar botões nem perder seus eventos.
// Os marcadores devolvem cada botão ao lugar original quando a edição é fechada.
function posicionarBotoesAcolhidoReferencia(row,ativo){
    if(!row)return;
    // Os botões já são renderizados na barra superior; nunca remover ou recriar.
    if(row.querySelector('.abd-acoes-acolhido[data-fixed-actions="1"]'))return;
    const nomeEditor=row.querySelector('.nome-editor');
    if(!nomeEditor)return;
    if(ativo){
        let faixa=nomeEditor.querySelector(':scope > .abd-acoes-acolhido');
        if(!faixa){faixa=document.createElement('div');faixa.className='abd-acoes-acolhido';nomeEditor.appendChild(faixa);}
        for(const seletor of ['.btn-limpar','.btn-remover','.btn-transferir-pessoa','.btn-salvar-pessoa-unico']){
            const botao=row.querySelector(seletor);
            if(!botao || botao.parentElement===faixa)continue;
            const origem=document.createComment('Posição original de '+seletor);
            botao.parentNode.insertBefore(origem,botao);
            botao.__abdOrigemAcolhido=origem;
            faixa.appendChild(botao);
        }
    }else{
        const faixa=nomeEditor.querySelector(':scope > .abd-acoes-acolhido');
        if(!faixa)return;
        [...faixa.querySelectorAll('button')].forEach(botao=>{
            const origem=botao.__abdOrigemAcolhido;
            if(origem?.parentNode){origem.parentNode.replaceChild(botao,origem);}
            delete botao.__abdOrigemAcolhido;
        });
        faixa.remove();
    }
}
function mostrarEdicaoModelo1(card){
    card.querySelectorAll('.quarto-pessoa-row').forEach((row,index)=>{
        const ativo=modalQuartoABD.pessoaIndex===index;
        row.classList.toggle('abd-m1-pessoa-editando',ativo);
        posicionarBotoesAcolhidoReferencia(row,ativo);
    });
    card.classList.toggle('abd-m1-editando',modalQuartoABD.pessoaIndex!==null);
    card.querySelector('.abd-m1-fechar-edicao')?.toggleAttribute('hidden',modalQuartoABD.pessoaIndex===null);
}
function desmontarModelo1Modal(card){
    card.querySelectorAll('.quarto-pessoa-row').forEach(row=>posicionarBotoesAcolhidoReferencia(row,false));
    const header=card.querySelector('.quarto-header');
    if(header){
        const secoes=[...header.querySelectorAll(':scope > .abd-m1-secao')];
        secoes.forEach(secao=>{
            const identificacao=secao.querySelector('.quarto-identificacao');
            const classificacao=identificacao?.querySelector(':scope > .quarto-classificacao');
            const configuracao=secao.querySelector('.capacidade-configuracao');
            secao.querySelectorAll('.abd-m1-campo-select').forEach(rotulo=>{
                const select=rotulo.querySelector('select');
                if(select)rotulo.replaceWith(select);else rotulo.remove();
            });
            if(configuracao && identificacao){
                const label=identificacao.querySelector('.capacidade-padrao-linha label');
                if(label?.dataset.abdTextoOriginal){label.textContent=label.dataset.abdTextoOriginal;delete label.dataset.abdTextoOriginal;}
                [...identificacao.children].filter(el=>el.matches('.capacidade-padrao-linha,.capacidade-excedente-linha')).forEach(el=>configuracao.append(el));
            }
            if(classificacao)identificacao.after(classificacao);
            [...secao.children].filter(el=>el.tagName!=='H3').forEach(el=>header.append(el));
            secao.remove();
        });
    }
    card.querySelector(':scope > .abd-m1-acolhidos')?.remove();
    card.classList.remove('abd-m1-editando');
    card.querySelectorAll('.abd-m1-pessoa-editando').forEach(row=>row.classList.remove('abd-m1-pessoa-editando'));
}
function sincronizarModalQuartoABD(){
    document.querySelectorAll('#areas .quarto-card.abd-modal-aberto').forEach(el=>el.classList.remove('abd-modal-aberto','abd-modal-modelo1','abd-modal-aba-quarto','abd-modal-aba-pessoas','abd-modal-aba-tudo'));
    if(modalQuartoABD.numero===null)return;
    const card=[...document.querySelectorAll('#areas .quarto-card')].find(el=>el.dataset.quarto===modalQuartoABD.numero);
    if(!card){fecharModalQuartoABD(true);return;}
    card.classList.add('abd-modal-aberto','abd-modal-modelo1','abd-modal-aba-'+modalQuartoABD.aba);
    const room=state?.rooms?.[modalQuartoABD.numero]||Object.values(state?.rooms||{}).find(r=>String(r.numero)===modalQuartoABD.numero);
    if(room){
        let indicadores=card.querySelector(':scope > .abd-modal-indicadores');
        if(!indicadores){indicadores=document.createElement('div');indicadores.className='abd-modal-indicadores';card.prepend(indicadores);}
        const camas=capacidadePadraoRoom(room),ocupantes=contarOcupantes(room);
        const valores=[['🛏️','Camas padrão',camas],['👥','Ocupantes',ocupantes],['✅','Vagas disponíveis',room.status==='indisponivel'?0:Math.max(0,camas-ocupantes)]];
        indicadores.replaceChildren(...valores.map(([icone,rotulo,valor])=>{
            const bloco=document.createElement('div');bloco.className='abd-modal-indicador';
            const simbolo=document.createElement('span');simbolo.className='abd-modal-indicador-icone';simbolo.textContent=icone;
            const texto=document.createElement('span');texto.className='abd-modal-indicador-texto';
            const legenda=document.createElement('small');legenda.textContent=rotulo;
            const numero=document.createElement('strong');numero.textContent=String(valor);
            texto.append(legenda,numero);bloco.append(simbolo,texto);return bloco;
        }));
        montarModelo1Modal(card,room);
    }
    document.querySelectorAll('[data-abd-modal-aba]').forEach(btn=>{
        const selecionada=btn.dataset.abdModalAba===modalQuartoABD.aba;
        btn.setAttribute('aria-selected',String(selecionada));btn.tabIndex=selecionada?0:-1;
    });
    document.getElementById('abdModalQuartoTitulo').textContent='Gerenciar quarto '+modalQuartoABD.numero;
}
function abrirModalQuartoABD(numero){
    modalQuartoABD.numero=String(numero);
    modalQuartoABD.aba='tudo';
    modalQuartoABD.pessoaIndex=null;
    modalQuartoABD.focoAnterior=document.activeElement;
    document.body.classList.add('abd-modal-quarto-ativo');
    document.getElementById('abdModalQuartoFundo').hidden=false;
    document.getElementById('abdModalQuartoTopo').hidden=false;
    sincronizarModalQuartoABD();
    document.getElementById('abdModalQuartoFechar').focus();
}
function fecharModalQuartoABD(semFoco=false){
    const anterior=modalQuartoABD.focoAnterior;
    document.querySelectorAll('#areas .quarto-card.abd-modal-aberto').forEach(desmontarModelo1Modal);
    modalQuartoABD.numero=null;modalQuartoABD.focoAnterior=null;
    modalQuartoABD.pessoaIndex=null;
    document.body.classList.remove('abd-modal-quarto-ativo');
    document.getElementById('abdModalQuartoFundo').hidden=true;
    document.getElementById('abdModalQuartoTopo').hidden=true;
    sincronizarModalQuartoABD();
    document.querySelectorAll('#areas .quarto-card > .abd-modal-indicadores').forEach(el=>el.remove());
    if(!semFoco && anterior?.isConnected)anterior.focus();
}
document.getElementById('abdModalQuartoFechar').addEventListener('click',()=>fecharModalQuartoABD());
document.getElementById('abdModalQuartoFundo').addEventListener('click',()=>fecharModalQuartoABD());
document.querySelectorAll('[data-abd-modal-aba]').forEach(btn=>btn.addEventListener('click',()=>{
    if(modalQuartoABD.numero===null)return;
    modalQuartoABD.aba=btn.dataset.abdModalAba;
    sincronizarModalQuartoABD();
}));
document.addEventListener('keydown',event=>{
    if(modalQuartoABD.numero===null)return;
    if(event.key==='Tab'){
        const card=document.querySelector('#areas .quarto-card.abd-modal-aberto');
        const controles=[...document.querySelectorAll('#abdModalQuartoTopo button'),...(card?[...card.querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]):not([hidden]),select:not([disabled]):not([hidden]),textarea:not([disabled]):not([hidden])')]:[])].filter(el=>el.getClientRects().length);
        if(controles.length){
            const primeiro=controles[0],ultimo=controles[controles.length-1];
            if(event.shiftKey && document.activeElement===primeiro){event.preventDefault();ultimo.focus();}
            else if(!event.shiftKey && document.activeElement===ultimo){event.preventDefault();primeiro.focus();}
        }
    }
    if(event.key==='Escape'){
        // Diálogos internos de edição devem receber Escape antes da janela do quarto.
        if(document.querySelector('.modal.aberto,.modal-backdrop.aberto,[role="dialog"][aria-modal="true"]:not(#abdModalQuartoTopo):not([hidden])'))return;
        event.preventDefault();fecharModalQuartoABD();
    }
});
// Usa as mesmas fotos e chaves de identificação do histórico, sem duplicar os arquivos.
function obterFotoAvatarModelo2(pessoa){
    const chave=chavePessoaHistorico(pessoa);
    if(!chave)return '';
    const atual=historicoFotos?.[chave];
    if(typeof atual==='string' && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(atual))return atual;
    // Os lotes arquivados em IndexedDB já carregados também podem conter a foto.
    for(const lote of historicosLotes||[]){
        const foto=lote.fotos?.[chave];
        if(typeof foto==='string' && /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,/i.test(foto))return foto;
    }
    return '';
}
// Visualizador de foto: acessível por clique, Enter ou Espaço no avatar.
let abdVisualizadorFotoFocoAnterior=null;
function fecharVisualizadorFotoABD(){
 const camada=document.getElementById('abdVisualizadorFotoCamada');
 if(!camada||camada.hidden)return;
 camada.hidden=true;
 camada.querySelector('.abd-foto-ampliada')?.removeAttribute('src');
 document.body.classList.remove('abd-foto-visualizador-aberto');
 if(abdVisualizadorFotoFocoAnterior?.isConnected)abdVisualizadorFotoFocoAnterior.focus();
 abdVisualizadorFotoFocoAnterior=null;
}
function abrirVisualizadorFotoABD(pessoa,avatar){
 const foto=obterFotoAvatarModelo2(pessoa);
 let camada=document.getElementById('abdVisualizadorFotoCamada');
 if(!camada){
  camada=document.createElement('div');
  camada.id='abdVisualizadorFotoCamada';
  camada.className='abd-foto-visualizador';
  camada.hidden=true;
  camada.setAttribute('role','dialog');
  camada.setAttribute('aria-modal','true');
  camada.setAttribute('aria-labelledby','abdVisualizadorFotoTitulo');
  const conteudo=document.createElement('div');conteudo.className='abd-foto-visualizador-conteudo';
  const cab=document.createElement('div');cab.className='abd-foto-visualizador-cab';
  const titulo=document.createElement('h3');titulo.id='abdVisualizadorFotoTitulo';
  const fechar=document.createElement('button');fechar.type='button';fechar.className='abd-foto-visualizador-fechar';fechar.textContent='✕ Fechar';
  fechar.addEventListener('click',fecharVisualizadorFotoABD);
  cab.append(titulo,fechar);
  const corpo=document.createElement('div');corpo.className='abd-foto-visualizador-corpo';
  conteudo.append(cab,corpo);camada.append(conteudo);document.body.append(camada);
  camada.addEventListener('click',ev=>{if(ev.target===camada)fecharVisualizadorFotoABD()});
  camada.addEventListener('keydown',ev=>{if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();fecharVisualizadorFotoABD()}else if(ev.key==='Tab'){
   ev.preventDefault();fechar.focus();
  }});
 }
 const nome=String(pessoa.nome||'Acolhido');
 camada.querySelector('#abdVisualizadorFotoTitulo').textContent='📷 Foto de '+nome;
 const corpo=camada.querySelector('.abd-foto-visualizador-corpo');corpo.replaceChildren();
 if(foto){
  const imagem=document.createElement('img');imagem.className='abd-foto-ampliada';imagem.alt='Fotografia cadastrada de '+nome;
  imagem.onerror=()=>{corpo.replaceChildren();const aviso=document.createElement('p');aviso.className='abd-foto-sem-imagem';aviso.textContent='Não foi possível abrir a foto cadastrada.';corpo.append(aviso)};
  imagem.src=foto;corpo.append(imagem);
 }else{
  const aviso=document.createElement('p');aviso.className='abd-foto-sem-imagem';
  aviso.textContent='Este acolhido ainda não possui fotografia cadastrada no histórico.';corpo.append(aviso);
 }
 abdVisualizadorFotoFocoAnterior=avatar||document.activeElement;
 camada.hidden=false;document.body.classList.add('abd-foto-visualizador-aberto');
 camada.querySelector('.abd-foto-visualizador-fechar').focus();
}
function preencherAvatarModelo2(avatar,pessoa){
    if(!avatar)return;
    const foto=obterFotoAvatarModelo2(pessoa);
    avatar.replaceChildren();
    if(foto){
        const img=document.createElement('img');
        img.className='modelo2-avatar-foto';
        img.alt='Foto de '+String(pessoa.nome||'acolhido');
        img.loading='lazy';
        img.decoding='async';
        img.onerror=()=>{avatar.replaceChildren(document.createTextNode(String(pessoa.nome||'?').trim().charAt(0).toUpperCase()));};
        img.src=foto;
        avatar.appendChild(img);
    }else{
        avatar.textContent=String(pessoa.nome||'?').trim().charAt(0).toUpperCase();
    }
}
function atualizarFotosCardsModelo2(){
    if(typeof state==='undefined'||!state?.rooms)return;
    document.querySelectorAll('#areas .modelo2-avatar[data-pessoa-foto-chave]').forEach(avatar=>{
        const chave=avatar.dataset.pessoaFotoChave;
        let pessoa=null;
        for(const room of Object.values(state.rooms)){
            pessoa=(room.pessoas||[]).find(p=>chavePessoaHistorico(p)===chave && String(p.nome||'').trim() && !String(p.saida||'').trim());
            if(pessoa)break;
        }
        if(pessoa)preencherAvatarModelo2(avatar,pessoa);
    });
}
function decorarQuartoModelo2(container,room){
    const card=container.lastElementChild;
    if(!card||!card.classList.contains('quarto-card'))return;
    const indisponivel=room.status==='indisponivel';
    const ocupantes=(room.pessoas||[]).filter(p=>String(p.nome||'').trim()&&!String(p.saida||'').trim());
    // Quartos com vários acolhidos recebem um cartão largo, sem alterar as vagas nem os dados.
    const muitosOcupantes=ocupantes.length>=6;
    card.classList.toggle('abd-card-muitos-ocupantes',muitosOcupantes);
    const total=contarOcupantes(room);
    const capacidade=capacidadePadraoRoom(room);
    const livre=indisponivel?0:Math.max(0,capacidade-total);
    const estado=indisponivel?'Indisponível':livre>0?(total>0?'Com vagas':'Disponível'):'Ocupado';
    const classe=indisponivel?'indisponivel':livre>0?'livre':'ocupado';
    const preview=document.createElement('section');
    preview.className='modelo2-preview modelo2-'+classe;
    preview.setAttribute('aria-label','Resumo do quarto '+room.numero);

    const cab=document.createElement('div');cab.className='modelo2-cabecalho';
    const titulo=document.createElement('div');titulo.className='modelo2-titulo';
    const small=document.createElement('span');small.textContent='QUARTO';
    const numero=document.createElement('strong');numero.textContent=String(room.numero);
    titulo.append(small,numero);

    const vagas=document.createElement('strong');
    vagas.className='modelo2-vagas-destaque '+(livre>0?'tem-vagas':'sem-vagas');
    vagas.textContent='Vagas: '+livre;

    const situacao=document.createElement('span');
    situacao.className='modelo2-situacao';
    situacao.textContent=estado;

    cab.append(titulo,vagas,situacao);

    const resumo=document.createElement('div');resumo.className='modelo2-resumo';
    const tipo=document.createElement('div');tipo.className='modelo2-tipo';tipo.textContent='Destinação: '+String(room.tipoQuarto||tipoQuartoPadrao(room.ala));
    const camas=document.createElement('span');camas.className='modelo2-resumo-item';camas.textContent='Camas: '+capacidade;
    const quantidade=document.createElement('span');quantidade.className='modelo2-resumo-item';quantidade.textContent='Ocupantes: '+total;
    resumo.append(tipo,camas,quantidade);

    const pessoas=document.createElement('div');pessoas.className='modelo2-pessoas';
    if(muitosOcupantes){
        pessoas.style.setProperty('--abd-linhas-tres',String(Math.ceil(ocupantes.length/3)));
        pessoas.style.setProperty('--abd-linhas-duas',String(Math.ceil(ocupantes.length/2)));
    }
    const abreviarNomeVinculo=nome=>String(nome||'').trim().split(/\s+/).filter(Boolean).slice(0,2).join(' ');

    if(indisponivel){
        const aviso=document.createElement('p');aviso.className='modelo2-vazio';aviso.textContent=room.descricao||'Quarto indisponível';pessoas.append(aviso);
    }else if(!ocupantes.length){
        const vazio=document.createElement('p');vazio.className='modelo2-vazio';vazio.textContent='Nenhuma pessoa acolhida neste quarto';pessoas.append(vazio);
    }else for(const p of ocupantes){
        const item=document.createElement('div');item.className='modelo2-pessoa';
        const bolinha=document.createElement('span');
        bolinha.className='modelo2-avatar';
        bolinha.dataset.pessoaFotoChave=chavePessoaHistorico(p);
        preencherAvatarModelo2(bolinha,p);
        bolinha.classList.add('abd-avatar-clicavel');
        bolinha.setAttribute('role','button');
        bolinha.tabIndex=0;
        bolinha.setAttribute('aria-label','Visualizar fotografia de '+String(p.nome||'acolhido'));
        bolinha.title='Clique para visualizar a fotografia de '+String(p.nome||'acolhido');
        bolinha.addEventListener('click',ev=>{ev.stopPropagation();abrirVisualizadorFotoABD(p,bolinha)});
        bolinha.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();ev.stopPropagation();abrirVisualizadorFotoABD(p,bolinha)}});
        const info=document.createElement('div');info.className='modelo2-pessoa-info';
        const nome=document.createElement('div');nome.className='modelo2-pessoa-nome';nome.textContent=String(p.nome||'');

        const anos=idadeDaPessoa(p);
        let idadeTexto=anos===null?'Idade não informada':anos+' '+(anos===1?'ano':'anos');
        if(anos===0 && /^\d{4}-\d{2}-\d{2}$/.test(String(p.nascimento||''))){
            const [ano,mes,dia]=p.nascimento.split('-').map(Number),hoje=new Date();
            let meses=(hoje.getFullYear()-ano)*12+hoje.getMonth()+1-mes;
            if(hoje.getDate()<dia)meses--;
            if(meses>=0)idadeTexto=meses+' '+(meses===1?'mês':'meses');
        }
        const genero=normalizarGenero(p.genero);
        const categoria=anos===null?'Não informado':anos>=60?'Idoso(a)':anos<12?'Criança':anos<18?'Adolescente':genero==='feminino'?'Mulher':genero==='masculino'?'Homem':genero==='trans'||genero==='transexual'?'Trans':'Outro';
        const tempo=formatarTempoAcolhimento(p.entrada,p.saida).replace(/^Tempo de Acolhimento:\s*/,'');
        const situacaoAcolhimento=String(p.saida||'').trim()?'Desligada':'Acolhida';

        const detalhe=document.createElement('div');detalhe.className='modelo2-pessoa-detalhe';
        detalhe.textContent=idadeTexto+' · '+categoria+' · '+situacaoAcolhimento+' - '+tempo;

        const dependentesDaPessoa=(room.pessoas||[]).filter(x=>x.id!==p.id && String(x.nome||'').trim() && (
            (String(x.responsavelId||'').trim() && String(x.responsavelId)===String(p.id||'')) ||
            (!String(x.responsavelId||'').trim() && String(x.responsavel||'').trim() && normalizarBuscaHistorico(x.responsavel)===normalizarBuscaHistorico(p.nome))
        ));
        const nomeResponsavelVinculo=(room.pessoas||[]).find(x=>String(x.id||'')===String(p.responsavelId||'') && String(p.responsavelId||'').trim());
        const responsavelExibido=nomeResponsavelVinculo?.nome||p.responsavel||'';

        let vinculoTexto='';
        if(dependentesDaPessoa.length){
            vinculoTexto=(dependentesDaPessoa.length===1?'Dependente: ':'Dependentes: ')+dependentesDaPessoa.map(x=>abreviarNomeVinculo(x.nome)).join(', ');
        }else if(responsavelExibido){
            vinculoTexto='Responsável: '+abreviarNomeVinculo(responsavelExibido);
        }
        if(vinculoTexto){
            const vinculo=document.createElement('div');
            vinculo.className='modelo2-pessoa-vinculo';
            vinculo.textContent=vinculoTexto;
            info.append(nome,detalhe,vinculo);
        }else{
            info.append(nome,detalhe);
        }
        const ponto=document.createElement('span');
        ponto.className='abd-presenca-ponto '+(pessoaEstaForaNoControle(p)?'abd-presenca-ausente':'abd-presenca-presente');
        ponto.setAttribute('data-abd-presenca-id',String(p.id));
        ponto.title=(pessoaEstaForaNoControle(p)?'Ausente':'Presente')+' — '+(p.nome||'acolhido');
        ponto.setAttribute('aria-label',ponto.title);
        item.append(bolinha,info,ponto);
        pessoas.append(item);
    }

    const acao=document.createElement('button');acao.type='button';acao.className='modelo2-ver-detalhes';
    acao.textContent=indisponivel?'⚙ Gerenciar quarto':'🖊️ Abrir cadastro completo';
    acao.addEventListener('click',()=>abrirModalQuartoABD(room.numero));
    preview.append(cab,resumo,pessoas,acao);
    card.prepend(preview);
}

/* Integração visual A+B+D; sem modificar o modelo de dados ou operações. */
function atualizarLayoutABD(){
  const ler=(id)=>document.getElementById(id)?.textContent?.trim()||'0';
  const vals={abdTotalPessoas:ler('resumoTotalAcolhidos'),abdTotalVagas:ler('resumoTotalVagas'),abdTotalVepema:ler('resumoVagasVepema')};
  const encontrados=document.getElementById('filtroQuartosResultado')?.textContent||'';
  vals.abdTotalQuartos=encontrados.match(/\d+/)?.[0]||'0';
  Object.entries(vals).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.textContent=val;});
  const mapa=document.getElementById('abdMapaQuartos');if(!mapa)return;
  mapa.querySelectorAll('.abd-map-group').forEach(el=>el.remove());
  const alas=['feminina','idoso','masculina'];
  for(const ala of alas){
    const rooms=Object.values(state.rooms).filter(r=>r.ala===ala&&quartoPassaFiltro(r)).sort((a,b)=>Number(a.numero)-Number(b.numero));
    if(!rooms.length)continue;
    const sec=document.createElement('section');sec.className='abd-map-group';
    const head=document.createElement('div');head.className='abd-map-group-head';
    const title=document.createElement('h3');title.textContent=nomeAla(ala);
    const qtd=document.createElement('span');qtd.className='abd-map-count';qtd.textContent=rooms.length+' quarto(s)';head.append(title,qtd);
    const grid=document.createElement('div');grid.className='abd-map-grid';
    rooms.forEach(room=>{
      const indisponivel=room.status==='indisponivel';
      const ocupantes=contarOcupantes(room),cap=capacidadePadraoRoom(room);
      const livre=indisponivel?0:Math.max(0,cap-ocupantes);
      const status=indisponivel?'indisponivel':ocupantes&&livre?'com-vagas':livre?'disponivel':'ocupado';
      const tipo=String(room.tipoQuarto||tipoQuartoPadrao(room.ala));
      const btn=document.createElement('button');btn.type='button';btn.className='abd-map-cell '+status+(tipo.toUpperCase().includes('VEPEMA')?' vepema':'');
      const n=document.createElement('strong');n.textContent=String(room.numero);
      const v=document.createElement('small');v.textContent=indisponivel?'Indisponível':ocupantes+' / '+cap;
      const txt=document.createElement('span');txt.textContent=indisponivel?'Sem uso':(livre+' vaga(s)');
      btn.append(n,v,txt);
      const pessoasAtivas=(room.pessoas||[]).filter(p=>pessoaAtivaResumo(p)&&String(p.nome||'').trim());
      if(pessoasAtivas.length){
        const indicadores=document.createElement('span');indicadores.className='abd-map-presencas';
        for(const pessoa of pessoasAtivas){
          const ponto=document.createElement('span');ponto.className='abd-presenca-ponto '+(pessoaEstaForaNoControle(pessoa)?'abd-presenca-ausente':'abd-presenca-presente');
          ponto.setAttribute('data-abd-presenca-id',String(pessoa.id));
          ponto.title=(pessoaEstaForaNoControle(pessoa)?'Ausente':'Presente')+' — '+pessoa.nome;
          ponto.setAttribute('aria-label',ponto.title);
          indicadores.append(ponto);
        }
        btn.append(indicadores);
      }
      btn.title='Abrir quarto '+room.numero+' — '+tipo;
      btn.setAttribute('aria-label','Abrir cadastro do quarto '+room.numero+'; '+ocupantes+' ocupantes e '+livre+' vagas');
      btn.addEventListener('click',()=>definirModoQuartos('detalhes',room.numero));
      grid.append(btn);
    });
    sec.append(head,grid);mapa.append(sec);
  }
}
function navegarABD(alvo){
  const go=(id)=>document.getElementById(id)?.scrollIntoView({behavior:'smooth',block:'start'});
  if(alvo==='painel')go('abdPainelGeral');
  else if(alvo==='quartos'){definirModoQuartos('cartoes');go('filtroQuartos');}
  else if(alvo==='mapa'){definirModoQuartos('mapa');go('abdMapaQuartos');}
  else if(alvo==='funcionarios')go('blocoEquipeAdmin');
  else if(alvo==='arquivos')go('btnEscolherPastaBackup');
  else if(alvo==='acesso')document.getElementById('btnAbrirControleEntradaSaida')?.click();
  else if(alvo==='historico')document.getElementById('btnAbrirHistorico')?.click();
  else if(alvo==='auditoria')document.getElementById('authAuditBtn')?.click();
  document.querySelectorAll('[data-abd-nav]').forEach(btn=>btn.classList.toggle('abd-selected',btn.dataset.abdNav===alvo));
}

function render(){
    aplicarModoQuartos();
    document.getElementById('selectPlantao').value=state.selectPlantao;
    const areas=document.getElementById('areas');
    areas.innerHTML='';
    let quartosExibidos=0;
    ['feminina','idoso','masculina'].forEach(ala=>{
        const quartosFiltrados=Object.values(state.rooms).filter(r=>r.ala===ala&&quartoPassaFiltro(r)).sort((a,b)=>a.numero-b.numero);
        if(!quartosFiltrados.length)return;
        quartosExibidos+=quartosFiltrados.length;
        const card=document.createElement('div');
        card.className='card areas-ala-card ala-'+ala;
        card.innerHTML='<h3>'+nomeAla(ala)+'</h3><div class="quartos-list"></div>';
        const lista=card.querySelector('.quartos-list');
        quartosFiltrados.forEach(room=>{renderRoom(lista,room);decorarQuartoModelo2(lista,room);});
        areas.appendChild(card);
    });
    const resumoFiltro=document.getElementById('filtroQuartosResultado');
    if(resumoFiltro)resumoFiltro.textContent=quartosExibidos+' quarto(s) encontrado(s).';
    atualizarResumoFiltroQuartos();
    atualizarLayoutABD();
    if(!quartosExibidos)areas.innerHTML='<div class="card">Nenhum quarto encontrado para os filtros selecionados.</div>';
    renderEmployees();
    renderControleEntradaSaida();
    document.getElementById('btnDesfazer').disabled=!temUndoValido();
    document.getElementById('btnRefazer').disabled=future.length===0;
    sincronizarModalQuartoABD();
}

function prepararPessoa(p){
  p.genero = p.genero || 'Não informado';
  if(typeof p.acessibilidade !== 'boolean') p.acessibilidade = false;
  if(typeof p.necessidadeAcessibilidade !== 'string') p.necessidadeAcessibilidade = '';
  if(typeof p.origemNacionalidade !== 'string') p.origemNacionalidade = '';
  if(typeof p.nomeDemanda !== 'string') p.nomeDemanda = '';
  if(typeof p.observacao !== 'string') p.observacao = '';
  if(typeof p.responsavel !== 'string') p.responsavel = '';
  if(typeof p.responsavelId !== 'string') p.responsavelId = '';
  if(typeof p.cartaoSus !== 'string') p.cartaoSus = '';
  return p;
}

function classeLinhaPessoa(p,room){
    const classes=['linha-acolhido'];
    const nomePreenchido=!!(p.nome && p.nome.trim());
    const nascimentoPreenchido=!!(p.nascimento && p.nascimento.trim());

    const temSaida=!!String(p.saida||'').trim();
    if(temSaida){
        classes.push('linha-saida');
    } else if(!nomePreenchido && !nascimentoPreenchido){
        classes.push('linha-vazia');
    }

    const idadeAtual=idadeDaPessoa(p);
    const tipoQuartoAtual=normalizarGenero(room?.tipoQuarto||tipoQuartoPadrao(room?.ala));
    // O tipo do quarto não força o destaque amarelo; somente idade 60+ ou acessibilidade.
    // A variável é mantida para compatibilidade com estilos/código legado.
    // O amarelo do quarto é determinado pela classificação atual ou pela idade.
    // A linha só recebe o destaque amarelo quando a pessoa tem 60 anos ou mais
    // ou quando a acessibilidade foi marcada. A classificação do quarto, sozinha,
    // não transforma uma demanda normal em idosa.
    if(idadeAtual!==null && idadeAtual>=60) classes.push('linha-idoso');
    if(p.acessibilidade===true) classes.push('linha-acessibilidade');

    const genero=String(p.genero || 'Não informado')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .toLowerCase()
        .trim();

    if(genero==='feminino') classes.push('linha-genero-feminino');
    else if(genero==='masculino') classes.push('linha-genero-masculino');
    else if(genero==='trans') classes.push('linha-genero-trans');
    else if(genero==='outro') classes.push('linha-genero-outro');
    else classes.push('linha-genero-nao-informado');

    return classes.join(' ');
}

// Estado apenas visual: minimizar não modifica nem salva os dados das pessoas.

function alternarResumoQuarto(numero, card, botao){
    const id=String(numero);
    const minimizar=!quartosMinimizados.has(id);
    if(minimizar) quartosMinimizados.add(id); else quartosMinimizados.delete(id);
    card.classList.toggle('quarto-minimizado',minimizar);
    botao.textContent=minimizar?'▣ Expandir':'▤ Minimizar';
    botao.setAttribute('aria-expanded',String(!minimizar));
    salvarPreferenciasLayout();
}
// Comandos gerais: alteram somente a apresentação das pessoas, sem alterar dados.
function definirResumoTodosQuartos(minimizar){
    document.querySelectorAll('#areas .quarto-card').forEach(card=>{
        const id=String(card.dataset.quarto||'');
        if(!id)return;
        if(minimizar)quartosMinimizados.add(id);
        else quartosMinimizados.delete(id);
        card.classList.toggle('quarto-minimizado',minimizar);
        const botao=card.querySelector('.btn-minimizar-quarto');
        if(botao){
            botao.textContent=minimizar?'▣ Expandir':'▤ Minimizar';
            botao.setAttribute('aria-expanded',String(!minimizar));
        }
    });
    // Também abrange quartos temporariamente ocultos pelos filtros.
    if(typeof state!=='undefined' && state.rooms){
        Object.values(state.rooms).forEach(room=>{
            const id=String(room.numero);
            if(minimizar)quartosMinimizados.add(id);
            else quartosMinimizados.delete(id);
        });
    }
    salvarPreferenciasLayout();
}
document.getElementById('btnMaximizarTodosQuartos').addEventListener('click',()=>definirResumoTodosQuartos(false));
document.getElementById('btnMinimizarTodosQuartos').addEventListener('click',()=>definirResumoTodosQuartos(true));
function resumoDataQuarto(data){
    const valor=String(data||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(valor))return '—';
    const [ano,mes,dia]=valor.split('-');
    return dia+'/'+mes+'/'+ano;
}
function renderRoom(container,room){
    const quartoCard=document.createElement('article');
    quartoCard.className='quarto-card';
    quartoCard.dataset.quarto=room.numero;
    quartoCard.classList.toggle('quarto-minimizado',quartosMinimizados.has(String(room.numero)));

    if(room.status==='indisponivel'){
        quartoCard.classList.add('quarto-indisponivel-card');
        const camasIndisponivel=capacidadePadraoRoom(room);
        quartoCard.innerHTML='<div class="quarto-header quarto-header-indisponivel">'+
            '<div class="quarto-identificacao"><div class="quarto-titulo-indisponivel"><span class="quarto-microtitulo">QUARTO</span><strong class="quarto-numero">'+room.numero+'</strong></div>'+
            '<select class="room-status" aria-label="Status do quarto"><option value="disponivel">Disponível</option><option value="indisponivel" selected>Indisponível</option></select></div>'+
            '<div class="quarto-indisponivel-camas">Camas: '+camasIndisponivel+'</div>'+
            '<div class="quarto-indisponibilidade"><span class="quarto-status-label">Indisponível</span><div class="descricao-indisponibilidade" contenteditable="true" role="textbox" aria-label="Descrição da indisponibilidade do quarto">'+escapar(room.descricao||'Motivo da indisponibilidade não informado')+'</div></div>'+
            '<div class="quarto-acoes-header"><button type="button" class="btn-success btn-tornar-disponivel">Disponibilizar</button></div>'+
            '</div>';
        container.appendChild(quartoCard);
        const rs=quartoCard.querySelector('.room-status');
        rs.onchange=()=>alterarStatus(room.numero,rs.value);
        quartoCard.querySelector('.descricao-indisponibilidade').onblur=()=>alterarDescricao(room.numero,quartoCard.querySelector('.descricao-indisponibilidade').textContent);
        quartoCard.querySelector('.btn-tornar-disponivel').onclick=()=>alterarStatus(room.numero,'disponivel');
        return;
    }

    const total=contarOcupantes(room);
    const cap=capacidadePadraoRoom(room);
    const statusNormalizado=String(room.status||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
    const disponivel=statusNormalizado==='disponivel'||statusNormalizado==='livre';

    if(room.pessoas.length===0) room.pessoas=[pessoaVazia()];
    room.pessoas.forEach(p=>prepararPessoa(p));

    const temDestaque=room.pessoas.some(p=>{
        const idade=p.nascimento?idadeDaPessoa(p):null;
        return (idade!==null&&idade>=60)||p.acessibilidade===true;
    });
    quartoCard.classList.toggle('vazio-disponivel',total===0&&disponivel);
    quartoCard.classList.toggle('idoso-acessibilidade',temDestaque);

    const pessoasWrap=document.createElement('div');
    pessoasWrap.className='quarto-pessoas';
    quartoCard.appendChild(pessoasWrap);
    container.appendChild(quartoCard);

    room.pessoas.forEach((p,index)=>{
        const idadePessoa=idadeDaPessoa(p);
        const destaque=idadePessoa!==null&&idadePessoa>=60;
        const primeira=index===0;
        const row=document.createElement('div');
        row.className=classeLinhaPessoa(p,room)+' quarto-pessoa-row';
        row.dataset.quarto=room.numero;
        row.dataset.pessoaId=String(p.id||'');

        const header=primeira?'<div class="quarto-header">'+
            '<div class="quarto-identificacao">'+
              '<strong class="quarto-numero">'+room.numero+'</strong>'+
              '<button type="button" class="btn-minimizar-quarto" aria-expanded="'+(!quartosMinimizados.has(String(room.numero)))+'">'+(quartosMinimizados.has(String(room.numero))?'▣ Expandir':'▤ Minimizar')+'</button>'+
              '<select class="room-status" aria-label="Status do quarto"><option value="disponivel" selected>Disponível</option><option value="indisponivel">Indisponível</option></select>'+
            '</div>'+
            '<div class="quarto-classificacao">'+
              '<select class="room-type-classification" aria-label="Tipo de quarto">'+TIPOS_QUARTO.map(t=>'<option value="'+t+'" '+(room.tipoQuarto===t?'selected':'')+'>'+t+'</option>').join('')+'</select>'+
              '<select class="room-type"><option value="solteiro">Solteiro</option><option value="beliche">Beliche</option><option value="berco">Berço</option></select>'+
            '</div>'+
            '<div class="quarto-capacidade"><div class="room-cap-config"></div></div>'+
            '<div class="quarto-vagas coluna-vagas-status '+(total>cap?'ocupacao-alerta':'ocupacao-ok')+'"><span class="quarto-vagas-label">Vagas disponíveis:</span><span class="quarto-vagas-numero '+(cap-total<=0?'vagas-zero':'vagas-disponiveis')+'">'+Math.max(0,cap-total)+'</span></div>'+
            '<div class="quarto-status-resumo">'+(disponivel?'Disponível':'Ocupado')+'</div>'+
          '</div>':' ';

        // Mostra o vínculo nos dois sentidos, usando o ID quando disponível.
        const dependentesDaPessoa=(room.pessoas||[]).filter(x=>x.id!==p.id && String(x.nome||'').trim() && (
            (String(x.responsavelId||'').trim() && String(x.responsavelId)===String(p.id||'')) ||
            (!String(x.responsavelId||'').trim() && String(x.responsavel||'').trim() && normalizarBuscaHistorico(x.responsavel)===normalizarBuscaHistorico(p.nome))
        ));
        const abreviarNomeVinculo=nome=>String(nome||'').trim().split(/\s+/).filter(Boolean).slice(0,2).join(' ');
        const nomeResponsavelVinculo=(room.pessoas||[]).find(x=>String(x.id||'')===String(p.responsavelId||'') && String(p.responsavelId||'').trim());
        const responsavelExibido=nomeResponsavelVinculo?.nome||p.responsavel||'';
        const htmlVinculoPessoa=dependentesDaPessoa.length
            ? '<span class="responsavel-titulo">'+(dependentesDaPessoa.length===1?'Dependente:':'Dependentes:')+'</span><span class="responsavel-texto" title="'+escapar(dependentesDaPessoa.map(x=>x.nome).join(', '))+'">'+escapar(dependentesDaPessoa.map(x=>abreviarNomeVinculo(x.nome)).join(', '))+'</span>'
            : responsavelExibido
                ? '<span class="responsavel-titulo">Responsável:</span><div class="responsavel-salvo"><span class="responsavel-texto" title="'+escapar(responsavelExibido)+'">'+escapar(abreviarNomeVinculo(responsavelExibido))+'</span><button type="button" class="info-demanda-btn btn-editar-responsavel" title="Editar responsável">✎</button></div>'
                : '<span class="responsavel-titulo">Responsável:</span><button type="button" class="info-demanda-btn btn-editar-responsavel" title="Selecionar responsável">Adicionar</button>';

        row.innerHTML=header+
          '<div class="pessoa-resumo-compacto">'+
            '<span class="resumo-nome">'+escapar(p.nome||'Nome não informado')+'</span>'+
            '<span><strong>Idade:</strong> '+(idadePessoa===null?'—':idadePessoa+' anos')+'</span>'+
            '<span><strong>Entrada:</strong> '+resumoDataQuarto(p.entrada)+'</span>'+
            '<span><strong>Saída:</strong> '+resumoDataQuarto(p.saida)+'</span>'+
            '<span><strong>Advertência:</strong> '+Number(p.advertencia||0)+'</span>'+
            '<span class="resumo-tempo"><strong>Tempo de Acolhimento:</strong> '+escapar(formatarTempoAcolhimento(p.entrada,p.saida).replace(/^Tempo de Acolhimento:\s*/,''))+'</span>'+
          '</div>'+
          '<div class="pessoa-grid">'+
            '<div class="pessoa-identificacao nome '+(destaque?'destaque-idoso':'')+'">'+
              '<div class="nome-editor">'+ '<div class="nome-principal">'+(p.nome?'<span class="nome-salvo">'+escapar(p.nome)+'</span><button type="button" class="btn-nome-editar" title="Editar nome">✎</button>':'<input class="nome-input" type="text" placeholder="Nome completo...">')+'</div><span class="genero-no-nome-label">Gênero:</span><select class="genero genero-no-nome"><option value="">Não informado</option><option value="Feminino">Feminino</option><option value="Masculino">Masculino</option><option value="Idoso">Idoso</option><option value="Outro">Outro</option><option value="Trans">Trans</option></select><div class="nascimento-no-nome"><strong>Data de Nasc:</strong><input class="nascimento" type="date" value="'+escapar(p.nascimento)+'"></div>'+
              '<div class="abd-acoes-acolhido" data-fixed-actions="1">'+(primeira?'<button type="button" class="btn-danger btn-limpar">Limpar</button>':'<button type="button" class="btn-danger btn-remover">Remover</button>')+'<button type="button" class="btn-transferir-pessoa" title="Transferir pessoa para outro quarto disponível" '+(!pessoaOcupada(p)||p.saida?'disabled':'')+'>⇄ Transferir quarto</button><button type="button" class="btn-salvar-pessoa-unico" title="Salvar todas as informações da pessoa">💾</button></div></div>'+
              '<div class="identificacao-sublinha">'+
                (idadePessoa!==null?'<span class="idade-no-nome '+(destaque?'destaque-idoso':'')+'">'+idadePessoa+' Anos</span>':'<span class="idade-no-nome idade-vazia"></span>')+
                '<span class="identificacao-separador">/</span>'+
                '<div class="responsavel-box">'+htmlVinculoPessoa+'</div>'+
                '<span class="identificacao-separador">/</span>'+
                '<div class="acessibilidade-box"><label class="acessibilidade-label"><input class="acessibilidade" type="checkbox" '+(p.acessibilidade?'checked':'')+'> Acessibilidade</label>'+(p.acessibilidade?'<button type="button" class="btn-add-necessidade" title="Inserir necessidade">+</button>':'')+(p.acessibilidade&&p.necessidadeAcessibilidade?'<div class="necessidade-salva"><span class="necessidade-texto">'+escapar(p.necessidadeAcessibilidade)+'</span><button type="button" class="btn-editar-necessidade" title="Editar necessidade">✎</button></div>':'')+'</div>'+
              '<div class="identidade-box"><label>Identidade:</label>'+(p.identidade?'<span class="identidade-salva">'+escapar(p.identidade)+'</span><button type="button" class="identidade-editar" title="Editar identidade">✎</button>':'<input class="identidade-input" type="text" placeholder="Nº da identidade" autocomplete="off">')+'</div>'+
              '<button type="button" class="btn-auditoria-pessoa" title="Ver alterações e quem realizou cada alteração" aria-label="Histórico de alterações">ℹ️</button>'+
              '</div>'+
              '<div class="documentos-identificacao">'+
                '<div class="cpf-editor documento-editor"><label>CPF:</label>'+(p.cpf?'<span class="cpf-salvo">'+escapar(p.cpf)+'</span><button type="button" class="info-demanda-btn btn-editar-cpf" title="Editar CPF">✎</button><button type="button" class="info-demanda-btn btn-excluir-cpf" title="Excluir CPF">🗑️</button>':'<input class="cpf-input" type="text" value="" placeholder="000.000.000-00" maxlength="14" inputmode="numeric" autocomplete="off">')+'</div>'+
                '<div class="sus-editor documento-editor"><label>Nº Cartão SUS:</label>'+(p.cartaoSus?'<span class="sus-salvo">'+escapar(p.cartaoSus)+'</span><button type="button" class="info-demanda-btn btn-editar-sus" title="Editar Nº Cartão SUS">✎</button><button type="button" class="info-demanda-btn btn-excluir-sus" title="Excluir Nº Cartão SUS">🗑️</button>':'<input class="sus-input" type="text" value="" placeholder="Nº Cartão SUS">')+'</div>'+
              '</div>'+
              '<div class="info-demanda info-demanda-origem">'+(p.origemNacionalidade?'<div class="info-demanda-titulo">Origem/Nacionalidade:</div><div class="info-demanda-salva"><span class="info-demanda-texto">'+escapar(p.origemNacionalidade)+'</span><button type="button" class="info-demanda-btn btn-editar-info btn-editar-origem" title="Editar origem/nacionalidade">✎</button><button type="button" class="info-demanda-btn btn-excluir-info btn-excluir-origem" title="Excluir origem/nacionalidade">🗑️</button></div>':'<div class="info-demanda-titulo">Origem/Nacionalidade:</div><div class="info-demanda-editor"><input class="origem-input" type="text" placeholder="Origem/Nacionalidade"></div>')+'</div>'+
              '<div class="info-demanda info-demanda-observacao"><label class="info-demanda-check"><input type="checkbox" class="check-observacao" '+(p.observacao?'checked':'')+'> Observação:</label>'+(p.observacao?'<div class="info-demanda-salva"><span class="info-demanda-texto">'+escapar(p.observacao)+'</span><button type="button" class="info-demanda-btn btn-editar-info btn-editar-observacao" title="Editar observação">✎</button><button type="button" class="info-demanda-btn btn-excluir-info btn-excluir-observacao" title="Excluir observação">🗑️</button></div>':'<div class="info-demanda-editor editor-observacao" style="display:none"><input class="observacao-input" type="text" placeholder="Digite uma observação"></div>')+'</div>'+
              '<div class="pessoa-registros">'+
              '<div class="pessoa-campo pessoa-data"><label>Entrada:</label><input class="entrada" type="date" value="'+escapar(p.entrada)+'"></div>'+
              '<div class="pessoa-campo pessoa-data"><label>Saída:</label><input class="saida" type="date" value="'+escapar(p.saida)+'"></div>'+
              '<div class="pessoa-campo pessoa-adv"><label>Advertência:</label><input class="adv cfg-number '+(p.advertencia===0?'adv-0':p.advertencia===1?'adv-1':'adv-2')+'" type="number" min="0" max="10" value="'+p.advertencia+'"></div>'+
              '<div class="advertencia-motivo-editor" hidden><label>Motivo da nova advertência:</label><textarea class="advertencia-motivo" rows="3" placeholder="Descreva o motivo da advertência..."></textarea><div><button type="button" class="btn-salvar-motivo">Salvar advertência</button><button type="button" class="btn-cancelar-motivo">Cancelar</button></div></div>'+
              '<div class="tempo-acolhimento" data-entrada="'+escapar(p.entrada)+'" data-saida="'+escapar(p.saida)+'">'+formatarTempoAcolhimento(p.entrada,p.saida)+'</div>'+
              '</div>'+
              '<div class="pessoa-salvar-unico"></div>'+
            '</div>'+
            
            '<div class="pessoa-campo pessoa-acoes"><div class="grupo-acoes">'+(index===room.pessoas.length-1?'<button class="btn-add btn-adicionar">+ Pessoa</button>':'')+'</div></div>'+
          '</div>';

        pessoasWrap.appendChild(row);
        const transferir=row.querySelector('.btn-transferir-pessoa');
        if(transferir) transferir.onclick=()=>abrirTransferenciaQuarto(room.numero,p.id);
        if(primeira){
            const btnMinimizar=row.querySelector('.btn-minimizar-quarto');
            if(btnMinimizar)btnMinimizar.onclick=()=>alternarResumoQuarto(room.numero,quartoCard,btnMinimizar);
            const rs=row.querySelector('.room-status'),rt=row.querySelector('.room-type'),tipoClassificacao=row.querySelector('.room-type-classification');
            rt.value=room.tipo;
            rs.onchange=()=>alterarStatus(room.numero,rs.value);
            tipoClassificacao.onchange=e=>alterarTipoQuarto(room.numero,e.target.value);
            rt.onchange=()=>abrirConfiguracao(room.numero);
            atualizarPainelConfiguracao(row,room);
        }
        const nomeEditor=row.querySelector('.nome-editor');
        const genero=row.querySelector('.genero-no-nome');
        if(genero) genero.value=p.genero||'';
        const btnSalvarNome=row.querySelector('.btn-nome-salvar');
        const btnEditarNome=row.querySelector('.btn-nome-editar');
        if(btnSalvarNome){
            const input=row.querySelector('.nome-input');
            btnSalvarNome.onclick=()=>{
                const valor=(input?.value||'').trim();
                if(!valor){ alert('Digite o nome antes de salvar.'); input?.focus(); return; }
                editarPessoa(room.numero,p.id,{nome:valor});
            };
            input?.addEventListener('keydown',e=>{
                if(e.key==='Enter'){ e.preventDefault(); btnSalvarNome.click(); }
            });
        }
        if(btnEditarNome){
            btnEditarNome.onclick=()=>{
                const principal=nomeEditor.querySelector('.nome-principal');
                if(!principal)return;
                principal.innerHTML='<input class="nome-input" type="text" value="'+escapar(p.nome||'')+'" placeholder="Nome completo...">';
                const input=principal.querySelector('.nome-input');
                input.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); row.querySelector('.btn-salvar-pessoa-unico')?.click(); } });
                input.focus();
                input.select();
            };
        }
        // CPF: salvar, editar e excluir. O CPF fica persistido para futuras pesquisas no histórico.
        const cpfEditor=row.querySelector('.cpf-editor');
        const cpfInput=row.querySelector('.cpf-input');
        const btnSalvarCpf=row.querySelector('.btn-salvar-cpf');
        const btnEditarCpf=row.querySelector('.btn-editar-cpf');
        const btnExcluirCpf=row.querySelector('.btn-excluir-cpf');
        if(btnSalvarCpf){
            btnSalvarCpf.onclick=()=>{
                const valor=(cpfInput?.value||'').trim();
                if(!valor){ alert('Digite o CPF antes de salvar.'); cpfInput?.focus(); return; }
                editarPessoa(room.numero,p.id,{cpf:valor});
            };
        }
        if(btnEditarCpf){
            btnEditarCpf.onclick=()=>{
                cpfEditor.innerHTML='<label>CPF:</label><input class="cpf-input" type="text" value="'+escapar(p.cpf||'')+'" placeholder="000.000.000-00" maxlength="14" inputmode="numeric" autocomplete="off">';
                const input=cpfEditor.querySelector('.cpf-input');
                input.focus(); input.select();
            };
        }
        if(btnExcluirCpf){
            btnExcluirCpf.onclick=()=>{
                if(confirm('Deseja excluir o CPF desta pessoa?')) editarPessoa(room.numero,p.id,{cpf:''});
            };
        }
        genero.onchange=e=>editarPessoa(room.numero,p.id,{genero:e.target.value});

        // Nº Cartão SUS: salvar, editar e excluir. Fica associado à pessoa e ao histórico.
        const susEditor=row.querySelector('.sus-editor');
        const susInput=row.querySelector('.sus-input');
        const btnSalvarSus=row.querySelector('.btn-salvar-sus');
        const btnEditarSus=row.querySelector('.btn-editar-sus');
        const btnExcluirSus=row.querySelector('.btn-excluir-sus');
        if(btnSalvarSus){
            btnSalvarSus.onclick=()=>{
                const valor=(susInput?.value||'').trim();
                if(!valor){ alert('Digite o Nº Cartão SUS antes de salvar.'); susInput?.focus(); return; }
                editarPessoa(room.numero,p.id,{cartaoSus:valor});
            };
        }
        if(btnEditarSus){
            btnEditarSus.onclick=()=>{
                susEditor.innerHTML='<label>Nº Cartão SUS:</label><input class="sus-input" type="text" value="'+escapar(p.cartaoSus||'')+'" placeholder="Nº Cartão SUS">';
                const input=susEditor.querySelector('.sus-input');
                input.focus(); input.select();
            };
        }
        if(btnExcluirSus){
            btnExcluirSus.onclick=()=>{
                if(confirm('Deseja excluir o Nº Cartão SUS desta pessoa?')) editarPessoa(room.numero,p.id,{cartaoSus:''});
            };
        }

        // Origem/Nacionalidade: salvar, editar e excluir.
        const origemInput=row.querySelector('.origem-input');
        const btnSalvarOrigem=row.querySelector('.btn-salvar-origem');
        const btnEditarOrigem=row.querySelector('.btn-editar-origem');
        const btnExcluirOrigem=row.querySelector('.btn-excluir-origem');
        if(btnSalvarOrigem){
            btnSalvarOrigem.onclick=()=>{
                const valor=(origemInput?.value||'').trim();
                if(!valor){ alert('Digite a origem/nacionalidade antes de salvar.'); origemInput?.focus(); return; }
                editarPessoa(room.numero,p.id,{origemNacionalidade:valor});
            };
        }
        if(btnEditarOrigem){
            btnEditarOrigem.onclick=()=>{
                const box=btnEditarOrigem.closest('.info-demanda');
                box.innerHTML='<div class="info-demanda-titulo">Origem/Nacionalidade:</div><div class="info-demanda-editor"><input class="origem-input" type="text" value="'+escapar(p.origemNacionalidade)+'" placeholder="Origem/Nacionalidade"></div>';
                const input=box.querySelector('.origem-input');
                box.querySelector('.btn-salvar-origem').onclick=()=>{ const valor=(input.value||'').trim(); if(!valor){alert('Digite a origem/nacionalidade antes de salvar.');input.focus();return;} editarPessoa(room.numero,p.id,{origemNacionalidade:valor}); };
                input.focus();
                input.select();
            };
        }
        if(btnExcluirOrigem){
            btnExcluirOrigem.onclick=()=>{ if(confirm('Deseja excluir a informação de origem/nacionalidade?')) editarPessoa(room.numero,p.id,{origemNacionalidade:''}); };
        }

        // Observação: checkbox abre o campo; salvar, editar e excluir mantêm a informação persistida.
        const checkObservacao=row.querySelector('.check-observacao');
        const btnSalvarObservacao=row.querySelector('.btn-salvar-observacao');
        const btnEditarObservacao=row.querySelector('.btn-editar-observacao');
        const btnExcluirObservacao=row.querySelector('.btn-excluir-observacao');
        const obsInput=row.querySelector('.observacao-input');
        if(checkObservacao){
            checkObservacao.onchange=e=>{
                if(e.target.checked){
                    const editor=row.querySelector('.editor-observacao');
                    if(editor){ editor.classList.remove('observacao-editor-oculto'); editor.style.display='flex'; editor.querySelector('.observacao-input')?.focus(); }
                }else{
                    if(p.observacao && confirm('Deseja excluir a observação desta pessoa?')) editarPessoa(room.numero,p.id,{observacao:''});
                    else if(!p.observacao){ const editor=row.querySelector('.editor-observacao'); if(editor){editor.classList.add('observacao-editor-oculto');editor.style.display='none';} }
                    else e.target.checked=true;
                }
            };
        }
        if(btnSalvarObservacao){
            btnSalvarObservacao.onclick=()=>{
                const valor=(obsInput?.value||'').trim();
                if(!valor){ alert('Digite uma observação antes de salvar.'); obsInput?.focus(); return; }
                editarPessoa(room.numero,p.id,{observacao:valor});
            };
        }
        if(btnEditarObservacao){
            btnEditarObservacao.onclick=()=>{
                const box=btnEditarObservacao.closest('.info-demanda');
                box.innerHTML='<label class="info-demanda-check"><input type="checkbox" checked class="check-observacao"> Observação:</label><div class="info-demanda-editor editor-observacao"><input class="observacao-input" type="text" value="'+escapar(p.observacao)+'" placeholder="Digite uma observação"></div>';
                const input=box.querySelector('.observacao-input');
                input.focus(); input.select();
            };
        }
        if(btnExcluirObservacao){
            btnExcluirObservacao.onclick=()=>{ if(confirm('Deseja excluir a observação desta pessoa?')) editarPessoa(room.numero,p.id,{observacao:''}); };
        }
        row.querySelector('.acessibilidade').onchange=e=>editarPessoa(room.numero,p.id,{acessibilidade:e.target.checked, necessidadeAcessibilidade:e.target.checked?(p.necessidadeAcessibilidade||''):''});

        const btnAddNecessidade=row.querySelector('.btn-add-necessidade');
        const editorNecessidade=row.querySelector('.necessidade-editor');
        const inputNecessidade=row.querySelector('.acessibilidade-detalhe');
        const btnSalvarNecessidade=row.querySelector('.btn-salvar-necessidade');
        const btnEditarNecessidade=row.querySelector('.btn-editar-necessidade');

        if(btnAddNecessidade){
            btnAddNecessidade.onclick=()=>{
                const box=row.querySelector('.acessibilidade-box');
                if(!box)return;
                let editor=box.querySelector('.necessidade-editor');
                if(!editor){
                    editor=document.createElement('div');
                    editor.className='necessidade-editor';
                    editor.innerHTML='<input class="acessibilidade-detalhe" type="text" placeholder="Tipo de necessidade">';
                    box.appendChild(editor);
                }
                editor.style.display='flex';
                const input=editor.querySelector('.acessibilidade-detalhe');
                if(input){ input.value=p.necessidadeAcessibilidade||''; input.focus(); }
            };
        }
        if(btnSalvarNecessidade){
            btnSalvarNecessidade.onclick=()=>{
                const valor=(inputNecessidade?.value||'').trim();
                if(!valor){
                    alert('Digite o tipo de necessidade antes de salvar.');
                    inputNecessidade?.focus();
                    return;
                }
                editarPessoa(room.numero,p.id,{acessibilidade:true,necessidadeAcessibilidade:valor});
            };
        }
        if(btnEditarNecessidade){
            btnEditarNecessidade.onclick=()=>{
                const box=row.querySelector('.acessibilidade-box');
                const salva=box?.querySelector('.necessidade-salva');
                if(salva) salva.style.display='none';
                let editor=box?.querySelector('.necessidade-editor');
                if(!editor){
                    editor=document.createElement('div');
                    editor.className='necessidade-editor';
                    editor.innerHTML='<input class="acessibilidade-detalhe" type="text" placeholder="Tipo de necessidade">';
                    box?.appendChild(editor);
                }
                editor.style.display='flex';
                const input=editor.querySelector('.acessibilidade-detalhe');
                if(input){ input.value=p.necessidadeAcessibilidade||''; input.focus(); }
            };
        }
        function montarEditorResponsavel(){
            const box=row.querySelector('.responsavel-box');
            if(!box) return;
            const candidatos=(room.pessoas||[]).filter(x=>x.id!==p.id && String(x.nome||'').trim() && !String(x.saida||'').trim());
            const responsavelAtualId=String(p.responsavelId||'').trim();
            const responsavelAtualNome=String(p.responsavel||'').trim();
            const opcoes=candidatos.map(x=>{
                const selecionado=(responsavelAtualId && x.id===responsavelAtualId) || (!responsavelAtualId && x.nome.trim()===responsavelAtualNome);
                return '<option value="'+escapar(x.id)+'" '+(selecionado?'selected':'')+'>'+escapar(x.nome.trim())+'</option>';
            }).join('');
            box.innerHTML='<span class="responsavel-titulo">Responsável:</span>'+
                '<div class="responsavel-editor"><select class="responsavel-select"><option value="">Nenhum responsável</option>'+opcoes+'</select><button type="button" class="info-demanda-btn btn-cancelar-responsavel" title="Cancelar seleção">✕</button></div>';
            const select=box.querySelector('.responsavel-select');
            const cancelar=box.querySelector('.btn-cancelar-responsavel');
            cancelar.onclick=()=>{
                const valorAnterior=String(p.responsavel||'').trim();
                if(valorAnterior){
                    box.innerHTML='<span class="responsavel-titulo">Responsável:</span><div class="responsavel-salvo"><span class="responsavel-texto">'+escapar(abreviarNomeVinculo(valorAnterior))+'</span><button type="button" class="info-demanda-btn btn-editar-responsavel" title="Editar responsável">✎</button></div>';
                    box.querySelector('.btn-editar-responsavel').onclick=montarEditorResponsavel;
                }else{
                    box.innerHTML='<span class="responsavel-titulo">Responsável:</span><button type="button" class="info-demanda-btn btn-editar-responsavel" title="Selecionar responsável">Adicionar</button>';
                    box.querySelector('.btn-editar-responsavel').onclick=montarEditorResponsavel;
                }
            };
            select.focus();
        }
        const responsavelBox=row.querySelector('.responsavel-box');
        // O HTML do vínculo já foi calculado antes de construir a linha.
        // Quando a pessoa possui dependentes, o rótulo e os nomes aparecem nesta mesma área.
        const btnEditarResponsavel=row.querySelector('.btn-editar-responsavel');
        if(btnEditarResponsavel) btnEditarResponsavel.onclick=montarEditorResponsavel;

        // Identidade: permanece em modo leitura após salvar; lápis libera edição individual.
        const btnEditarIdentidade=row.querySelector('.identidade-editar');
        if(btnEditarIdentidade){
            btnEditarIdentidade.onclick=()=>{
                const box=row.querySelector('.identidade-box');
                box.innerHTML='<label>Identidade:</label><input class="identidade-input" type="text" autocomplete="off" placeholder="Nº da identidade" value="'+escapar(p.identidade||'')+'">';
                const input=box.querySelector('.identidade-input');
                input.focus();input.select();
            };
        }
        const btnSalvarPessoaUnico=row.querySelector('.btn-salvar-pessoa-unico');
        if(btnSalvarPessoaUnico){
            btnSalvarPessoaUnico.onclick=async()=>{
                const patch={};
                const nomeInput=row.querySelector('.nome-input');
                if(nomeInput) patch.nome=(nomeInput.value||'').trim();
                const identidadeAtual=row.querySelector('.identidade-input');
                if(identidadeAtual) patch.identidade=(identidadeAtual.value||'').trim();
                const cpfInputAtual=row.querySelector('.cpf-input');
                if(cpfInputAtual) patch.cpf=(cpfInputAtual.value||'').trim();
                const susInputAtual=row.querySelector('.sus-input');
                if(susInputAtual) patch.cartaoSus=(susInputAtual.value||'').trim();
                const origemInputAtual=row.querySelector('.origem-input');
                if(origemInputAtual) patch.origemNacionalidade=(origemInputAtual.value||'').trim();
                const obsInputAtual=row.querySelector('.observacao-input');
                if(obsInputAtual) patch.observacao=(obsInputAtual.value||'').trim();
                const generoAtual=row.querySelector('.genero-no-nome');
                if(generoAtual) patch.genero=(generoAtual.value||'').trim();
                const respSelectAtual=row.querySelector('.responsavel-select');
                if(respSelectAtual){
                    const idResponsavel=(respSelectAtual.value||'').trim();
                    const pessoaResponsavel=(room.pessoas||[]).find(x=>String(x.id||'')===idResponsavel);
                    patch.responsavelId=idResponsavel;
                    patch.responsavel=pessoaResponsavel ? String(pessoaResponsavel.nome||'').trim() : '';
                }
                const necessidadeAtual=row.querySelector('.acessibilidade-detalhe');
                if(necessidadeAtual && p.acessibilidade) patch.necessidadeAcessibilidade=(necessidadeAtual.value||'').trim();
                const checkObsAtual=row.querySelector('.check-observacao');
                if(checkObsAtual && !checkObsAtual.checked) patch.observacao='';
                const checkAcessAtual=row.querySelector('.acessibilidade');
                if(checkAcessAtual) patch.acessibilidade=checkAcessAtual.checked;
                if(Object.prototype.hasOwnProperty.call(patch,'nome') && !patch.nome){ alert('Digite o nome antes de salvar.'); nomeInput?.focus(); return; }
                if(Object.prototype.hasOwnProperty.call(patch,'observacao') && checkObsAtual?.checked && !patch.observacao){ alert('Digite uma observação antes de salvar ou desmarque Observação.'); obsInputAtual?.focus(); return; }
                if(respSelectAtual && respSelectAtual.value===''){ patch.responsavel=''; patch.responsavelId=''; }
                // Campos de seleção e datas aguardam o salvamento geral.
                for(const [seletor,campo] of [['.nascimento','nascimento'],['.entrada','entrada'],['.saida','saida']]){
                    const elemento=row.querySelector(seletor);
                    if(elemento) patch[campo]=elemento.value||'';
                }
                if(patch.entrada && patch.saida && patch.saida<patch.entrada){
                    alert('A data de saída não pode ser anterior à data de entrada.');
                    row.querySelector('.saida')?.focus();return;
                }
                if(patch.saida && patch.saida!==String(p.saida||'')){
                    const confirmado=await confirmarDesligamentoPessoa(p,patch.saida);
                    if(!confirmado)return;
                }
                patch.camposVaziosOcultos=true;
                const mudou=Object.entries(patch).some(([campo,valor])=>String(p[campo]??'')!==String(valor??''));
                if(mudou) editarPessoa(room.numero,p.id,patch);
                else {render();agendarIndicacaoSalvo();}
            };
        }
        // Gênero e datas só serão persistidos pelo botão Salvar da pessoa.
        // Valores já salvos são exibidos como texto com lápis para editar.
        function fixarCampoPessoa(seletor, valorSalvo, titulo, formato){
            const input=row.querySelector(seletor);
            if(!input)return;
            const wrapper=document.createElement('span');
            wrapper.className='campo-pessoa-fixavel';
            input.parentNode.insertBefore(wrapper,input);
            wrapper.appendChild(input);
            const exibir=document.createElement('span');
            exibir.className='campo-pessoa-valor-fixo';
            exibir.textContent=formato?formato(valorSalvo):valorSalvo;
            const editar=document.createElement('button');
            editar.type='button';editar.className='campo-pessoa-editar';
            editar.textContent='✎';editar.title='Editar '+titulo;
            editar.onclick=()=>{
                wrapper.classList.remove('campo-pessoa-bloqueado');
                input.hidden=false;input.disabled=false;
                exibir.hidden=true;editar.hidden=true;
                input.focus();
            };
            wrapper.append(exibir,editar);
            if(String(valorSalvo||'').trim()){
                wrapper.classList.add('campo-pessoa-bloqueado');
                input.hidden=true;exibir.hidden=false;editar.hidden=false;
            }else{
                exibir.hidden=true;editar.hidden=true;
                if(p.camposVaziosOcultos){
                    const adicionar=document.createElement('button');
                    adicionar.type='button';adicionar.className='campo-vazio-adicionar';
                    adicionar.textContent='+'; adicionar.title='Adicionar '+titulo;
                    wrapper.appendChild(adicionar);
                    input.style.display='none';
                    adicionar.onclick=()=>{
                        input.style.display=''; input.hidden=false;
                        adicionar.remove();input.focus();
                    };
                }
            }
        }
        fixarCampoPessoa('.genero-no-nome',p.genero,'gênero');
        fixarCampoPessoa('.nascimento',p.nascimento,'data de nascimento',formatarDataBR);
        fixarCampoPessoa('.entrada',p.entrada,'data de entrada',formatarDataBR);
        fixarCampoPessoa('.saida',p.saida,'data de saída',formatarDataBR);
        row.querySelector('.entrada').oninput=()=>atualizarTemposAcolhimento();
        row.querySelector('.saida').oninput=()=>atualizarTemposAcolhimento();
        const advInput=row.querySelector('.adv'), motivoEditor=row.querySelector('.advertencia-motivo-editor');
        advInput.onchange=e=>{
            const novo=Math.max(0,Math.min(10,parseInt(e.target.value,10)||0));
            const anterior=Number(p.advertencia)||0;
            if(novo>anterior){
                motivoEditor.hidden=false;
                motivoEditor.querySelector('textarea').value='';
                motivoEditor.querySelector('textarea').focus();
            }else{
                motivoEditor.hidden=true;
                const motivos=Array.isArray(p.advertenciasMotivos)?p.advertenciasMotivos:[];
                editarPessoa(room.numero,p.id,{advertencia:novo,advertenciasMotivos:motivos.slice(0,novo)});
            }
        };
        motivoEditor.querySelector('.btn-cancelar-motivo').onclick=()=>{advInput.value=Number(p.advertencia)||0;motivoEditor.hidden=true;};
        motivoEditor.querySelector('.btn-salvar-motivo').onclick=()=>{
            const motivo=motivoEditor.querySelector('textarea').value.trim();
            if(!motivo){alert('Informe o motivo da advertência.');return;}
            const anterior=Number(p.advertencia)||0,novo=Math.max(0,Math.min(10,Number(advInput.value)||0));
            const motivos=Array.isArray(p.advertenciasMotivos)?[...p.advertenciasMotivos]:[];
            const operador=window.__operadorAtual?.()||'Operador não identificado';
            for(let k=anterior;k<novo;k++)motivos.push({motivo,operador,data:new Date().toISOString()});
            editarPessoa(room.numero,p.id,{advertencia:novo,advertenciasMotivos:motivos});
        };
        // Após o primeiro salvamento, campos ainda vazios aparecem como botão +.
        // O controle original permanece no DOM, garantindo que o botão 💾 o salve normalmente.
        if(p.camposVaziosOcultos){
            const camposOpcionais=[
                ['.identidade-input','Identidade'],
                ['.cpf-input','CPF'],
                ['.sus-input','Cartão SUS'],
                ['.origem-input','Origem/Nacionalidade'],
                ['.nome-input','Nome']
            ];
            camposOpcionais.forEach(([seletor,rotulo])=>{
                const input=row.querySelector(seletor);
                if(!input || String(input.value||'').trim())return;
                const plus=document.createElement('button');
                plus.type='button';plus.className='campo-vazio-adicionar';
                plus.textContent='+';plus.title='Adicionar '+rotulo;
                input.insertAdjacentElement('beforebegin',plus);
                input.style.display='none';
                plus.onclick=()=>{
                    input.style.display='';plus.remove();input.focus();
                };
            });
            // A observação já possui uma caixa de seleção: esconder o editor vazio
            // e usar o botão + para abrir a digitação e ativar a observação.
            if(!p.observacao){
                const caixa=row.querySelector('.info-demanda-observacao');
                const editor=caixa?.querySelector('.editor-observacao');
                const check=caixa?.querySelector('.check-observacao');
                if(caixa && editor && check){
                    editor.classList.add('observacao-editor-oculto');
                    const plus=document.createElement('button');
                    plus.type='button';plus.className='campo-vazio-adicionar';
                    plus.textContent='+';plus.title='Adicionar observação';
                    caixa.appendChild(plus);
                    plus.onclick=()=>{
                        check.checked=true;check.dispatchEvent(new Event('change',{bubbles:true}));
                        editor.classList.remove('observacao-editor-oculto');editor.style.display='flex';plus.remove();
                        editor.querySelector('.observacao-input')?.focus();
                    };
                }
            }
        }
        row.querySelector('.btn-limpar')?.addEventListener('click',()=>limparPessoa(room.numero,p.id));
        row.querySelector('.btn-remover')?.addEventListener('click',()=>removerPessoa(room.numero,p.id));
        row.querySelector('.btn-adicionar')?.addEventListener('click',()=>adicionarPessoa(room.numero));
    });
    // Um único botão + Pessoa por quarto, deslocado para a barra superior.
    // Reutiliza o botão original já associado ao evento de adicionarPessoa.
    // Não cria outro cadastro, listener nem modifica o estado salvo.
    const botaoNovaPessoa=pessoasWrap.querySelector('.btn-adicionar');
    const barraQuarto=pessoasWrap.querySelector('.quarto-header');
    if(botaoNovaPessoa && barraQuarto){
        botaoNovaPessoa.classList.add('btn-adicionar-cabecalho');
        const indicadorVagas=barraQuarto.querySelector('.quarto-vagas');
        if(indicadorVagas) barraQuarto.insertBefore(botaoNovaPessoa,indicadorVagas);
        else barraQuarto.appendChild(botaoNovaPessoa);
    }
}

function confirmarAlteracaoCamasPadrao(){
    return new Promise(resolve=>{
        const painel=document.getElementById('confirmacaoCamasPadrao');
        const btnConfirmar=document.getElementById('btnConfirmarCamasPadrao');
        const btnCancelar=document.getElementById('btnCancelarCamasPadrao');
        if(!painel || !btnConfirmar || !btnCancelar){ resolve(false); return; }
        const finalizar=(resultado)=>{
            painel.style.display='none';
            btnConfirmar.onclick=null;
            btnCancelar.onclick=null;
            resolve(resultado);
        };
        btnConfirmar.onclick=()=>finalizar(true);
        btnCancelar.onclick=()=>finalizar(false);
        painel.style.display='flex';
    });
}

function atualizarPainelConfiguracao(tr,room){
    const box=tr.querySelector('.room-cap-config'); if(!box)return;
    const padrao=capacidadePadraoRoom(room);
    const excedente=capacidadeExcedenteRoom(room);
    box.innerHTML=
      '<div class="capacidade-configuracao">'+
        '<div class="capacidade-padrao-linha">'+
          '<label>Nº de camas padrão:</label>'+
          '<input class="cfg-number capacidade-padrao-input" type="number" min="1" max="20" value="'+padrao+'" disabled>'+
          '<button type="button" class="btn-editar-capacidade" title="Editar quantidade padrão">Editar</button>'+
        '</div>'+
        '<div class="capacidade-excedente-linha">'+
          '<label>Limite excedente:</label>'+
          '<input class="cfg-number capacidade-excedente-input" type="number" min="0" max="10" value="'+excedente+'" disabled>'+
          '<button type="button" class="btn-editar-capacidade-excedente" title="Editar limite excedente">Editar</button>'+
        '</div>'+
      '</div>';
    const btnEditar=box.querySelector('.btn-editar-capacidade');
    btnEditar.onclick=async()=>{
        const confirmado=await confirmarAlteracaoCamasPadrao();
        if(!confirmado) return;
        const novo=prompt('Informe a nova quantidade padrão de camas (1 a 20):',String(capacidadePadraoRoom(room)));
        if(novo===null)return;
        const valor=parseInt(novo,10);
        if(!Number.isInteger(valor)||valor<1||valor>20){alert('Informe uma quantidade padrão entre 1 e 20.');return;}
        const ocupados=contarOcupantes(room);
        if(valor+capacidadeExcedenteRoom(room)<ocupados){
            alert('A capacidade efetiva não pode ser menor que '+ocupados+' ocupante(s) já cadastrado(s).');
            return;
        }
        snapshotAntes();
        room.capacidadePadrao=valor;
        sincronizarCapacidadeRoom(room);
        salvarNoStorage(); render();
    };
    const btnEditarExcedente=box.querySelector('.btn-editar-capacidade-excedente');
    const inputExcedente=box.querySelector('.capacidade-excedente-input');
    btnEditarExcedente.onclick=async()=>{
        const confirmado=await confirmarAlteracaoCamasPadrao();
        if(!confirmado) return;
        const novo=prompt('Informe o limite excedente deste quarto (0 a 10):',String(capacidadeExcedenteRoom(room)));
        if(novo===null)return;
        const valor=parseInt(novo,10);
        if(!Number.isInteger(valor)||valor<0||valor>10){
            alert('Informe um limite excedente entre 0 e 10.');
            return;
        }
        const ocupados=contarOcupantes(room);
        if(capacidadePadraoRoom(room)+valor<ocupados){
            alert('O limite excedente não pode deixar a capacidade efetiva abaixo de '+ocupados+' ocupante(s).');
            return;
        }
        snapshotAntes();
        room.capacidadeExcedente=valor;
        sincronizarCapacidadeRoom(room);
        salvarNoStorage();
        render();
    };
}
function salvarEquipeNaAba(grupo){
    const conjunto=state.equipesAbas?.[grupo];if(!conjunto)return;
    const aba=conjunto.abas.find(a=>a.numero===conjunto.ativo);
    if(aba)aba.funcionarios=deepClone(state.employees[grupo]);
}
function alternarAbaEquipe(grupo,numero){
    const conjunto=state.equipesAbas[grupo];if(conjunto.ativo===numero)return;
    const destino=conjunto.abas.find(a=>a.numero===numero);if(!destino)return;
    snapshotAntes();salvarEquipeNaAba(grupo);
    conjunto.ativo=numero;state.employees[grupo]=deepClone(destino.funcionarios);
    salvarNoStorage();render();
    if(typeof window.atualizarListaOperador==='function')window.atualizarListaOperador();
}
function adicionarAbaEquipe(grupo){
    const conjunto=state.equipesAbas[grupo];
    snapshotAntes();salvarEquipeNaAba(grupo);
    // Reutiliza a primeira numeração livre, inclusive após exclusões.
    const usados=new Set(conjunto.abas.map(aba=>Number(aba.numero)));
    let numero=1;
    while(usados.has(numero)) numero++;
    conjunto.proximo=Math.max(numero+1, ...Array.from(usados, n=>n+1), 2);
    conjunto.abas.push({numero,funcionarios:[]});
    conjunto.abas.sort((a,b)=>a.numero-b.numero);
    conjunto.ativo=numero;
    state.employees[grupo]=[];salvarNoStorage();render();
    if(typeof window.atualizarListaOperador==='function')window.atualizarListaOperador();
}
function excluirAbaEquipe(grupo,numero){
    if(numero===1){alert('O Plantão 1 não pode ser excluído.');return;}
    const conjunto=state.equipesAbas[grupo];
    if(!confirm('Excluir o Plantão '+numero+' e todos os funcionários desta aba?'))return;
    snapshotAntes();salvarEquipeNaAba(grupo);
    conjunto.abas=conjunto.abas.filter(a=>a.numero!==numero);
    if(conjunto.ativo===numero){conjunto.ativo=1;state.employees[grupo]=deepClone(conjunto.abas.find(a=>a.numero===1).funcionarios);}
    salvarNoStorage();render();
    if(typeof window.atualizarListaOperador==='function')window.atualizarListaOperador();
}
function renderAbasEquipe(grupo){
    const container=document.getElementById(grupo==='plantonistas'?'abasPlantonistas':'abasVigilantes');
    if(!container)return;
    container.replaceChildren();
    const conjunto=state.equipesAbas[grupo];
    conjunto.abas.forEach(aba=>{
        const item=document.createElement('span');item.className='aba-equipe-item';
        const btn=document.createElement('button');btn.type='button';btn.textContent='Plantão '+aba.numero;
        btn.className='aba-equipe-botao'+(aba.numero===conjunto.ativo?' ativa':'');
        btn.setAttribute('aria-pressed',String(aba.numero===conjunto.ativo));
        btn.onclick=()=>alternarAbaEquipe(grupo,aba.numero);item.appendChild(btn);
        if(aba.numero!==1){const excluir=document.createElement('button');excluir.type='button';excluir.textContent='×';excluir.title='Excluir Plantão '+aba.numero;excluir.className='aba-equipe-excluir';excluir.onclick=()=>excluirAbaEquipe(grupo,aba.numero);item.appendChild(excluir);}
        container.appendChild(item);
    });
    const add=document.createElement('button');add.type='button';add.className='aba-equipe-adicionar';add.textContent='+ Novo plantão';add.onclick=()=>adicionarAbaEquipe(grupo);container.appendChild(add);
}
function renderEmployees(){
    renderAbasEquipe('plantonistas');renderAbasEquipe('vigilantes');
    ['plantonistas','vigilantes'].forEach(grupo=>{
        const id=grupo==='plantonistas'?'ulPlantao1':'ulVigilantes', ul=document.getElementById(id);
        ul.innerHTML='';
        state.employees[grupo].forEach(emp=>{
            const li=document.createElement('li');
            li.innerHTML='<label class="nome-funcionario-label">Nome: <input class="nome-funcionario" type="text" aria-label="Nome do funcionário"></label>'+
                (grupo==='plantonistas'?'<label class="funcao-plantonista-label">Função: <select class="funcao-plantonista">'+FUNCOES_PLANTONISTA.map(f=>'<option value="'+f+'">'+(f||'— Selecione —')+'</option>').join('')+'</select></label>':'')+
                '<select class="escala-func"><option value="12x36">12x36</option><option value="24x72">24x72</option><option value="24h">24h</option></select>'+
                (grupo==='vigilantes'?'<label class="turno-vigilante-label">Plantão: <select class="turno-vigilante"><option value="Dia">Dia</option><option value="Noite">Noite</option></select></label>':'')+
                '<button class="btn-danger">Remover</button>';
            const nomeInput=li.querySelector('.nome-funcionario');
            nomeInput.value=emp.nome||'';
            nomeInput.onchange=e=>{const nome=e.target.value.trim(); if(!nome){alert('Informe o nome do funcionário.');e.target.value=emp.nome;return;} alterarFuncionario(grupo,emp.id,{nome});};
            const funcaoSelect=li.querySelector('.funcao-plantonista');
            if(funcaoSelect){
                funcaoSelect.value=emp.funcao||'';
                funcaoSelect.onchange=e=>alterarFuncionario(grupo,emp.id,{funcao:e.target.value});
            }
            const escalaSelect=li.querySelector('.escala-func');
            escalaSelect.value=emp.escala;
            escalaSelect.onchange=e=>alterarFuncionario(grupo,emp.id,{escala:e.target.value});
            const turnoSelect=li.querySelector('.turno-vigilante');
            if(turnoSelect){
                turnoSelect.value=emp.turno||'Dia';
                turnoSelect.onchange=e=>alterarFuncionario(grupo,emp.id,{turno:e.target.value});
            }
            li.querySelector('button').onclick=()=>removerFuncionario(grupo,emp.id);
            ul.appendChild(li);
        });
    });
}

function snapshotAntes(){ registrarHistorico(); }

function dataAcolhimentoUTC(valor){
    const texto=String(valor||'').trim();
    let ano,mes,dia,match;
    if((match=/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(texto))){
        ano=+match[1]; mes=+match[2]; dia=+match[3];
    }else if((match=/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:$|\s)/.exec(texto))){
        dia=+match[1]; mes=+match[2]; ano=+match[3];
    }else return null;
    const data=new Date(Date.UTC(ano,mes-1,dia));
    return data.getUTCFullYear()===ano && data.getUTCMonth()===mes-1 && data.getUTCDate()===dia ? data : null;
}
function calcularTempoAcolhimento(entrada, saida=''){
    const inicio=dataAcolhimentoUTC(entrada);
    const fim=String(saida||'').trim()?dataAcolhimentoUTC(saida):dataAcolhimentoUTC(new Date().toLocaleDateString('en-CA'));
    // toLocaleDateString('en-CA') may vary between browsers: use local calendar explicitly.
    const hoje=new Date();
    const final=fim || (!String(saida||'').trim()?new Date(Date.UTC(hoje.getFullYear(),hoje.getMonth(),hoje.getDate())):null);
    if(!inicio||!final||final<inicio)return null;
    return Math.round((final-inicio)/86400000);
}
function formatarTempoAcolhimento(entrada,saida=''){
    const inicio=dataAcolhimentoUTC(entrada);
    const hoje=new Date();
    const fim=String(saida||'').trim()?dataAcolhimentoUTC(saida):new Date(Date.UTC(hoje.getFullYear(),hoje.getMonth(),hoje.getDate()));
    if(!inicio) return 'Tempo de Acolhimento: informe a Entrada';
    if(!fim||fim<inicio) return 'Tempo de Acolhimento: —';
    const ai=inicio.getUTCFullYear(),mi=inicio.getUTCMonth(),di=inicio.getUTCDate();
    let meses=(fim.getUTCFullYear()-ai)*12+fim.getUTCMonth()-mi;
    const aniversario=(quantidade)=>{
        const data=new Date(Date.UTC(ai,mi+quantidade,1));
        const ultimo=new Date(Date.UTC(data.getUTCFullYear(),data.getUTCMonth()+1,0)).getUTCDate();
        return new Date(Date.UTC(data.getUTCFullYear(),data.getUTCMonth(),Math.min(di,ultimo)));
    };
    if(aniversario(meses)>fim)meses--;
    const dias=Math.round((fim-aniversario(meses))/86400000);
    const anos=Math.floor(meses/12), restantes=meses%12, partes=[];
    if(anos)partes.push(anos+' '+(anos===1?'ano':'anos'));
    if(restantes)partes.push(restantes+' '+(restantes===1?'mês':'meses'));
    if(dias||!partes.length)partes.push(dias+' '+(dias===1?'dia':'dias'));
    return 'Tempo de Acolhimento: '+partes.join(' e ');
}
function atualizarTemposAcolhimento(){
    document.querySelectorAll('#areas .pessoa-registros').forEach(registro=>{
        const elemento=registro.querySelector('.tempo-acolhimento');
        if(!elemento)return;
        const entrada=registro.querySelector('input.entrada')?.value||elemento.dataset.entrada||'';
        const saida=registro.querySelector('input.saida')?.value||elemento.dataset.saida||'';
        elemento.textContent=formatarTempoAcolhimento(entrada,saida);
    });
}

function confirmarDesligamentoPessoa(pessoa,dataSaida){
    return new Promise(resolve=>{
        const dialog=document.getElementById('confirmarDesligamentoDialog');
        if(!dialog){resolve(false);return;}
        const nome=String(pessoa.nome||'Pessoa sem nome');
        const data=dataSaida.split('-').reverse().join('/');
        dialog.querySelector('[data-desligamento-nome]').textContent=nome;
        dialog.querySelector('[data-desligamento-data]').textContent=data;
        const confirmar=dialog.querySelector('[data-desligamento-confirmar]');
        const cancelar=dialog.querySelector('[data-desligamento-cancelar]');
        let terminado=false;
        const encerrar=ok=>{if(terminado)return;terminado=true;confirmar.removeEventListener('click',onConfirmar);cancelar.removeEventListener('click',onCancelar);dialog.removeEventListener('cancel',onCancelDialog);if(dialog.open)dialog.close();resolve(ok);};
        const onConfirmar=()=>encerrar(true),onCancelar=()=>encerrar(false);
        const onCancelDialog=e=>{e.preventDefault();encerrar(false)};
        confirmar.addEventListener('click',onConfirmar);
        cancelar.addEventListener('click',onCancelar);
        dialog.addEventListener('cancel',onCancelDialog);
        if(typeof dialog.showModal === "function") dialog.showModal();
        else { dialog.setAttribute("open", ""); }
        cancelar.focus();
    });
}

function editarPessoa(num,id,patch){
    const p=state.rooms[num]?.pessoas.find(x=>x.id===id); if(!p)return;
    snapshotAntes(); const operador=window.__operadorAtual?.()||'Não identificado';if(Object.prototype.hasOwnProperty.call(patch,'entrada')&&patch.entrada&&!p.operadoresRegistro?.acolhimento)p.operadoresRegistro={...(p.operadoresRegistro||{}),acolhimento:operador,acolhimentoEm:new Date().toISOString()};if(Object.prototype.hasOwnProperty.call(patch,'saida')&&patch.saida)p.operadoresRegistro={...(p.operadoresRegistro||{}),desligamento:operador,desligamentoEm:new Date().toISOString()}; Object.assign(p,patch); if(String(p.saida||'').trim()) criarRegistroHistoricoAcolhimento(state.rooms[num],p); salvarNoStorage(); render(); agendarIndicacaoSalvo();
}

function limparPessoa(num,id){
    const room=state.rooms[num]; const p=room?.pessoas.find(x=>x.id===id); if(!p)return;
    if(!confirm('Deseja limpar os dados desta pessoa?'))return;
    snapshotAntes();
    // Se outra pessoa permanece cadastrada, a linha limpa deixa de ocupar espaço.
    // Caso seja a única linha, conservamos um cadastro vazio para nova inclusão.
    if(room.pessoas.length>1){
        room.pessoas=room.pessoas.filter(x=>x.id!==id);
        if(!room.pessoas.length)room.pessoas=[pessoaVazia()];
        compactarPrimeiroCadastroVazio(room);
    }else{
        Object.assign(p,pessoaVazia(),{id});
    }
    salvarNoStorage(); render();
}

function contarVagasReservadasParaInclusao(room){
    if(!room || room.status==='indisponivel') return 0;

    // Uma linha vazia já representa uma vaga disponível para preenchimento.
    // Ela não pode ser ignorada na hora de criar outra linha, pois isso
    // permitiria criar várias pessoas em um quarto que possui somente uma vaga.
    const ativas=contarOcupantes(room);
    const linhasVazias=(room.pessoas||[]).filter(p=>!pessoaOcupada(p)).length;
    return ativas+linhasVazias;
}

function abrirTransferenciaQuarto(numeroOrigem,pessoaId){
    const origem=state.rooms[numeroOrigem];
    const pessoa=origem?.pessoas.find(p=>String(p.id)===String(pessoaId));
    if(!pessoa || !pessoaOcupada(pessoa) || String(pessoa.saida||'').trim()){
        alert('Somente pessoas atualmente acolhidas podem ser transferidas.'); return;
    }
    const dialog=document.getElementById('dialogTransferenciaQuarto');
    const select=document.getElementById('transferenciaQuartoDestino');
    const identificacao=document.getElementById('transferenciaPessoaNome');
    select.replaceChildren();
    Object.values(state.rooms).filter(destino=>
        String(destino.numero)!==String(numeroOrigem) &&
        destino.status==='disponivel' &&
        capacidadeEfetivaRoom(destino)>contarOcupantes(destino)
    ).sort((a,b)=>Number(a.numero)-Number(b.numero)).forEach(destino=>{
        const vagas=capacidadeEfetivaRoom(destino)-contarOcupantes(destino);
        const option=document.createElement('option');
        option.value=String(destino.numero);
        option.textContent='Quarto '+destino.numero+' — '+(destino.tipoQuarto||'')+' — '+vagas+' vaga(s)';
        select.appendChild(option);
    });
    if(!select.options.length){alert('Não existem outros quartos disponíveis com vagas.');return;}
    identificacao.textContent=pessoa.nome+' — quarto '+numeroOrigem;
    dialog.dataset.origem=String(numeroOrigem);
    dialog.dataset.pessoaId=String(pessoaId);
    dialog.showModal();
}
function confirmarTransferenciaQuarto(){
    const dialog=document.getElementById('dialogTransferenciaQuarto');
    const origem=state.rooms[dialog.dataset.origem];
    const destino=state.rooms[document.getElementById('transferenciaQuartoDestino').value];
    const pessoa=origem?.pessoas.find(p=>String(p.id)===dialog.dataset.pessoaId);
    if(!pessoa || !destino || String(pessoa.saida||'').trim()){
        alert('Não foi possível localizar uma pessoa ativa e o quarto de destino.');return;
    }
    if(destino.status!=='disponivel' || capacidadeEfetivaRoom(destino)<=contarOcupantes(destino)){
        alert('O quarto de destino não está disponível ou está sem vagas.');return;
    }
    if(!confirm('Transferir '+pessoa.nome+' do quarto '+origem.numero+' para o quarto '+destino.numero+'? As datas e demais informações serão preservadas.'))return;
    snapshotAntes();
    origem.pessoas=origem.pessoas.filter(p=>String(p.id)!==String(pessoa.id));
    if(!origem.pessoas.length)origem.pessoas.push(pessoaVazia());
    // Reutiliza uma linha vazia no destino, sem exceder a capacidade.
    const indiceVazio=destino.pessoas.findIndex(p=>!pessoaOcupada(p));
    if(indiceVazio>=0)destino.pessoas[indiceVazio]=pessoa;
    else destino.pessoas.push(pessoa);
    salvarNoStorage();
    dialog.close();
    render();
    if(typeof agendarIndicacaoSalvo==='function')agendarIndicacaoSalvo();
}
function adicionarPessoa(num){
    const room=state.rooms[num]; if(!room||room.status==='indisponivel')return;
    const capacidade=capacidadeEfetivaRoom(room);
    const slotsReservados=contarVagasReservadasParaInclusao(room);

    if(slotsReservados>=capacidade){
        alert('Este quarto já possui '+capacidade+' vaga(s) reservada(s)/ocupada(s). Para incluir outra pessoa, aumente explicitamente a capacidade padrão ou o limite excedente.');
        return;
    }

    snapshotAntes();
    room.pessoas.push(pessoaVazia());
    sincronizarCapacidadeRoom(room);
    salvarNoStorage(); render();
}

function removerPessoa(num,id){
    const room=state.rooms[num]; if(!room)return;
    if(!confirm('Deseja remover esta pessoa do quarto?'))return;
    snapshotAntes(); room.pessoas=room.pessoas.filter(p=>p.id!==id);
    if(room.pessoas.length===0) room.pessoas=[pessoaVazia()];
    salvarNoStorage(); render();
}

function alterarStatus(num,status){
    const room=state.rooms[num]; if(!room)return;
    if(status==='indisponivel' && room.pessoas.some(pessoaOcupada)){
        alert('Não é possível tornar o quarto indisponível enquanto houver dados de acolhidos. Limpe/remova os ocupantes primeiro.');
        render(); return;
    }
    snapshotAntes();
    room.status=status;
    if(status==='indisponivel'){room.capacidadePadrao=0;room.capacidadeExcedente=0;room.capacidade=0;room.descricao=room.descricao||'Motivo da indisponibilidade não informado';}
    else{
        room.tipo=room.ala==='feminina'?'solteiro':room.tipo||'beliche';
        if(!Number.isFinite(Number(room.capacidadePadrao)) || Number(room.capacidadePadrao)<=0) room.capacidadePadrao=room.ala==='idoso'?1:2;
        if(!Number.isFinite(Number(room.capacidadeExcedente)) || Number(room.capacidadeExcedente)<0) room.capacidadeExcedente=0;
        room.capacidade=capacidadeEfetivaRoom(room);
        if(room.pessoas.length===0)room.pessoas=[pessoaVazia()];
    }
    salvarNoStorage(); render();
}

function alterarTipoQuarto(num,tipoQuarto){
    const room=state.rooms[num];
    if(!room || !TIPOS_QUARTO.includes(tipoQuarto) || room.tipoQuarto===tipoQuarto)return;
    snapshotAntes();

    // A troca de tipo altera também a destinação das vagas deste quarto.
    // Não importa qual era a destinação anterior (inclusive VEPEMA):
    // a nova seleção passa a valer imediatamente para os cálculos.
    room.tipoQuarto=tipoQuarto;

    salvarNoStorage();
    render();
}

function alterarDescricao(num,descricao){
    const room=state.rooms[num]; if(!room)return;
    if(room.descricao===descricao)return;
    snapshotAntes(); room.descricao=descricao.trim(); salvarNoStorage(); render();
}

function alterarCapacidade(num,nova){
    const room=state.rooms[num]; if(!room)return;
    nova=Math.max(1,Math.min(20,parseInt(nova,10)||1));
    const ocupados=contarOcupantes(room);
    if(nova+capacidadeExcedenteRoom(room)<ocupados){
        alert('A capacidade efetiva não pode ser menor que '+ocupados+' ocupante(s) já cadastrado(s).');
        render(); return;
    }
    snapshotAntes(); room.capacidadePadrao=nova; sincronizarCapacidadeRoom(room); salvarNoStorage(); render();
}

function abrirConfiguracao(num){
    const room=state.rooms[num]; if(!room)return;
    pendingConfig={num,tipo:room.tipo,capacidadePadrao:capacidadePadraoRoom(room),capacidadeExcedente:capacidadeExcedenteRoom(room)};
    const c=document.getElementById('modalConteudo');
    c.innerHTML='<label>Tipo de cama:<br><select id="modalTipo"><option value="solteiro">Solteiro</option><option value="beliche">Beliche</option><option value="berco">Berço</option></select></label><br><br>'+ 
        '<label>Nº de camas padrão:<br><input id="modalCapPadrao" class="cfg-number" type="number" min="1" max="20" value="'+capacidadePadraoRoom(room)+'" disabled style="width:45%"></label> <button type="button" id="modalEditarPadrao">Editar</button><br><br>'+ 
        '<label>Limite excedente:<br><input id="modalCapExcedente" class="cfg-number" type="number" min="0" max="10" value="'+capacidadeExcedenteRoom(room)+'" style="width:45%"></label>';
    document.getElementById('modalTipo').value=room.tipo;
    document.getElementById('modalEditarPadrao').onclick=async()=>{
        const confirmado=await confirmarAlteracaoCamasPadrao();
        if(!confirmado)return;
        document.getElementById('modalCapPadrao').disabled=false;
        document.getElementById('modalCapPadrao').focus();
    };
    document.getElementById('modalConfig').style.display='flex';
}

function fecharModal(){document.getElementById('modalConfig').style.display='none';pendingConfig=null;}

function salvarConfiguracao(){
    if(!pendingConfig)return;
    const room=state.rooms[pendingConfig.num];
    const tipo=document.getElementById('modalTipo').value;
    const cap=parseInt(document.getElementById('modalCapPadrao').value,10)||1;
    const excedente=Math.max(0,Math.min(10,parseInt(document.getElementById('modalCapExcedente').value,10)||0));
    const ocupados=contarOcupantes(room);
    if(cap+excedente<ocupados){alert('A capacidade efetiva não pode ser menor que '+ocupados+' ocupante(s).');return;}
    if(excedente!==capacidadeExcedenteRoom(room)){
        const ok=prompt('Para confirmar a alteração do limite excedente, digite CONFIRMAR:');
        if(String(ok||'').trim().toUpperCase()!=='CONFIRMAR')return;
    }
    if(cap!==capacidadePadraoRoom(room) && document.getElementById('modalCapPadrao').disabled){
        alert('Para alterar a quantidade padrão, primeiro clique em Editar e confirme a alteração.'); return;
    }
    snapshotAntes();
    room.tipo=tipo; room.capacidadePadrao=cap; room.capacidadeExcedente=excedente; sincronizarCapacidadeRoom(room);
    fecharModal(); salvarNoStorage(); render();
}
function alterarFuncionario(grupo,id,patch){
    const f=state.employees[grupo].find(x=>x.id===id); if(!f)return;
    snapshotAntes(); Object.assign(f,patch); salvarNoStorage(); render();
}
function removerFuncionario(grupo,id){
    if(!confirm('Remover este funcionário da lista?'))return;
    snapshotAntes(); state.employees[grupo]=state.employees[grupo].filter(x=>x.id!==id); salvarNoStorage(); render();
}
function adicionarFuncionario(grupo){
    const nome=prompt('Digite o nome do novo funcionário:');
    if(!nome||!nome.trim())return;
    snapshotAntes(); state.employees[grupo].push({
        id:uid('f'),nome:nome.trim(),escala:'12x36',
        ...(grupo==='vigilantes'?{turno:'Dia'}:{})
    }); salvarNoStorage(); render();
}

function limparHistoricoExpirado(){
    const agora=Date.now();
    history=history.filter(x=>agora-x.timestamp<=UNDO_WINDOW_MS);
    future=future.filter(x=>agora-x.timestamp<=UNDO_WINDOW_MS);
    salvarHistorico();
}
function temUndoMedicamentoPendente(){
    const med=state?.medicamentos, marcador=med?.ultimoRegistroParaDesfazer;
    return !!(marcador?.id && Array.isArray(med.administracoes) && med.administracoes.some(a=>a.id===marcador.id)
      && Date.now()-Number(marcador.timestamp||0)<=UNDO_WINDOW_MS);
}
function temUndoValido(){limparHistoricoExpirado();return history.length>0||temUndoMedicamentoPendente();}

/* Reversão individual de administração, sem depender apenas do histórico geral.
   Mantém o evento original na auditoria, acrescentando uma contrapartida auditável. */
function desfazerUltimaAdministracaoMedicamento(){
    if(!temUndoMedicamentoPendente())return false;
    const med=state.medicamentos, marcador=med.ultimoRegistroParaDesfazer;
    const i=med.administracoes.findIndex(a=>a.id===marcador.id);
    if(i<0)return false;
    const rec=med.administracoes[i];
    const lote=rec.loteId?med.lotes.find(l=>l.id===rec.loteId):null;
    if(rec.status==='administrado' && rec.loteId && !lote){
        alert('Não foi possível desfazer: o lote utilizado não está mais disponível. Nenhum dado foi alterado.');
        return true;
    }
    if(!confirm('Desfazer o registro de '+(rec.status==='administrado'?'ADMINISTRAÇÃO':'NÃO ADMINISTRAÇÃO')+
        ' de '+(rec.pessoaNome||'acolhido')+' em '+(rec.data||'')+' às '+(rec.hora||'')+'?'))return true;
    const antes=estadoParaHistorico();
    // Preserva Refazer para este estado completo e elimina o snapshot da operação, quando presente.
    future.push({timestamp:Date.now(),dados:antes});
    const ultimo=history[history.length-1]?.dados?.medicamentos?.administracoes||[];
    if(history.length && !ultimo.some(a=>a.id===rec.id))history.pop();
    med.administracoes.splice(i,1);
    if(lote && rec.status==='administrado'){
        const qtd=Number(marcador.quantidadeConsumida)||Number(med.prescricoes.find(rx=>rx.id===rec.prescricaoId)?.consumo)||0;
        if(!(qtd>0)){alert('Quantidade original não identificada. O registro não foi revertido.');med.administracoes.splice(i,0,rec);future.pop();return true;}
        lote.quantidade=Math.round((Number(lote.quantidade||0)+qtd)*100)/100;
    }
    med.ultimoRegistroParaDesfazer=null;
    const operador=window.__operadorAtual?.()||'Operador não identificado';
    const detalhe='Reversão do registro '+rec.id+' | '+(rec.pessoaNome||'Acolhido')+' | '+
      (rec.data||'')+' '+(rec.hora||'')+' | '+rec.status+
      (lote?' | lote '+lote.numero+' | estoque devolvido':' | sem baixa de estoque');
    med.movimentos.push({id:'reversao_'+Date.now()+'_'+Math.random().toString(36).slice(2),
        at:new Date().toISOString(),operador,tipo:'desfazer administração',detalhe,
        pessoaId:rec.pessoaId,pessoaNome:rec.pessoaNome});
    window.__auditarOcorrenciaChave?.({personId:String(rec.pessoaId||''),personName:String(rec.pessoaNome||''),
        quarto:'',field:'medicamentos — administração desfeita',previous:'Registro '+rec.id+' ('+rec.status+')',
        next:detalhe,origin:'controle de medicamentos'});
    salvarNoStorage();salvarHistorico();render();window.__atualizarModuloMedicamentos?.();
    setStatus('↶ Administração desfeita. Agenda e estoque atualizados; reversão registrada na auditoria.');
    return true;
}


function desfazer(){
    limparHistoricoExpirado();
    if(temUndoMedicamentoPendente()){
        const marcador=state.medicamentos.ultimoRegistroParaDesfazer;
        const ultimaFoto=history[history.length-1]?.dados?.medicamentos?.administracoes||[];
        // Se outra operação já foi registrada depois desta administração, use a pilha global primeiro.
        if(!history.length || !ultimaFoto.some(a=>a.id===marcador.id)){
            if(desfazerUltimaAdministracaoMedicamento())return;
        }
    }
    if(!history.length){alert('Nenhuma alteração recente para desfazer.');return;}
    const atual=estadoParaHistorico();
    const item=history.pop();
    future.push({timestamp:Date.now(),dados:atual});
    state=normalizarEstado(item.dados);
    // Desfazimento de medicação: registrar a reversão sem recriar a dose ou a baixa de estoque.
    const atuais=atual?.medicamentos?.administracoes||[];
    const restaurados=new Set((state?.medicamentos?.administracoes||[]).map(a=>a.id));
    const removidos=atuais.filter(a=>!restaurados.has(a.id));
    if(removidos.length){
        if(!state.medicamentos)state.medicamentos={produtos:[],lotes:[],prescricoes:[],administracoes:[],movimentos:[]};
        if(!Array.isArray(state.medicamentos.movimentos))state.medicamentos.movimentos=[];
        for(const rec of removidos){
            const produto=state.medicamentos.produtos.find(p=>p.id===rec.produtoId);
            const detalhe='Administração desfeita pelo operador '+(window.__operadorAtual?.()||'Não identificado')+
              ' | '+(rec.pessoaNome||'Acolhido')+' | '+(produto?.nome||'Medicamento')+
              ' | '+(rec.data||'')+' '+(rec.hora||'')+' | '+(rec.status||'')+
              ' | estoque restaurado quando aplicável | registro original: '+rec.id;
            state.medicamentos.movimentos.push({id:'reversao_'+Date.now()+'_'+Math.random().toString(36).slice(2),at:new Date().toISOString(),operador:window.__operadorAtual?.()||'Não identificado',tipo:'desfazer administração',detalhe,pessoaId:rec.pessoaId,pessoaNome:rec.pessoaNome});
            window.__auditarOcorrenciaChave?.({personId:String(rec.pessoaId||''),personName:String(rec.pessoaNome||''),quarto:'',field:'medicamentos — desfazer administração',previous:'administração registrada: '+rec.id,next:detalhe,origin:'controle de medicamentos'});
        }
    }
    salvarNoStorage(); salvarHistorico(); render();
    // Atualiza a agenda e o estoque mesmo quando a aba Medicamentos está aberta.
    window.__atualizarModuloMedicamentos?.();
    setStatus(removidos.length?'↶ Administração desfeita; estoque restaurado e reversão auditada.':'↶ Última alteração desfeita.');
}
function refazer(){
    limparHistoricoExpirado();
    if(!future.length){alert('Nenhuma alteração para refazer.');return;}
    const atual=estadoParaHistorico();
    const item=future.pop();
    history.push({timestamp:Date.now(),dados:atual});
    state=normalizarEstado(item.dados);
    salvarNoStorage(); salvarHistorico(); render();
    window.__atualizarModuloMedicamentos?.();
    setStatus('↷ Alteração refeita.');
}

function criarPacoteBackup(){
    return {
        aplicativo:'Sistema de Controle de Quartos e Plantão',
        schemaVersion:SCHEMA_VERSION,
        exportadoEm:new Date().toISOString(),
        dados:state,
        historicoAcolhimentos:acolhimentosHistorico,
        avisoArquivosHistoricos:"Arquivos históricos de lotes de 400 são separados: exporte-os também em Arquivos históricos.",
        historicoFotos:historicoFotos
    };
}

const BACKUP_FOLDER_DB = 'sistema_plantao_backup_folder_db';
const BACKUP_FOLDER_STORE = 'pastas';

function mesBackupAtual(){
    const data=String(state.dataInicioPlantao||'').trim();
    if(/^\d{4}-\d{2}-\d{2}$/.test(data)) return data.slice(0,7);
    const agora=new Date();
    return agora.getFullYear()+'-'+String(agora.getMonth()+1).padStart(2,'0');
}
function chavePastaMensal(){
    return 'pastaMensal_'+mesBackupAtual();
}
function abrirBancoPastaBackup(){
    return new Promise((resolve,reject)=>{
        if(!window.indexedDB){reject(new Error('O armazenamento do navegador não está disponível.'));return;}
        const req=indexedDB.open(BACKUP_FOLDER_DB,1);
        req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(BACKUP_FOLDER_STORE))req.result.createObjectStore(BACKUP_FOLDER_STORE);};
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error||new Error('Não foi possível acessar o armazenamento da pasta.'));
    });
}
async function guardarHandlePasta(handle){
    const db=await abrirBancoPastaBackup();
    const chave=chavePastaMensal();
    await new Promise((resolve,reject)=>{
        const tx=db.transaction(BACKUP_FOLDER_STORE,'readwrite');
        tx.objectStore(BACKUP_FOLDER_STORE).put(handle,chave);
        tx.oncomplete=resolve;
        tx.onerror=()=>reject(tx.error||new Error('Não foi possível guardar a pasta selecionada.'));
        tx.onabort=()=>reject(tx.error||new Error('Não foi possível guardar a pasta selecionada.'));
    });
    db.close();
}
async function obterHandlePasta(){
    const db=await abrirBancoPastaBackup();
    const chave=chavePastaMensal();
    const handle=await new Promise((resolve,reject)=>{
        const req=db.transaction(BACKUP_FOLDER_STORE,'readonly').objectStore(BACKUP_FOLDER_STORE).get(chave);
        req.onsuccess=()=>resolve(req.result||null);
        req.onerror=()=>reject(req.error||new Error('Não foi possível recuperar a pasta mensal.'));
    });
    db.close();
    return handle;
}
function atualizarStatusPasta(nome){
    const el=document.getElementById('pastaBackupStatus');
    const mes=mesBackupAtual();
    if(el)el.textContent=nome?('Pasta de backup de '+mes+': '+nome):('Pasta de backup de '+mes+' não selecionada');
}
function suporteSelecaoPasta(){
    return window.isSecureContext && typeof window.showDirectoryPicker==='function';
}
async function escolherPastaBackup(){
    if(!suporteSelecaoPasta()){
        const mensagem='A seleção direta de pastas não está disponível neste navegador.\n\nPara usar a pasta mensal escolhida pelo sistema, abra este arquivo no Google Chrome ou Microsoft Edge, de preferência em um endereço seguro (HTTPS ou localhost).\n\nNo Firefox, o navegador não permite que esta aplicação grave diretamente em uma pasta escolhida. Nesse caso, o backup continuará sendo baixado pela pasta de Downloads.';
        alert(mensagem);
        setStatus('⚠ Seleção de pasta não disponível neste navegador.');
        return;
    }
    try{
        const handle=await window.showDirectoryPicker({mode:'readwrite'});
        await guardarHandlePasta(handle);
        atualizarStatusPasta(handle.name);
        setStatus('✓ Pasta de '+mesBackupAtual()+' selecionada: '+handle.name+'. Os backups anteriores não serão apagados.');
    }catch(err){
        if(err && err.name==='AbortError') return;
        setStatus('✕ Não foi possível selecionar a pasta: '+(err?.message||err),true);
    }
}
function nomeArquivoBackup(){
    const nomes=(state.employees?.plantonistas||[]).map(p=>String(p.nome||'').trim()).filter(Boolean);
    const nomePlantao=nomes.length?nomes.join(', '):'Plantonistas';
    const data=String(state.dataInicioPlantao||'').trim();
    if(!data){
        alert('Informe a data de início do plantão antes de gerar o backup.');
        return null;
    }
    const partes=data.split('-');
    if(partes.length!==3){alert('A data de início do plantão é inválida.');return null;}
    const dataFormatada=`${partes[2]}-${partes[1]}-${partes[0]}`;
    const nomeSeguro=nomePlantao.replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').trim();
    return `${nomeSeguro} - ${dataFormatada}.json`;
}
async function nomeArquivoUnico(handle,nome){
    const ponto=nome.lastIndexOf('.');
    const base=ponto>=0?nome.slice(0,ponto):nome;
    const ext=ponto>=0?nome.slice(ponto):'';
    let candidato=nome, n=2;
    while(true){
        try{await handle.getFileHandle(candidato);candidato=`${base} (${n++})${ext}`;}
        catch(err){if(err.name==='NotFoundError')return candidato;throw err;}
    }
}
async function exportarBackup(){
    const pacote=criarPacoteBackup();
    const conteudo=JSON.stringify(pacote,null,2);
    const nome=nomeArquivoBackup();
    if(!nome)return;
    try{
        const handle=await obterHandlePasta();
        if(handle){
            let permissao=await handle.queryPermission({mode:'readwrite'});
            if(permissao!=='granted')permissao=await handle.requestPermission({mode:'readwrite'});
            if(permissao==='granted'){
                const nomeUnico=await nomeArquivoUnico(handle,nome);
                const arquivo=await handle.getFileHandle(nomeUnico,{create:true});
                const writable=await arquivo.createWritable();
                await writable.write(new Blob([conteudo],{type:'application/json;charset=utf-8'}));
                await writable.close();
                localStorage.setItem(LAST_BACKUP_KEY,conteudo);
                setStatus('✓ Backup de '+mesBackupAtual()+' salvo na pasta selecionada: '+nomeUnico+'. Nenhum backup anterior foi excluído.');
                window.confirmarArquivoGerado?.('Backup',nomeUnico,handle);
                return;
            }
            setStatus('A autorização da pasta não foi concedida. O backup será baixado normalmente.');
        }
    }catch(err){setStatus('Não foi possível gravar diretamente na pasta mensal. O backup será baixado normalmente.');}
    const blob=new Blob([conteudo],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=nome;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
    localStorage.setItem(LAST_BACKUP_KEY,conteudo);
    setStatus('✓ Backup preparado para download. Ele não apaga nem substitui os backups anteriores.');
    window.confirmarArquivoGerado?.('Backup',nome,null);
}

/* ============================================================
   HISTÓRICO PERMANENTE DE ACOLHIMENTOS
   - Independente do histórico de desfazer/refazer.
   - Um registro é criado quando uma pessoa recebe Data de Saída.
   - Registros antigos nunca são apagados automaticamente.
   ============================================================ */
const ACOLHIMENTOS_KEY = 'sistema_plantao_acolhimentos_v1';
const FOTOS_HISTORICO_KEY = 'sistema_plantao_historico_fotos_v1';
let acolhimentosHistorico = [];
let historicoFotos = {};
let fotoHistoricoPendenteKey = '';

/* Arquivos de 400 passagens concluídas. Arquivo JSON confirmado em pasta;
   sem permissão de pasta, mantém as passagens no banco ativo e solicita ação. */
const LIMITE_LOTE_HISTORICO=400;
const ARCHIVE_DB_NAME='frei_damiao_arquivos_acolhimentos_v1';
const ARCHIVE_STORE='lotes';
const ARCHIVE_FOLDER_STORE='configuracao';
let historicosArquivados=[];
let historicosLotes=[];
let arquivamentoEmCurso=false;
let arquivoHistoricoInicializado=false;
let arquivoHistoricoTimer=null;
function abrirDBArquivosHistoricos(){
 return new Promise((resolve,reject)=>{
  const req=indexedDB.open(ARCHIVE_DB_NAME,1);
  req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(ARCHIVE_STORE))db.createObjectStore(ARCHIVE_STORE,{keyPath:'id'});if(!db.objectStoreNames.contains(ARCHIVE_FOLDER_STORE))db.createObjectStore(ARCHIVE_FOLDER_STORE);};
  req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
 });
}
async function lerDadosArquivoStore(store,key){
 const db=await abrirDBArquivosHistoricos();try{return await new Promise((res,rej)=>{const req=db.transaction(store,'readonly').objectStore(store).get(key);req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});}finally{db.close();}
}
async function gravarDadosArquivoStore(store,key,valor){
 const db=await abrirDBArquivosHistoricos();try{await new Promise((res,rej)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(valor,key);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error);});}finally{db.close();}
}
async function listarLotesHistoricos(){
 const db=await abrirDBArquivosHistoricos();try{return await new Promise((res,rej)=>{const r=db.transaction(ARCHIVE_STORE,'readonly').objectStore(ARCHIVE_STORE).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>rej(r.error);});}finally{db.close();}
}
async function persistirLoteHistorico(lote){
 const db=await abrirDBArquivosHistoricos();try{await new Promise((res,rej)=>{const tx=db.transaction(ARCHIVE_STORE,'readwrite');tx.objectStore(ARCHIVE_STORE).put(lote);tx.oncomplete=res;tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error);});}finally{db.close();}
}
function atualizarIndicadorArquivosHistoricos(mensagem=''){
 const el=document.getElementById('arquivosHistoricosStatus');if(!el)return;
 const n=acolhimentosHistorico.length;
 el.textContent=(mensagem?mensagem+' | ':'')+'Banco ativo: '+n+' encerrado(s); arquivos: '+historicosLotes.length+'; passagens antigas consultáveis: '+historicosArquivados.length+'.';
}
async function recarregarArquivosHistoricos(){
 historicosLotes=await listarLotesHistoricos();
 historicosLotes.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
 const ids=new Set();historicosArquivados=[];
 historicosLotes.forEach(lote=>(lote.registros||[]).forEach(x=>{const id=String(x.id||'');if(id&&!ids.has(id)){ids.add(id);historicosArquivados.push({...x,arquivoHistoricoId:lote.id});}}));
 if(typeof atualizarFotosCardsModelo2==='function') atualizarFotosCardsModelo2();
 atualizarIndicadorArquivosHistoricos();
}
function nomeLoteHistorico(numero){return 'Acolhimentos_Arquivo_'+String(numero).padStart(3,'0')+'.json';}
function arquivoJsonHistorico(lote){return JSON.stringify({tipo:'arquivo_historico_acolhimentos',versao:1,id:lote.id,criadoEm:lote.criadoEm,registros:lote.registros,fotos:lote.fotos||{}},null,2);}
function baixarJsonHistorico(lote){
 const blob=new Blob([arquivoJsonHistorico(lote)],{type:'application/json;charset=utf-8'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=lote.nomeArquivo||nomeLoteHistorico(lote.numero);document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
async function salvarArquivoHistoricoNaPasta(lote,handle){
 const perm=await handle.queryPermission({mode:'readwrite'});
 if(perm!=='granted')throw new Error('A pasta não está autorizada para gravação.');
 const nome=lote.nomeArquivo;
 // Nunca substituir um arquivo histórico existente sem confirmação.
 let file;
 try{file=await handle.getFileHandle(nome);const existente=JSON.parse(await (await file.getFile()).text());if(existente.id!==lote.id||JSON.stringify(existente.registros)!==JSON.stringify(lote.registros))throw new Error('Já existe arquivo com este nome e conteúdo diferente: '+nome);return;}
 catch(e){if(e.name!=='NotFoundError')throw e;}
 file=await handle.getFileHandle(nome,{create:true});const w=await file.createWritable();await w.write(arquivoJsonHistorico(lote));await w.close();
 // Verificação antes de remover qualquer registro ativo.
 const verificado=JSON.parse(await (await file.getFile()).text());
 if(verificado.id!==lote.id||verificado.registros?.length!==lote.registros.length)throw new Error('A gravação do arquivo não pôde ser verificada.');
}
async function selecionarPastaArquivosHistoricos(){
 if(!window.isSecureContext||typeof window.showDirectoryPicker!=='function'){alert('Este navegador não permite selecionar uma pasta para gravação direta. Use Chrome ou Edge em contexto compatível e mantenha os registros no banco ativo até selecionar a pasta.');return;}
 try{const handle=await window.showDirectoryPicker({mode:'readwrite'});await gravarDadosArquivoStore(ARCHIVE_FOLDER_STORE,'pasta',handle);atualizarIndicadorArquivosHistoricos('Pasta selecionada: '+handle.name);await tentarArquivarLotesAutomaticamente();}
 catch(e){if(e.name!=='AbortError')alert('Não foi possível selecionar a pasta: '+e.message);}
}
function programarArquivamentoHistorico(){
 if(!arquivoHistoricoInicializado||arquivamentoEmCurso)return;
 if(acolhimentosHistorico.length<LIMITE_LOTE_HISTORICO){atualizarIndicadorArquivosHistoricos();return;}
 clearTimeout(arquivoHistoricoTimer);arquivoHistoricoTimer=setTimeout(()=>tentarArquivarLotesAutomaticamente().catch(e=>console.error('Arquivamento:',e)),200);
}
async function tentarArquivarLotesAutomaticamente(){
 if(arquivamentoEmCurso||!arquivoHistoricoInicializado)return;
 arquivamentoEmCurso=true;
 try{
  while(acolhimentosHistorico.length>=LIMITE_LOTE_HISTORICO){
   const handle=await lerDadosArquivoStore(ARCHIVE_FOLDER_STORE,'pasta');
   if(!handle){atualizarIndicadorArquivosHistoricos('⚠ 400 registros atingidos: selecione uma pasta para concluir o arquivamento');break;}
   const permissao=await handle.queryPermission({mode:'readwrite'});
   if(permissao!=='granted'){atualizarIndicadorArquivosHistoricos('⚠ Autorize novamente a pasta para arquivar; nenhum registro foi removido');break;}
   const loteRegistros=acolhimentosHistorico.slice(0,LIMITE_LOTE_HISTORICO).map(x=>structuredClone(x));
   const ids=new Set(loteRegistros.map(x=>String(x.id)));
   const numero=Math.max(0,...historicosLotes.map(x=>Number(x.numero)||0))+1;
   const lote={id:'lote-'+String(numero).padStart(6,'0'),numero,nomeArquivo:nomeLoteHistorico(numero),criadoEm:new Date().toISOString(),registros:loteRegistros,fotos:{}};
   // Fotografias pertencem à pessoa e continuam disponíveis para novos acolhimentos.
   loteRegistros.forEach(x=>{const key=x.pessoaFotoChave||chavePessoaHistorico(x);if(historicoFotos[key])lote.fotos[key]=historicoFotos[key];});
   // Primeiro salvar e confirmar o JSON externo, depois confirmar o armazenamento local.
   await salvarArquivoHistoricoNaPasta(lote,handle);
   await persistirLoteHistorico(lote);
   await recarregarArquivosHistoricos();
   // Só retirar do banco ativo os IDs efetivamente arquivados.
   const antes=acolhimentosHistorico.length;
   acolhimentosHistorico=acolhimentosHistorico.filter(x=>!ids.has(String(x.id)));
   try{localStorage.setItem(ACOLHIMENTOS_KEY,JSON.stringify(acolhimentosHistorico));}
   catch(e){acolhimentosHistorico=[...loteRegistros,...acolhimentosHistorico];throw e;}
   atualizarIndicadorArquivosHistoricos('✓ '+lote.nomeArquivo+' salvo e conferido ('+(antes-acolhimentosHistorico.length)+' registros)');
  }
 }catch(e){atualizarIndicadorArquivosHistoricos('⚠ Arquivamento pendente: '+e.message+' — registros mantidos');console.error(e);}
 finally{arquivamentoEmCurso=false;}
}
async function importarArquivosHistoricos(event){
 const files=[...(event.target.files||[])];event.target.value='';if(!files.length)return;
 let importados=0;
 for(const file of files){try{const x=JSON.parse(await file.text());if(x.tipo!=='arquivo_historico_acolhimentos'||!Array.isArray(x.registros)||!x.id)throw new Error('Formato inválido');
 const lote={id:String(x.id),numero:Number(String(x.id).replace(/\D/g,''))||historicosLotes.length+1,nomeArquivo:file.name,criadoEm:x.criadoEm,registros:x.registros,fotos:x.fotos||{}};
 const antigo=await lerDadosArquivoStore(ARCHIVE_STORE,lote.id);
 if(antigo&&JSON.stringify(antigo.registros)!==JSON.stringify(lote.registros))throw new Error('ID já importado com conteúdo diferente');
 await persistirLoteHistorico(lote);importados++;}catch(e){alert('Falha ao importar '+file.name+': '+e.message);}}
 await recarregarArquivosHistoricos();pesquisarHistorico();atualizarIndicadorArquivosHistoricos('✓ '+importados+' arquivo(s) importado(s)');
}
async function inicializarArquivosHistoricos(){
 try{await recarregarArquivosHistoricos();arquivoHistoricoInicializado=true;
  const botao=document.getElementById('btnPastaArquivosHistoricos');if(botao)botao.onclick=selecionarPastaArquivosHistoricos;
  document.getElementById('btnImportarArquivosHistoricos').onclick=()=>document.getElementById('inputImportarArquivosHistoricos').click();
  document.getElementById('inputImportarArquivosHistoricos').onchange=importarArquivosHistoricos;
  document.getElementById('btnExportarArquivosHistoricos').onclick=()=>{if(!historicosLotes.length){alert('Ainda não há lotes arquivados.');return;}if(!confirm('Baixar '+historicosLotes.length+' arquivo(s) JSON? O navegador pode solicitar autorização para downloads múltiplos.'))return;historicosLotes.forEach((l,i)=>setTimeout(()=>baixarJsonHistorico(l),i*250));};
  if(acolhimentosHistorico.length>=LIMITE_LOTE_HISTORICO)programarArquivamentoHistorico();
 }catch(e){atualizarIndicadorArquivosHistoricos('⚠ Não foi possível acessar o armazenamento histórico: '+e.message);console.error(e);}
}


function carregarHistoricoAcolhimentos(){
    try{
        const raw=JSON.parse(localStorage.getItem(ACOLHIMENTOS_KEY)||'[]');
        acolhimentosHistorico=Array.isArray(raw)?raw:[];
        // Registros antigos podem não possuir ID próprio. Criar identificadores únicos
        // para permitir excluir uma passagem sem afetar as outras da mesma pessoa.
        const usados=new Set();let corrigidos=false;
        acolhimentosHistorico.forEach(reg=>{
            let id=String(reg.id||'').trim();
            if(!id||usados.has(id)){
                do{id='passagem-'+(globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));}while(usados.has(id));
                reg.id=id;corrigidos=true;
            }
            usados.add(id);
        });
        if(corrigidos)localStorage.setItem(ACOLHIMENTOS_KEY,JSON.stringify(acolhimentosHistorico));
    }catch(e){ acolhimentosHistorico=[]; }
    try{
        const rawFotos=JSON.parse(localStorage.getItem(FOTOS_HISTORICO_KEY)||'{}');
        historicoFotos=(rawFotos && typeof rawFotos==='object' && !Array.isArray(rawFotos))?rawFotos:{};
    }catch(e){ historicoFotos={}; }
}

function salvarHistoricoAcolhimentos(){
    if(window.__auditCommit)window.__auditCommit();
    localStorage.setItem(ACOLHIMENTOS_KEY,JSON.stringify(acolhimentosHistorico));
    localStorage.setItem(FOTOS_HISTORICO_KEY,JSON.stringify(historicoFotos));
    programarArquivamentoHistorico();
}

function chavePessoaHistorico(p){
    if(!p) return '';
    const cpf=String(p.cpf||'').replace(/\D/g,'');
    if(cpf) return 'cpf:'+cpf;
    const sus=String(p.cartaoSus||'').replace(/\D/g,'');
    if(sus) return 'sus:'+sus;
    const nome=normalizarBuscaHistorico(p.nome||'');
    const nascimento=String(p.nascimento||'').trim();
    return 'nome:'+nome+'|nasc:'+nascimento;
}

function fotoPessoaHistorico(item){
    return historicoFotos[chavePessoaHistorico(item)]||'';
}

function comprimirFotoHistorico(file){
    return new Promise((resolve,reject)=>{
        if(!file || !String(file.type||'').startsWith('image/')){reject(new Error('Selecione uma imagem válida.'));return;}
        const leitor=new FileReader();
        leitor.onerror=()=>reject(new Error('Não foi possível ler a imagem.'));
        leitor.onload=e=>{
            const img=new Image();
            img.onerror=()=>reject(new Error('A imagem selecionada não pôde ser processada.'));
            img.onload=()=>{
                const limite=320;
                const escala=Math.min(1,limite/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
                const canvas=document.createElement('canvas');
                canvas.width=Math.max(1,Math.round((img.naturalWidth||img.width)*escala));
                canvas.height=Math.max(1,Math.round((img.naturalHeight||img.height)*escala));
                const ctx=canvas.getContext('2d');
                ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height);
                ctx.drawImage(img,0,0,canvas.width,canvas.height);
                resolve(canvas.toDataURL('image/jpeg',0.55));
            };
            img.src=e.target.result;
        };
        leitor.readAsDataURL(file);
    });
}

function selecionarFotoHistorico(chave){
    fotoHistoricoPendenteKey=decodeURIComponent(chave||'');
    const input=document.getElementById('historicoFotoInput');
    if(input){input.value='';input.click();}
}

async function processarFotoHistorico(event){
    const arquivo=event.target.files?.[0];
    const chave=fotoHistoricoPendenteKey;
    fotoHistoricoPendenteKey='';
    if(!arquivo || !chave) return;
    try{
        const foto=await comprimirFotoHistorico(arquivo);
        historicoFotos[chave]=foto;
        salvarHistoricoAcolhimentos();
        pesquisarHistorico();
        atualizarFotosCardsModelo2();
        setStatus('✓ Foto de identificação atualizada no histórico. A imagem foi reduzida para armazenamento local.');
    }catch(err){
        alert(err.message||'Não foi possível salvar a foto.');
    }
}

function removerFotoHistorico(chave){
    const key=decodeURIComponent(chave||'');
    if(!key || !historicoFotos[key]) return;
    if(!confirm('Remover a foto de identificação desta pessoa do histórico?')) return;
    delete historicoFotos[key];
    salvarHistoricoAcolhimentos();
    pesquisarHistorico();
    atualizarFotosCardsModelo2();
    setStatus('✓ Foto de identificação removida do histórico.');
}

function formatarDataBR(valor){
    if(!valor) return '—';
    const partes=String(valor).split('-');
    if(partes.length===3 && /^\d{4}$/.test(partes[0])) return partes[2]+'/'+partes[1]+'/'+partes[0];
    return String(valor);
}

function normalizarBuscaHistorico(valor){
    return String(valor||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
}

function criarRegistroHistoricoAcolhimento(room,p){
    if(!room || !p || !String(p.nome||'').trim()) return false;
    const saida=String(p.saida||'').trim();
    if(!saida) return false;

    // A mesma passagem não é gravada duas vezes se a linha for editada depois.
    const chave=[p.id||'',p.entrada||'',saida,p.nome||''].join('|');
    const existente=acolhimentosHistorico.find(x=>x.chave===chave);
    // Não recriar uma passagem que já foi arquivada em lote anterior.
    if(!existente && historicosArquivados.some(x=>String(x.chave||'')===chave))return false;

    // Mantém a relação responsável/dependentes congelada no histórico.
    // Isso é importante porque a linha atual pode ser limpa/removida depois da saída.
    let responsavelId=String(p.responsavelId||'').trim();
    let nomeResponsavel=String(p.responsavel||'').trim();
    let responsavelCpf='';
    // Migração compatível: se o registro antigo só possui o nome, tenta resolver
    // para um ID único antes de arquivar a passagem.
    if(responsavelId){
        Object.values(state.rooms||{}).some(r=>{
            const achou=(r.pessoas||[]).find(x=>String(x.id||'')===responsavelId);
            if(achou){ nomeResponsavel=String(achou.nome||nomeResponsavel).trim(); responsavelCpf=String(achou.cpf||'').trim(); return true; }
            return false;
        });
        if(!responsavelCpf){
            const hr=acolhimentosHistorico.find(x=>String(x.pessoaId||'')===responsavelId);
            responsavelCpf=String(hr?.cpf||'').trim();
        }
    }
    if(!responsavelId && nomeResponsavel){
        const candidatos=[];
        Object.values(state.rooms||{}).forEach(r=>(r.pessoas||[]).forEach(x=>{
            if(normalizarBuscaHistorico(x.nome)===normalizarBuscaHistorico(nomeResponsavel)) candidatos.push(x);
        }));
        const hr=acolhimentosHistorico.find(x=>normalizarBuscaHistorico(x.nome)===normalizarBuscaHistorico(nomeResponsavel));
        if(candidatos.length===1){ responsavelId=String(candidatos[0].id||''); responsavelCpf=String(candidatos[0].cpf||'').trim(); }
        else if(hr){ responsavelId=String(hr.pessoaId||''); responsavelCpf=String(hr.cpf||'').trim(); }
        else if(candidatos.length>0){ responsavelCpf=String(candidatos[0].cpf||'').trim(); }
    }

    const baseRegistro={
        pessoaId:String(p.id||''),
        responsavel:nomeResponsavel,
        responsavelId,
        responsavelCpf,
        dependentes:[]
    };

    if(existente){
        // Se a relação foi cadastrada/editada antes ou depois da saída,
        // atualizamos o registro já existente em vez de criar uma segunda passagem.
        Object.assign(existente,baseRegistro);
        // Sincroniza os dados da passagem arquivada enquanto a pessoa ainda está na lista.
        existente.observacao=String(p.observacao||'');
        existente.observacaoControle=String(state.controleEntradaSaida?.[p.id]?.observacao||'');
        salvarHistoricoAcolhimentos();
        return true;
    }

    acolhimentosHistorico.push({
        id:uid('hist'),
        pessoaId:String(p.id||''),
        chave,
        pessoaFotoChave:chavePessoaHistorico(p),
        nome:String(p.nome||''),
        cpf:String(p.cpf||''),
        identidade:String(p.identidade||''),
        cartaoSus:String(p.cartaoSus||''),
        nascimento:String(p.nascimento||''),
        genero:String(p.genero||''),
        origemNacionalidade:String(p.origemNacionalidade||''),
        observacao:String(p.observacao||''),
        observacaoControle:String(state.controleEntradaSaida?.[p.id]?.observacao||''),
        responsavel:nomeResponsavel,
        responsavelCpf,
        dependentes:[],
        acessibilidade:p.acessibilidade===true,
        entrada:String(p.entrada||''),
        saida,
        advertencia:Number(p.advertencia)||0,
        advertenciasMotivos:Array.isArray(p.advertenciasMotivos)?structuredClone(p.advertenciasMotivos):[],
        operadoresRegistro:p.operadoresRegistro||{},
        quarto:String(room.numero||''),
        tipoQuarto:String(room.tipoQuarto||tipoQuartoPadrao(room.ala)),
        ala:String(room.ala||''),
        registradoEm:new Date().toISOString(),
        plantonistas:(state.employees?.plantonistas||[]).map(x=>String(x.nome||'').trim()).filter(Boolean),
        plantao:state.selectPlantao||''
    });
    salvarHistoricoAcolhimentos();
    return true;
}

function arquivarAcolhimentoSeNecessario(num,id){
    const room=state.rooms[num];
    const p=room?.pessoas.find(x=>x.id===id);
    if(p && String(p.saida||'').trim()) return criarRegistroHistoricoAcolhimento(room,p);
    return false;
}

function migrarVinculosResponsavelParaIds(){
    let alterou=false;
    Object.values(state.rooms||{}).forEach(room=>{
        const pessoas=room.pessoas||[];
        pessoas.forEach(p=>{
            const nome=String(p.responsavel||'').trim();
            if(!nome) { if(p.responsavelId){p.responsavelId='';alterou=true;} return; }
            if(String(p.responsavelId||'').trim() && pessoas.some(x=>String(x.id||'')===String(p.responsavelId))) return;
            const candidatos=pessoas.filter(x=>x.id!==p.id && String(x.nome||'').trim() && normalizarBuscaHistorico(x.nome)===normalizarBuscaHistorico(nome));
            if(candidatos.length===1){
                p.responsavelId=String(candidatos[0].id||'');
                p.responsavel=String(candidatos[0].nome||nome).trim();
                alterou=true;
            }
        });
    });
    return alterou;
}

function sincronizarHistoricoComEstado(){
    let alterou=false;
    Object.values(state.rooms||{}).forEach(room=>{
        (room.pessoas||[]).forEach(p=>{
            if(String(p.saida||'').trim() && String(p.nome||'').trim()){
                if(criarRegistroHistoricoAcolhimento(room,p)) alterou=true;
            }
        });
    });
    if(alterou) salvarHistoricoAcolhimentos();
}

function migrarResponsaveisHistoricoParaIds(){
    let alterou=false;
    acolhimentosHistorico.forEach(h=>{
        if(String(h.responsavelId||'').trim()) return;
        const nome=normalizarBuscaHistorico(h.responsavel||'');
        if(!nome) return;
        const candidatos=[];
        Object.values(state.rooms||{}).forEach(room=>(room.pessoas||[]).forEach(p=>{
            if(normalizarBuscaHistorico(p.nome)===nome) candidatos.push(p);
        }));
        acolhimentosHistorico.forEach(x=>{ if(normalizarBuscaHistorico(x.nome)===nome && x.pessoaId) candidatos.push(x); });
        const ids=[...new Set(candidatos.map(x=>String(x.id||x.pessoaId||'')).filter(Boolean))];
        if(ids.length===1){ h.responsavelId=ids[0]; alterou=true; }
    });
    return alterou;
}

function somenteDigitosDocumento(valor){
    return String(valor||'').replace(/\D/g,'');
}
function formatarCPFExibicao(valor){
    const digitos=somenteDigitosDocumento(valor);
    return digitos.length===11 ? digitos.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/,'$1.$2.$3-$4') : String(valor||'');
}
function correspondePesquisaHistorico(registro, busca, digitosBusca){
    if(!busca) return true;
    const nome=normalizarBuscaHistorico(registro.nome);
    const cpf=normalizarBuscaHistorico(registro.cpf);
    const sus=normalizarBuscaHistorico(registro.cartaoSus);
    if(nome.includes(busca)||cpf.includes(busca)||sus.includes(busca)) return true;
    // Compara os números, independentemente de pontos, hífens ou espaços.
    return !!digitosBusca && (somenteDigitosDocumento(registro.cpf).includes(digitosBusca) || somenteDigitosDocumento(registro.cartaoSus).includes(digitosBusca));
}
function obterResultadosHistorico(termo){
    const busca=normalizarBuscaHistorico(termo);
    const digitosBusca=somenteDigitosDocumento(termo);
    const resultados=[];

    // Inclui também a pessoa atualmente acolhida, mesmo antes da saída.
    Object.values(state.rooms||{}).forEach(room=>{
        (room.pessoas||[]).forEach(p=>{
            if(!String(p.nome||'').trim()) return;
            // Quando existe Data de Saída, a passagem já deve estar no arquivo histórico.
            // Assim a pesquisa não apresenta a mesma passagem duas vezes.
            if(String(p.saida||'').trim()) return;
            if(!correspondePesquisaHistorico(p,busca,digitosBusca)) return;
            resultados.push({
                origem:'atual', nome:p.nome, cpf:p.cpf||'', identidade:p.identidade||'', cartaoSus:p.cartaoSus||'', nascimento:p.nascimento||'', genero:p.genero||'',
                origemNacionalidade:p.origemNacionalidade||'', observacao:p.observacao||'', responsavel:p.responsavel||'', responsavelId:p.responsavelId||'',
                pessoaId:String(p.id||''),
                entrada:p.entrada||'', saida:p.saida||'', quarto:room.numero, tipoQuarto:room.tipoQuarto||'',
                advertencia:p.advertencia||0, advertenciasMotivos:p.advertenciasMotivos||[], operadoresRegistro:p.operadoresRegistro||{}, pessoaFotoChave:chavePessoaHistorico(p), ativo:true
            });
        });
    });

    if(migrarResponsaveisHistoricoParaIds()) salvarHistoricoAcolhimentos();
    acolhimentosHistorico.forEach(x=>{
        if(!correspondePesquisaHistorico(x,busca,digitosBusca)) return;
        resultados.push({...x,origem:'historico',pessoaFotoChave:x.pessoaFotoChave||chavePessoaHistorico(x),ativo:false});
    });

    const vistos=new Set(resultados.filter(x=>x.origem==='historico').map(x=>String(x.id||'')));
    historicosArquivados.forEach(x=>{
        if(vistos.has(String(x.id||''))||!correspondePesquisaHistorico(x,busca,digitosBusca))return;
        vistos.add(String(x.id||''));
        resultados.push({...x,origem:'arquivo',pessoaFotoChave:x.pessoaFotoChave||chavePessoaHistorico(x),ativo:false});
    });
    resultados.sort((a,b)=>String(b.entrada||'').localeCompare(String(a.entrada||'')));
    return resultados;
}

function removerLinhaHistorico(id){
    if(!window.__adminPrincipalAtivo?.()){ alert('Somente o Administrador Principal pode remover passagens do histórico.'); return; }
    const registro=acolhimentosHistorico.find(x=>String(x.id)===String(id));
    if(!registro) { alert('Esta passagem não foi encontrada. Atualize a pesquisa.'); return; }
    if(!String(id||'').trim()){ alert('Registro sem identificador único. Exclusão bloqueada para proteger outras passagens.'); return; }

    const nome=String(registro.nome||'Pessoa sem nome');
    const entrada=formatarDataBR(registro.entrada);
    const saida=formatarDataBR(registro.saida);

    const confirmacao=prompt(
        'ATENÇÃO: esta ação removerá SOMENTE esta passagem do histórico.\\n\\n' +
        'Pessoa: '+nome+'\\n' +
        'Entrada: '+entrada+' | Saída: '+saida+'\\n\\n' +
        'Para confirmar, digite exatamente: REMOVER'
    );

    if(confirmacao===null) return;
    if(String(confirmacao).trim().toUpperCase()!=='REMOVER'){
        alert('Exclusão cancelada. A confirmação digitada não foi "REMOVER".');
        return;
    }

    if(!window.__adminPrincipalAtivo?.()){alert('Sessão administrativa encerrada. Exclusão cancelada.');return;}
    const indice=acolhimentosHistorico.findIndex(x=>String(x.id)===String(id));
    if(indice<0) return;
    const removido=acolhimentosHistorico.splice(indice,1)[0];
    try {
        salvarHistoricoAcolhimentos();
        if(window.__registrarExclusaoPassagem)window.__registrarExclusaoPassagem(removido);
    } catch(erro) {
        acolhimentosHistorico.splice(indice,0,removido);
        alert('Falha ao salvar a exclusão: '+erro.message);return;
    }
    pesquisarHistorico();
    setStatus('✓ Apenas a passagem selecionada foi removida. As demais foram preservadas.');
}

function periodosAcolhimentoSeSobrepoem(a,b){
    const inicioA=String(a?.entrada||'').trim();
    const fimA=String(a?.saida||'').trim() || '9999-12-31';
    const inicioB=String(b?.entrada||'').trim();
    const fimB=String(b?.saida||'').trim() || '9999-12-31';
    if(!inicioA || !inicioB) return false;
    return inicioA<=fimB && inicioB<=fimA;
}

function nomeNormalizadoHistorico(valor){
    return normalizarBuscaHistorico(valor||'').replace(/\s+/g,' ');
}

function obterDependentesDoResponsavel(registro){
    if(!registro) return [];
    const responsavelId=String(registro.pessoaId||registro.idPessoa||'').trim();
    const nomeResponsavel=nomeNormalizadoHistorico(registro.nome);
    if(!responsavelId && !nomeResponsavel) return [];

    const candidatos=[];
    Object.values(state.rooms||{}).forEach(room=>{
        (room.pessoas||[]).forEach(p=>{
            if(!String(p.nome||'').trim()) return;
            if(String(p.id||'')===responsavelId) return;
            const vinculadoPorId=responsavelId && String(p.responsavelId||'')===responsavelId;
            const vinculadoPorNome=!responsavelId && nomeNormalizadoHistorico(p.responsavel)===nomeResponsavel;
            if(!vinculadoPorId && !vinculadoPorNome) return;
            const atual={
                nome:String(p.nome||''), nascimento:String(p.nascimento||''), entrada:String(p.entrada||''),
                saida:String(p.saida||''), cpf:String(p.cpf||''), cartaoSus:String(p.cartaoSus||''), id:p.id||'',
                quarto:String(room.numero||''), pessoaId:String(p.id||'')
            };
            if(periodosAcolhimentoSeSobrepoem(registro,atual)) candidatos.push(atual);
        });
    });

    acolhimentosHistorico.forEach(x=>{
        if(!String(x.nome||'').trim()) return;
        if(String(x.pessoaId||'')===responsavelId) return;
        const vinculadoPorId=responsavelId && String(x.responsavelId||'')===responsavelId;
        const vinculadoPorNome=!responsavelId && nomeNormalizadoHistorico(x.responsavel)===nomeResponsavel;
        if(!vinculadoPorId && !vinculadoPorNome) return;
        if(periodosAcolhimentoSeSobrepoem(registro,x)) candidatos.push(x);
    });

    const unicos=new Map();
    candidatos.forEach(x=>{
        const chave=[String(x.pessoaId||x.id||''),nomeNormalizadoHistorico(x.nome),String(x.entrada||''),String(x.saida||''),String(x.quarto||'')].join('|');
        if(!unicos.has(chave)) unicos.set(chave,x);
    });
    return [...unicos.values()];
}

function obterDadosResponsavelHistorico(registro){
    const responsavelId=String(registro?.responsavelId||'').trim();
    const nomeResponsavel=nomeNormalizadoHistorico(registro?.responsavel||'');
    if(!responsavelId && !nomeResponsavel) return null;

    const candidatos=[];
    Object.values(state.rooms||{}).forEach(room=>{
        (room.pessoas||[]).forEach(p=>{
            if(!String(p.nome||'').trim()) return;
            if(responsavelId ? String(p.id||'')!==responsavelId : nomeNormalizadoHistorico(p.nome)!==nomeResponsavel) return;
            const atual={
                nome:String(p.nome||''), cpf:String(p.cpf||''), nascimento:String(p.nascimento||''),
                entrada:String(p.entrada||''), saida:String(p.saida||''), quarto:String(room.numero||'')
            };
            if(periodosAcolhimentoSeSobrepoem(registro,atual)) candidatos.push(atual);
        });
    });

    acolhimentosHistorico.forEach(x=>{
        if(!String(x.nome||'').trim()) return;
        if(responsavelId ? String(x.pessoaId||'')!==responsavelId : nomeNormalizadoHistorico(x.nome)!==nomeResponsavel) return;
        if(periodosAcolhimentoSeSobrepoem(registro,x)) candidatos.push(x);
    });

    candidatos.sort((a,b)=>String(b.entrada||'').localeCompare(String(a.entrada||'')));
    return candidatos.find(x=>String(x.cpf||'').trim()) || candidatos[0] || null;
}

function pesquisarHistorico(){
    const campo=document.getElementById('historicoBusca');
    const termo=campo?.value?.trim()||'';
    const mostrarTodos=!!document.getElementById('historicoMostrarTodos')?.checked;
    const ordenacao=document.getElementById('historicoOrdenacao')?.value||'recentes';
    const resultados=obterResultadosHistorico(termo);
    const compararNome=(a,b)=>String(a.nome||'').localeCompare(String(b.nome||''),'pt-BR',{sensitivity:'base'});
    if(ordenacao==='az') resultados.sort((a,b)=>compararNome(a,b)||String(b.entrada||'').localeCompare(String(a.entrada||'')));
    else if(ordenacao==='za') resultados.sort((a,b)=>compararNome(b,a)||String(b.entrada||'').localeCompare(String(a.entrada||'')));
    else if(ordenacao==='idade-crescente'||ordenacao==='idade-decrescente'){
        const direcao=ordenacao==='idade-crescente'?1:-1;
        resultados.sort((a,b)=>{
            const idadeA=idadeDaPessoa(a), idadeB=idadeDaPessoa(b);
            if(idadeA===null && idadeB===null)return compararNome(a,b);
            if(idadeA===null)return 1;
            if(idadeB===null)return -1;
            return direcao*(idadeA-idadeB)||compararNome(a,b);
        });
    }
    const alvo=document.getElementById('historicoResultados');
    if(!alvo) return;
    if(!termo && !mostrarTodos){
        alvo.innerHTML='<div class="historico-vazio">Digite o nome, CPF ou Nº Cartão SUS da pessoa para consultar todas as passagens registradas.</div>';
        return;
    }
    if(!resultados.length){
        alvo.innerHTML='<div class="historico-vazio">Nenhum acolhimento encontrado para <strong>'+escapar(termo)+'</strong>.</div>';
        return;
    }

    const nomesUnicos=[...new Set(resultados.map(x=>normalizarBuscaHistorico(x.nome)).filter(Boolean))];
    const nomeExibicao=resultados[0].nome;
    const cpf=resultados.find(x=>x.cpf)?.cpf||'';
    const cartaoSus=resultados.find(x=>x.cartaoSus)?.cartaoSus||'';
    const historicos=resultados.filter(x=>x.origem==='historico'||x.origem==='arquivo').length;
    const atuais=resultados.filter(x=>x.origem==='atual').length;

    alvo.innerHTML='<div class="historico-resumo">'+
        (mostrarTodos&&!termo?'<strong>Todos os registros:</strong> '+resultados.length+' passagem(ns)':'<strong>Pessoa localizada:</strong> '+escapar(nomeExibicao)) +
        (!mostrarTodos||termo ? (cpf?' &nbsp;|&nbsp; <strong>CPF:</strong> '+escapar(formatarCPFExibicao(cpf)):'') : '')+
        (!mostrarTodos||termo ? (cartaoSus?' &nbsp;|&nbsp; <strong>Nº Cartão SUS:</strong> '+escapar(cartaoSus): '') : '')+
        '<br><strong>Passagens registradas:</strong> '+historicos+
        (atuais?' &nbsp;|&nbsp; <strong>Acolhimento atual:</strong> '+atuais:'')+
        '</div>'+
        '<table><thead><tr><th>Nº</th><th>Identificação</th><th>Situação</th><th>Entrada</th><th>Saída</th><th>Tempo de acolhimento</th><th>Quarto</th><th>Tipo de quarto</th><th>Gênero</th><th>Data de nascimento</th></tr></thead><tbody>'+
        resultados.map((x,i)=>{
            const foto=fotoPessoaHistorico(x) || (x.origem==='arquivo' ? historicosLotes.find(l=>l.id===x.arquivoHistoricoId)?.fotos?.[x.pessoaFotoChave||chavePessoaHistorico(x)] : null);
            const chave=encodeURIComponent(x.pessoaFotoChave||chavePessoaHistorico(x));
            const idHistorico=encodeURIComponent(String(x.id||''));
            const visual=foto
                ? '<img class="historico-foto" src="'+foto+'" alt="Foto de identificação">'
                : '<div class="historico-sem-foto">Sem foto</div>';
            const acao=x.origem==='arquivo' ? '<small>Arquivo histórico · somente leitura</small>' : foto
                ? '<button type="button" class="btn-secondary btn-foto-historico" data-foto-acao="trocar" data-foto-key="'+chave+'">Trocar</button><button type="button" class="btn-foto-historico" data-foto-acao="remover" data-foto-key="'+chave+'">Remover</button>'
                : '<button type="button" class="btn-foto-historico" data-foto-acao="adicionar" data-foto-key="'+chave+'">Adicionar foto</button>';
            const botaoExcluir=x.origem==='historico'
                ? '<button type="button" class="btn-excluir-historico" data-historico-excluir="'+idHistorico+'">🗑️ Remover esta passagem</button>'
                : '';
            const origemTexto=String(x.origemNacionalidade||'').trim();
            const observacaoTexto=String(x.observacao||'').trim();
            const observacaoControleTexto=String(x.observacaoControle||'').trim();
            const responsavelTexto=String(x.responsavel||'').trim();
            const dadosResponsavel=obterDadosResponsavelHistorico(x);
            const cpfDoResponsavel=String(dadosResponsavel?.cpf||'').trim();
            const dependentesResponsavel=obterDependentesDoResponsavel(x);
            const cpfResponsavel=String(x.cpf||'').trim();
            const idadeHistorico=idadeDaPessoa(x);
            const idadeTexto=idadeHistorico!==null ? String(idadeHistorico) : '';
            const nomeComIdade='<div class="historico-identificacao-nome-linha"><span class="historico-identificacao-nome">'+escapar(x.nome||'—')+'</span>'+(idadeTexto?'<span class="historico-identificacao-separador"> / </span><span class="historico-identificacao-idade">'+escapar(idadeTexto)+' Anos</span>':'')+'</div>';
            const dependentesTexto=dependentesResponsavel.map(dep=>{
                const idadeDep=idadeDaPessoa(dep);
                const idadeDepTexto=idadeDep!==null ? ' / '+idadeDep+' Anos' : '';
                return '<div class="historico-identificacao-responsavel" style="margin-left:12px"><span class="historico-identificacao-label">'+escapar(dep.nome)+'</span>'+escapar(idadeDepTexto)+'</div>';
            }).join('');
            const blocoDependentes=dependentesResponsavel.length
                ? '<div class="historico-identificacao-responsavel historico-bloco-dependentes"><span class="historico-identificacao-label">Dependentes:</span>'+dependentesTexto+'</div>'
                : '';
            const identificacaoDados='<div class="historico-identificacao-dados">'+
                (responsavelTexto
                    ? '<div class="historico-identificacao-responsavel"><span class="historico-identificacao-label">Responsável:</span> '+escapar(responsavelTexto)+(cpfDoResponsavel?' / <strong>CPF Nº:</strong> '+escapar(formatarCPFExibicao(cpfDoResponsavel)):'')+'</div>'
                    : '')+
                nomeComIdade+
                (x.cpf?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">CPF:</span> '+escapar(formatarCPFExibicao(x.cpf))+'</div>':'')+
                (x.identidade?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">Identidade:</span> '+escapar(x.identidade)+'</div>':'')+
                (x.cartaoSus?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">Nº Cartão SUS:</span> '+escapar(x.cartaoSus)+'</div>':'')+
                (origemTexto?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">Origem/Nacionalidade:</span> '+escapar(origemTexto)+'</div>':'')+
                (observacaoTexto?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">Observação do acolhimento:</span> '+escapar(observacaoTexto)+'</div>':'')+
                (observacaoControleTexto?'<div class="historico-identificacao-info"><span class="historico-identificacao-label">Observação de entrada e saída:</span> '+escapar(observacaoControleTexto)+'</div>':'')+
                blocoDependentes+
                '<div class="historico-identificacao-acoes">'+acao+botaoExcluir+'</div>'+
                '</div>';
            return '<tr>'+
                '<td style="text-align:center">'+(i+1)+'</td>'+
                '<td><div class="historico-identificacao">'+visual+identificacaoDados+'</div></td>'+
                '<td><div class="historico-situacao-info"><strong>'+(x.ativo?'ACOLHIDO ATUAL':'ACOLHIMENTO ENCERRADO')+'</strong><span><strong>Acolhimento/Desligamento:</strong> <button type="button" class="btn-hist-operadores" data-resultado="'+i+'" title="Ver operadores de acolhimento e desligamento">ℹ️</button></span><span><strong>Advertência: '+Number(x.advertencia||0)+'</strong> <button type="button" class="btn-hist-advertencias" data-resultado="'+i+'" title="Ver motivos das advertências">ℹ️</button></span></div></td>'+
                '<td>'+formatarDataBR(x.entrada)+'</td>'+
                '<td>'+formatarDataBR(x.saida)+'</td>'+
                '<td>'+(()=>{const dias=calcularTempoAcolhimento(x.entrada,x.saida);return dias===null?'—':dias+' '+(dias===1?'dia':'dias');})()+'</td>'+
                '<td style="text-align:center">'+escapar(x.quarto||'—')+'</td>'+
                '<td>'+escapar(x.tipoQuarto||'—')+'</td>'+
                '<td>'+escapar(x.genero||'Não informado')+'</td>'+
                '<td>'+formatarDataBR(x.nascimento)+'</td>'+
            '</tr>';
        }).join('')+'</tbody></table>';
    alvo.querySelectorAll('.btn-hist-operadores,.btn-hist-advertencias').forEach(btn=>{
        btn.onclick=()=>{
            const x=resultados[Number(btn.dataset.resultado)];if(!x)return;
            const dlg=document.getElementById('dialogInformacoesHistorico');
            const titulo=dlg.querySelector('.hist-info-titulo'),corpo=dlg.querySelector('.hist-info-corpo');
            corpo.replaceChildren();
            const linha=(rotulo,valor)=>{const div=document.createElement('p');const b=document.createElement('strong');b.textContent=rotulo+': ';div.append(b,document.createTextNode(String(valor||'Não identificado')));corpo.append(div);};
            if(btn.classList.contains('btn-hist-operadores')){
                titulo.textContent='Registro de acolhimento e desligamento';
                const op=x.operadoresRegistro||{};
                const aud=(()=>{try{return JSON.parse(localStorage.getItem('frei_damiao_auditoria_v1')||'[]')}catch{return []}})();
                const eventos=aud.filter(a=>String(a.personId||'')===String(x.pessoaId||'')&&(a.field==='entrada'||a.field==='saida'));
                const entrada=eventos.find(a=>a.field==='entrada'&&a.next===x.entrada);
                const saida=[...eventos].reverse().find(a=>a.field==='saida'&&a.next===x.saida);
                linha('Acolhimento realizado por',op.acolhimento||entrada?.user||'Não registrado');
                linha('Data de entrada',formatarDataBR(x.entrada));
                linha('Desligamento realizado por',op.desligamento||saida?.user||(x.saida?'Não registrado':'Ainda não realizado'));
                linha('Data de saída',x.saida?formatarDataBR(x.saida):'Ainda não realizado');
            }else{
                titulo.textContent='Motivos das advertências';
                const motivos=Array.isArray(x.advertenciasMotivos)?x.advertenciasMotivos:[];
                linha('Total de advertências',Number(x.advertencia||0));
                if(!motivos.length)linha('Motivos','Não registrados para este acolhimento');
                motivos.forEach((m,j)=>{linha('Advertência '+(j+1),typeof m==='string'?m:m.motivo);if(m&&typeof m==='object')linha('Registrada por',m.operador||'Não identificado');});
            }
            dlg.showModal();
        };
    });
    alvo.querySelectorAll('[data-foto-acao]').forEach(btn=>{
        btn.onclick=()=>{
            const acao=btn.dataset.fotoAcao, chave=btn.dataset.fotoKey||'';
            if(acao==='remover') removerFotoHistorico(chave);
            else selecionarFotoHistorico(chave);
        };
    });
    alvo.querySelectorAll('[data-historico-excluir]').forEach(btn=>{
        btn.onclick=()=>removerLinhaHistorico(decodeURIComponent(btn.dataset.historicoExcluir||''));
    });
}

function abrirHistorico(){
    const painel=document.getElementById('historicoPanel');
    painel?.classList.add('aberto');
    const campo=document.getElementById('historicoBusca');
    campo?.focus();
    pesquisarHistorico();
    painel?.scrollIntoView({behavior:'smooth',block:'start'});
}
function fecharHistorico(){document.getElementById('historicoPanel')?.classList.remove('aberto');}

function validarBackup(pacote){
    if(!pacote||typeof pacote!=='object')throw new Error('Arquivo inválido.');
    if(!pacote.dados||typeof pacote.dados!=='object')throw new Error('Estrutura de dados ausente.');
    if(pacote.schemaVersion && pacote.schemaVersion>SCHEMA_VERSION)throw new Error('Backup de versão mais nova que este sistema.');
    return normalizarEstado(pacote.dados);
}

function importarBackup(event){
    const arquivo=event.target.files[0]; event.target.value='';
    if(!arquivo)return;
    const leitor=new FileReader();
    leitor.onload=e=>{
        try{
            const pacote=JSON.parse(e.target.result);
            const novo=validarBackup(pacote);
            if(!confirm('Substituir os dados atuais pelos dados deste backup?'))return;
            snapshotAntes();
            localStorage.setItem(LAST_BACKUP_KEY,JSON.stringify(pacote));
            if(Array.isArray(pacote.historicoAcolhimentos)) acolhimentosHistorico=pacote.historicoAcolhimentos;
            if(pacote.historicoFotos && typeof pacote.historicoFotos==='object') historicoFotos=pacote.historicoFotos;
            state=novo; salvarNoStorage(); salvarHistoricoAcolhimentos(); render();
            setStatus('✓ Backup importado. Os arquivos históricos separados permanecem no IndexedDB; use Importar arquivos antigos caso estejam em outro computador.');
        }catch(err){setStatus('✕ Não foi possível importar: '+err.message,true);alert('Erro no backup: '+err.message);}
    };
    leitor.readAsText(arquivo,'utf-8');
}

function restaurarUltimoBackup(){
    try{
        const pacote=JSON.parse(localStorage.getItem(LAST_BACKUP_KEY)||'null');
        if(!pacote){alert('Nenhum backup importado/exportado anteriormente está disponível.');return;}
        const novo=validarBackup(pacote);
        if(!confirm('Restaurar o último backup registrado? Os dados atuais serão substituídos.'))return;
        snapshotAntes();
        if(Array.isArray(pacote.historicoAcolhimentos)) acolhimentosHistorico=pacote.historicoAcolhimentos;
        if(pacote.historicoFotos && typeof pacote.historicoFotos==='object') historicoFotos=pacote.historicoFotos;
        state=novo; salvarNoStorage(); salvarHistoricoAcolhimentos(); render(); setStatus('✓ Último backup restaurado.');
    }catch(e){alert('Não foi possível restaurar o backup.');}
}

function mudarPlantao(){
    const novo=document.getElementById('selectPlantao').value;
    if(novo===state.selectPlantao)return;
    snapshotAntes(); state.selectPlantao=novo; salvarNoStorage(); render();
}

/* ============================================================
   IMPRESSÃO — Relação de Acolhidos
   ============================================================ */
function normalizarGenero(valor){return String(valor||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();}
function pessoaAtivaResumo(p){
    return pessoaOcupada(p) && !String(p?.saida||'').trim();
}
function contarCategoria(predicado){
    let total=0;
    Object.values(state.rooms||{}).forEach(room=>(room.pessoas||[]).filter(pessoaAtivaResumo).forEach(p=>{if(predicado(p,room))total++;}));
    return total;
}
function destinoVagaDoQuarto(room){
    // A destinação da vaga é SEMPRE determinada pelo tipo de quarto atual.
    // Isso é importante quando um quarto que era VEPEMA é alterado para
    // Idoso, Masculino, Feminino, Trans ou Outro.
    const tipo=normalizarGenero(room?.tipoQuarto||tipoQuartoPadrao(room?.ala));
    if(tipo==='feminino') return 'mulher';
    if(tipo==='masculino') return 'homem';
    if(tipo==='idoso') return 'idoso';
    if(tipo==='vepema') return 'vepema';
    if(tipo==='trans') return 'trans';
    if(tipo==='outro') return 'outro';
    return tipo;
}

function contarVagasPorTipo(tipo){
    const destinoEsperado=normalizarGenero(tipo);
    return Object.values(state.rooms||{}).reduce((soma,room)=>{
        if(room.status==='indisponivel') return soma;
        const destino=destinoVagaDoQuarto(room);
        let corresponde=false;
        if(destinoEsperado==='mulher' || destinoEsperado==='feminino') corresponde=destino==='mulher';
        else if(destinoEsperado==='homem' || destinoEsperado==='masculino') corresponde=destino==='homem';
        else if(destinoEsperado==='idoso') corresponde=destino==='idoso';
        else if(destinoEsperado==='vepema') corresponde=destino==='vepema';
        else if(destinoEsperado==='trans') corresponde=destino==='trans';
        else if(destinoEsperado==='outro') corresponde=destino==='outro';
        else corresponde=destino===destinoEsperado;
        if(!corresponde) return soma;
        const ocupantes=(room.pessoas||[]).filter(pessoaAtivaResumo).length;
        return soma+Math.max(0,capacidadePadraoRoom(room)-ocupantes);
    },0);
}

function formatarDataImpressao(valor){
    if(!valor) return '';
    const m=String(valor).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3]+'/'+m[2]+'/'+m[1].slice(2) : String(valor);
}

function textoAlaImpressao(ala){
    return ala==='feminina' ? 'ALA FEMININA' :
           ala==='idoso' ? 'ALA IDOSO' : 'ALA MASCULINA';
}

function tipoQuartoImpressao(room){
    return TIPOS_QUARTO.includes(room.tipoQuarto) ? room.tipoQuarto : tipoQuartoPadrao(room.ala);
}

function descricaoQuartoImpressao(room){
    const capacidade=Math.max(0, capacidadePadraoRoom(room));
    const tipo=room.tipo==='solteiro'?'Solteiro':room.tipo==='beliche'?'Beliche':room.tipo==='berco'?'Berço':tipoQuartoImpressao(room);
    const genero=tipoQuartoImpressao(room);
    const unidade=capacidade===1?'':'s';
    const capacidadeFormatada=String(capacidade);
    return `<span class="numero-quarto">${room.numero}</span><br>`+
           `<span class="camas-quarto">${capacidadeFormatada} ${tipo}${unidade}</span><br>`+
           `<span class="tipo-quarto">${genero}</span>`;
}

const LOGO_CABECALHO_BASE64='iVBORw0KGgoAAAANSUhEUgAAAxkAAACyCAYAAAAu0AJPAAA8a0lEQVR4Xu2dz8s1yXXfvXggWY7+gcODt/ZiQEtvLkQL49WAmJUxPMHGGBLDEBt7ZXM3ISIQGAUCGWLwYztoIce2MGhhhPCDiY2JBjRgcISMlCfyjxglI49tMRgxM517bnf1W/d7Tv3o6rq/nvst+PC+U3XOqerq2++cb3dV9w8Nw/BDhBBCCCGEENILU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0FIDvkX//kzO355x+d2fCXBFyebn93xaYxBCOkPr01CCCGXhKkgJGaXiHxqSko0QRka+d6Od3a8ifFbkXFM2M8p+WUcU8fxvYvxjo2MiSmOo5bsXEzxW+bjMxinJ7v4n3b6rOV7GO/UyIVem4QQQohiKghRZExgNPHUJAQTkzV8a8fPYn9LkbaktSfZxFrbHZ8lnPQus6w7z9m5mOK3zMexRcYaYaWcJTGXC782CSGEEMVUECJjQtg7gUHelRWJtLQlrT3JJtba7vgs4R2MeSxkXDqD/S8hOxdTHy3zcWyRoUk19rmEk52jgFzBtUkIIYQopoLcLjLeIdWlE5h0HJOmO6fSlrT2JJtYa7vjs5RPYdxjIOuW2yjZuZj6aJmPo4mMXew3nf6Wosn+qc7R1VybhBBCiGIqyG0iYxKjdzAx0TgFi5MZaUtae5JNrLXd8VlKto8e7Pr4YaffpRTHqTaOX4ljioxeCfvi3+5S5MquTXKx3O94nNC/YzshhHTFVJDbRMa3zmCCcUoWJTPSlrT2JJtYa7vjs5RvYdzeSJ9kOzsXUz8t83FMkdFrydEXMXZvtA+n31Oy6NokF8f9MAoLLFqnbWhPCCFdMBXk9pC2BPAYVK8Dl/OPOZtYa7vj08IxE229Q94j2c7OxdRXy3wc5dhl/R4U5Iexj15I27wdg+prk1wM94MvLrCojdqiPyGErMJUkNtCxuUyPRLNHnwFx5dCzp98ZRNrbXd8Wjja5mLpl2xn52Lqq2U+jiUyej8ZKB5/C3Kl1yY5O/dDnbjAoj7qi/EIIaQJU0FuC1n/Gs/eVCWW0pa09iSbWGq749PKUTYXS791/tm5mPpqmY+q38ISZHx6g/2s5SjfNZErvTbJ2bgfCuLiu9//6z2FojE0FsYnhJBFmApyW8i6O6X6ViJNHvVNPXpXXP++NnGtWuMubUlrT7KJtbY7Pq1k+2pB1n2IDimOT20cvxLdk9rGcdTQfTmRXOm1SU7Oa0OFuPitP/v88K/+8M09+vdKsaGxsT9CCKnCVJDbYZc0fMZJJGrQ5CeZAMqY2KxJkIp37qUtWUyOuTeN40vRfQO49NnwHbgmkbE20U7xOexrDXLF1yY5GSoAtjs+GBLl+z/4x+HL3/yvs7hAKsSGxtY+KDYIIYsxFeR2kLbETym+bUbGO+WtyUzxS8rSNvZk8tWbxvHl6DZ26bfhO3AVIkP6vK43RVchKG3zpZz92iRHp1pc/OIf/ZQRFh4UG4SQY2AqyO0gbWu+q5MpaU+UriJpzdE4vhzdlqpIvw3fgas4X9L2e19CtwRc2sZ6EdcmORrdxQVCsUEI6YmpILeDtH3pufotM9J+57iYUEtbktQ1ac3ROL4SXV6VKv2XDBUTT7Vx/Ep0PV+7eN9y+uhJtzeByRVfm6Q7RxcXCMUGIaQHpoLcDpqUOElEiepEJupjKcX17XIBSWuOxvGVKCbzJaTvhu9AcVxq4/iV6Ha+NJYTv8TSV91+D/ttRa742iTdOLm4iNGYGlv7yBSKDUJIElNBbocpacBEpUT1koxjImdOWks0jq/E6rmXvhu+A9cgMpYetz7taRFkxT0RNcgVX5tkNWcVF8hCsYHHQgi5YUwFuR1k+Z3aQDGpPDY6BmdcJbolrSUax1dD87p/6b/hO1D8PaiN41ei2/mS5ce9PyZZvsSqy3IijePErqF4LsjFclHiAqkUG887HgZ7bISQG8RUkNtBExInSamlyx3bVhrH3i1pLdE4vhqak1jpv+E7UExs1cbxK9HlfEnbce/3v0jbuFe/5rWx38BZr03SxHa4UHGBUGwQQmoxFeR2kPGd+ZigLEGXdHRJBJcibUnYycbaOL5amjaAS/8N34FLFxlLnwrMX/CWtg3SxfkoIVd8bZJFPAxjQp4sX/32716EuEAoNgghJUwFuR1kXD6DyUkLmtCc9O6pnDFpraFxfLUsTmKlbX9BLcXxqI3jV2L1+ZK23/jB8chycTaLlFakbdweJ782SRUPQ0Fc/Ml3/mD41T/+OZPcXxpBbBSKHqseM84DIeQFYyrIbSHLN8Tm0HXvGq9530At0pa06tjUbw1VTxEmW+y/F4s3+Er9eV66d0G5ZJHRvFQqitEy9qrfSQ6pP2c1nOzaJFkehhciLhAds469UPTYdQ5wXgghLxBTQW4LaVsOUoMmNfpBsU9jnz2QtsSvB1WJr7SNb0lSWX13WpZt+F4yhsAli4zVTyGk7RpZ/arXxn5rOOq1SVwehhcqLpAFYuONwc4TIeQFYSrI7SFtCeAS9A091U8BapjiYT+noCrxlbbxLVmHX/1NBFl2N7/lexIXKTKkLUl3j0WWi5XFT5s8dDxO7J50vzbJAQ/DjYgLpFJsPO3YDHbeCCEvAFNBbhNZvjm2Fb1Tvip5nMZ77OQrRdXYpW18muAveZJQlRhKfYK8T4yd+hJuYg5jaJoPjLOExj7dOW2MtWr8Abmya5PseRhuVFwgFBuE3C6mgtwmMi6pqU1Ge7Dq7TfSlvT1oGrM0jY+FRlLnmYUl+TIsg3f4dsQWF/iUkXG0m9cmKVSUayWpyLvYJwW5MquzRvnYSiICy2/9WefHz7/7q8k+dyf/huTrF86KibwOGL0mCvK00CxQciLwVSQ20aW3Unvga4NX/xdAWlLWntQlXxJ2/j2saU+Of4e9ovIsvMZvg2B9SUuTmTIMnEVyB6HLE/0i+dnCbLsXPag6dq8UR6GCnFRW77x/94zSfylU/GGqSXlaaDYIOTqMRWEyHg3vTbR7YEmb4uSGWlLWntQlfhK2/iCyNDkDttSJDeAy7IN3/MeD6etRDY5n2I2z0cL0paQu0ulopgtx9D1bU4aTy782uzBrs/XdmwUbLswNsOYEHctFBlz0bnVOcZ5J4RcAaaCEEUTCxmTqlMlNIuSGWlL+HpQlfhK2/iCyFiyNCe5AVyWbfiexYrTVuISRUatuAokl0pFMZecl0DzF9pTyIVfmz2QUWDs+8e2C2EzHEFchEKRYYrO9euDPQ8Xw90/++f3O7Y7nibe3rFBO/DZTD732AYxkTd2vIb2OXb2D5Nv0S/Tr8a4R3vE8TuIgfY13L2aK2SDtoiO2fFbFIO0YSoIQWS8e3qKzafVyYy0Ja09qEp8pW18c2xZtjTHvQO/IIYm5PO8O+0lLkpkyLJ9LYHiMUyxa+c0puo33YJc4LXZA7lskbEdxqS3lg+GQvn4739/+Og7m/m/r11k/Nt//0fDz//Sl4dv/sX7c12mvDfYOUtxka+9vRuT7yHBI9pHfprgqs0G26b2jRMvZos+Hju71yKft7AdWduvYx/zhPY1aJ9OrMDzjqQIvVt5PKQdU0FICk0yZEwWWxKtWoqbmaextCStPahKfKVtfLHIWOJv5kyW7Uk42KDstJcoJuhq4/iVqJprRNqSbleoIdJ2HMklbb2QC7o2eyCXLTJq2QxjYpwsn3z/D/fi4qP/9ak9obwEkRHOX4XYUBG23VG8w36J3I13yTVR/WDHXgRNdW9NddrmiiNNbqf2DbZN7SE5fpz+HngoxYY4OpY5Icd2pLLfB/SL/LX9PfANJMVAjrtXc6XHEsfTMYb5d39Dk513PIF79CF9MBWE1CDj0hFdjtOS0JUoJnzSluxd+he/Y5GhSSO2pzh4EjH5L9mTcJDMO+0lLkZkyLJ5CxSXSkXxW5ZMVcfvwTTGs12bPZDrFhmboSQuPvza8NHf/MwsLl6yyAio2Hj//Q9nG6dcpdi4e5X8PjhtumRqn9xiG/husG1qD8nx1ml7fWp7wjbkbkz497a5/iL7mn71CZTxnWyqxrUEHUtq7HevhMYDtk3tyeMhx8VUELIUGRO7nklN8dWfcqKktZUe45Nl8xnvqViy4dt8NM6xKXFJImPJPpRAcfzQR8vTgpMk54ic4drsgVynyNgMjeLiFkSG8qM/8Wv7tpckNgrJ770m2zvexraS79SeTY7vJvGA9WATRIEm4m+Ev6Md+Kzqd/J9wvo16FimuBunrTTebDs5HqaCkDXIeBd1yV10j+KrP+VESWsrPcYny/YWzHfLZVmibRJsx6aEiYGojeNXYvH5kvEbDxinxCIBIG3HUpyjY6PHKSe4Nnsg1yUy7nc8DplSEhe3IjICC8RGcf/AucklvyVKvqXk+G56MoH1YPMY93E37l9ILi2abFb1O/k+Yf0adCzxcUBbabzZdnI8TAUhPZBxT8Cat998GmNC/JZEb3HS2kqv8Un9EwllP2ey7E67SbAdmxLFBFptHL8SZj5ySNtSplNhnhidCznytdkDuQ6RcT90Ehe3JjIClWLjeRi/Q4LzfxHkkt8SJd9ScnxXTvZfuxsFxXNUF5ZwPaB9ZLO2X/V1QdtadCxTjI3TVhpvaPdwfUgfTAUhvZBxqcaShDcmm2DKCZLWNfQanyz7ZobepV6y4dt9/a1jV+JSREZLH6fk6Ml5LXLEa7MHctki434oiYsf/OXw0Xe3RkSUCOVWREbgmsVGLvktUfKNkuMttk3tpWT/Af3vXm1Uz+2pWNuv+j6rP4K2tUz+7lxVjDe067hxTCYe6YepIKQnmpDg/1AqySau2u74lDh6chToNT5ZJhr0qceStffuW48cuxLZczXF7DIfOWTd3flTcJL9DLXIka7NHshlioz74Uji4tZFRuAaxUYu+Z3aNcF136hU6ZtLnjVpHrAe2+/GPRT690C4i58a19p+9wk91q9BxzLF3ThtpfFm28nxMBXkdpAx8VuKm5jmCP8DWUg2kZnGgj4lFiWta+g5Pmm/41zC/e6BY1cie66mmN3mw0OWibFzUb2fQex1V8NFXJs9kMsSGbp2fTtkylpxQZFxiIqN//if/nSOlyjPwwWIjULy+5BLuHO+U3syOb5zlkJB+/3k+6z9A+FtU4/oV+p3atd+dc+MaZvak8fcio5lirtx2h4K480eDzkepoLcDtK2SXbx6zgb+8kmMtru+JSoTlrX0nN8jbFKJO+qO7YlsudqxTG48+Ehy5aVnZM3cewe0nbNXMS12QO5DJERxIUmU27pJS4Cody6yAj82Gd/Y/j13/z6HDdRnoczio0owf2S0xaSeXcDey5xntqTyfHdqw3dj9g2tSf3Xty9+jifKxTW9DvZnExk3I1i6nlqa3oyQ46HqSC3g7QlGIp7BzyF419DNsGUIyeta+k5Pmn79kOJZLLr2JYoJp1q4/iVcOfDQ5ZtkD8nSXEHx3O112YP5Lwioyguho//Yfj4/XeMSFhLKBQZh1SKjadhfI0wns+jc/dKTGiyq8mwJuJ6t3+fyN8l3uQ02ZrEOWoPybHGfYoIsbXfVOz904ZMu44xJUJS/ep/h2O6R7/IP9jEvjNoX8Pdq7nSY47jaZ3yNvpEvpvJRsdvxnPnzAHpg6kgt4O0JX5KMamM+mhd953dJKtjcHxKHD05CvQenyzba1Ei+6Yjx75E8fegNo5fieR8QOwlr/q9BIpCQNrmSymei6iPo1ybPZDziIx6cfH8I0Yg9CAUigyfSxUbd+OTgcco4Q1oAnuP9pFfSJw32Da1h+QY0bjqmxIQwe8R2yKbNyabrdOW61efkLj9Rv7odwDa13D3aq5iVMh86a7w1fO79PEEtuhD+mAqyO0g65Kz4vpvaX+DTXHturQlYVVJaw96j0/WnSvkcxgf+kL7EsXEVm0cvxLJ+YDYa7/9cGpqrp0157sm/tGuzR7I6UWGLmc5m7gIhEKRkedSxYZyN378boP1hNwipoLcFrJumYkmju5dWRmTpNa3/RSXlEhb0qo+eve2B+b7Eh3Gl02qZd25iimNHe1LnE1kyHGWkh0b99XBiKw732e7NnsgpxMZD8O4pt8vJxIXgVAoMuq4ZLFBCKHIuHmkz11gXT8esyY5UmqSy5aktSfZxFrbHZ8S2eOWPpubi5uDHZ8S2bmYYnafjynukq+bBzTBxt/sGjB+DVmhNx3bVV6bPZDji4yHIScuduXjv/vCycRFIBSKjGX8+E9+YfjKV789958oTwPFBiEnxVSQ20Iu7yvJtXd5W5LWnmQTa213fEpkEzjp85rWmqU06FMiOxdTzO7zMcVt2atSnIMlNI6hZs6u8trsgRxPZDwMJXHx978/fPSdjREApyAUiow23vzp364VG+5biAghfTEV5PaQtgTwWBQTywsZczZJ1HbHp0Tx2KVtHX2Mu4QG+kCfEtm5mGJ2nw9pT8KLc7AEaXyagnE8pG3ejkX2fPRE+osM3Rj6PGTKJx9+7WziIhAKRUYafWqhYiJHxQf9tDwO4wcW8bdyNch4nSD3aHcr6LE787FBO3I6TAW5TWR98tqD7IZkGO+5k69sYq3tjk+JYhLXGDdQtZ7e8SuRnYspZsu4s/PRGLNqDpYg7ftCqt7SJFd2bfZA+omMzTDeue5WjvHq2kAoFBlpKp5ULC2PwwqxsRvT2zueGvjSju2O6qcqMibR6vOeOHMT8bzjUQoJtvYtdlw1hLG7b3Vy7LuA/Ux9vSHjeD4QOw8xOmdv7ci+GYv0xVSQ20Ta3zbTi0VLMaQtwexJNrHWdsenRDapnuK2JrRK8tsY0Af6lcjOxRSz+3xI2++1ag6WIm1LpqoSd7mya7MHsl5kbIbO4iIUigyfKxYZoTwODWJDxgTYjHMhGiPbt4xJPfrVoAm4m1hLdJ2t4HnHA8RFmy5AH0EgGbsCKkYOxkuOh6kgt4ucL5nRDamLlrBIW9Lak2xire2OT4lsUh3Fbkloq5bnTPHRt0R2LqaYXedD2vanHO31q9K2ZKp6PHJF12YPpF1kbIYjiYtQKDJ8XoDICOVxWCA2pC3R9dDk1zzV2NW9JuUnFyVSsefrrAOPUVxs60IU/0HKTy5KzOMlx8NUkNtGxmSmx1ttaqm6m4tIW9Lak2xire2OT4lkUg2xW76hUD3Pjm+J7FxMMbvOh7S9aav7UqmAtD9hqn6yMvVx8ddmD2S5yLgfjiwuQqHI8DmjyHhvGM99b9ylQIj0ExnKs8BTB+kXX5Pye4g9X2ed2E5xsb4LU2x9gmHaGnkbzyfpi6kgRNldfPotiNZ36degsZNJZAlpS1p7kk2std3xKVE9H7L8VaTFV6ZGsdG3RHYupphd50PafpvVCX0L0vaEabHwkQu/Nnsgy0XGMdkOUaHI8DmjyNgM9pydDOknAgL6YcgQ+8FpX8MTjH2+zjpy79R1YRrzM9avZIPnlPTDVBASI+MykJ7LNDSBWf0KUWlLWnuSTay13fEpUZ3YybI7+cVvY0Bs9C+RnYspZrf5kLYnOdVLk1qRtiVTStNypKm/i7s2eyAUGSaJv3QoMrrxHMXunVAr87IpOY7I0M3VWNeLB6duLV/Cc0r6YSoI8ZDxdaGaKLZ80EuTF02K3aSxBWlLWnuSTay13fEpUT0/smxPQnasiONfohhfbRy/Eu58SNuSocVPDJYi7UumViX2cmHXZg+EIsMk8ZcORYbLo4wbtmPelvJ+gnupWxak8fVaCWiC/+zYxcxLhCYfbA9oHBy78uTYxmg7+tT6l3x1Ezv6xDzLKEQ2E2/IOEdoh7gb48l6TAUhNciY2OiyDb2bqgkOonebtb3pLi0hpI2XcG0KRYZJ4i8digyXDdpPPvPvO4G2a1KN9TFmI/cUu7RR/KlyHLMdIqNQQvvAB2gPvrnj2qI9+KJ9TPKJhJSfgGzQh/TBVBBCCCHnRP+nHxIAbDsD2yEqFBk+FBkuG7SP/HJCQO/A55LxR4wHsdUffWYiu1aRkfOb43tI/ri2aA++aB9zj/bgmztP2X5JO6aCEEIIOSdCkWGS+EuHIsNlg/aVfrrsKde+xXiI4zMT2eTEwhPGrPSb43tIo8iQwvIxtEda+yXrMBWEEELIORGKDJPEXzoUGS4btI/8cvsy9Pefi7vFeIjjMxPZ5MTCE8aM/KqelHhIY7Iv+bFm+1zTL1mHqSCEEELOSZxQYNsZ2A5Rocjwochw2aD95PPo2B74ST7uFmMijs9MZJNL3J8w5uRzL/mlXq5f5N+U7Et+rAPaI639knWYCkIIIeScxAkFtp2B7RAVigwfigwXTca1PSb3BGNPRdwtjgNxfA7iTza5xF3HiWN/duyQ7AfupDHZl/xY52NK0dovWYepIIQQQs5JnFBg2xnYDlGhyPChyOjG/i1Jko+7xXEgjs9MZJNN3Bu5x7HAuJqSfSmMFe2R1n7JOkwFIYQQck7ihALbzoAmfXOhyPChyOjGpiLuFseBOD4zkU02cW/gEceBSGOyL4Wxoj3S2i9Zh6kghBBCzkmcUGDbGXgaokKR4UOR0YX4Q3m5uFscB+L4zEQ22cR9Ibo0rPhRO2lM9qUwVrRHWvsl6zAVhBBCyDmJEwpsOwNPQ1QoMnwoMlbzuCDuFseBOD4zkU02cV+AjrUoMKY+m5J9KYwV7ZHWfsk6TAUhvZDxq8Lv7PhedDG/u+NzAl8b3v33p3d8pcDnsI/JV79wrDHVJvTzLRn7/gzaTz7BPoV+GfmHHT+0M0x2+rVl05YC+4n6+yLY/izaRLY9jsmd48lOvxRdNW4PjV3b12Svvx+3P4H5RV+vv5TvjjfR1/Gfx5qKC76fknG+1Sb8/vVPPZ/uOdT6OO6OT0/1pWtDx+P+ziF+GI85JkQSYzkVQpFhkvhLhyKjGX0C8MbCuFu0Rxyfmchmvs5WUiUwpj63jn9gi/a1Y0V7pLVfsg5TQUgPZExS8EKO0YRrTlxkTCjRBjEJnYyJE9ohmtihqNHECe0QHeNBQujYGBaM68AHkTGpR9t30S6y73FMZo4jOxWIGM9N0D00tuNvRE9kr+ftwD5qO5hf9PX6S/nKOCcHvw/HPxYpbtyoXc9bLKw9dC4PEnex49oLB/3T8fd4B8cSxVbRg/aKOe7cWE6FUGSYJP7Sochw0Y/q6W85RTI5L8Tdoj3i+MxENvN15vAU2T047TGP2H8KaUz2JT/WAe2R1n7JOkwFIWuR8ckCXsQe34p8ahKpgwRYxju4aJPiIDnXWI5NilgMYZthssMkLUs8tqgvfRJjbCVxV1n6HJMrMiR9Tr+Itik0tuP/y2iX6y9q7yky3OMA/yqRIb4wTKFCZBZZYse1VGQoqflMif6UvTuWUyEUGSaJv3QoMlw2aF+L5L+lsUV78L13fGYiu/k6c3iCmLlvYygbHIeHNCb7u7bXHPsZtEdkxXySdkwFIWsRm6DsExkZ76bqMqa4LZVIuclP1AfaK5qUazKliZ6XoM8xxSa8Gi+AvvMdYqh3E3IPqUiKwV7nKnU33F3mouMBu27HJPacxrh3wxGN7fjOQrOmv1Q7+nv9pXwjDp7KgH9RZIh/ztRW+9NzoKLYtGfGlb02ZBRi+nuPY6bm05t7xX0ypn2AHUXGVCgyfCgyXDZoX4vkk/FnyT8FedvxCbwX2c3XmcMTxMzZHsTNIfnj2qI9+KJ9zFtoH/ndS/77JA/oQ/pgKghZi9gEZU7eZEyYtD2wv5M71cc+JZGBSZNZ5651YBM/OXETxag99osTQbe+hFQkxWCPY4/HW5VIOu3u2FP14BuLw+Lcezh+AbPkCvqbidqL8ymJ+UDfiINlU+BfIzIwrlm+JOP+ChQa4RpA/6zIiGIeCEinT3wqhOfBLFnTPsDmlkXG4xAVigyfU4mM99//cO5nKpvBnrOTIccTGW848WL0ycJBfBnv9ucEhrL/DsdkP19nDk/OmHLHqjygDyLrREbpaYrGPhBfMh7js2Mb8zr2RfpgKghZi9gERRPGbCIqhUQKbHF9uZsYT7aa1M139KN6N1GM2t34qfoSUpEUg328H0HX7+MyHC8xP8oxyTiHB33L4f4M9244orEhTuBgqdIUH232RDbF+ZTEfKAvMI8F/GtERjwn7j6PyU6T/vgp095O7Lh6iQyMi6LDPBlzfG5ZZGyHqFBk+JxKZDhlM9hzdjIkn3hv0L4WKSwPighf5i4l4IGHqI/5OnN4csZ079jF6FiST1imGFvHL7BFe/AtCaiAzoXOSe7pReAZ+yH9MBWErEX8ZSOK1rlvfNI6xx6pSrpqEJvwxkkf7vWIl1nhmBB3LFof22E72GISGJbHxHPq3SXvcUyeyIiT2O9NdZiEmrvhiMYGn/h44r0JKLBmn8imOJ+SFgM4dtxgvhdw4F8jMuIYZh5LiB1X6ve+v4Ym0Mc85dK6qH0vovTPgg/GNdfsMZELFhmffP8PjTjoRSgUGWmcshnsOTsZciSRMcV+dGKu4Rniz9eZwxOOZ/IpJfrztz48ZJ3IuHd81pLtk6zDVBDSAxnvfrtLXiY0UYsTS0ykPFJJ1+IESGzCm0KPIV5Cg+1ID5GBCV5YTnOQ7EvbG7OU3DGZ5FgccSMJIZRDY4NPLHzifQahTvt15y1Vn+sv5Svj7ym23c8P1C0VGcX5QNQHYqR+7zlwXwk+hdo/UdQ/of7gGpLEWE6FXLLI+PBrRhz0IhSKDJ8f/Ylfm/uIyv1gz9nJkOOKDH2aUXM3vpaDV+VKm8ioGVNy+ZGsEBkV/kup2kdC2jEVhPRExmQG7xQH5mRXbCKlbZrMxYTvBqBtS0KHCa/HgRCa/OJ2TYJxjO6yMKlIiiNbdymS2GVE+CraHsd0IDLE9hnvr4nHae6GI1Pfcaw4Ad77y+E8qQhx5y1Vn+sv5Svj70nFTSym8LsrS0WGEWslxBnXVI+/9xTmOhD7BCtcb7jk8ODJmMaC9lsWGZqYzeWTf/qGEQe9CIUiw+fNn/7tuY+o4Pk6KXJEkTHFf13KSX0N5gmDNIiMyW/r2MfM+z6Qgu8W7T2kzxMendN7jE36YioIOQYyJjX4Jhwl3MHGRMokTFEsvItuXj9aQmzCi0mVmyTW2HhgfGyP7PDOs45TfQNxG+5l6H5M2ocTM4D9ua/WTY1vqouFiv4+4qdfOhfuvGG9OMu15LC/eNM/+oZkHuvj32qNyIjHvl9WtgSn/5TIiAW4nh/1M8c/+R68eWqyDSTHO7WbsZwKuSyRsRmgoDjoRSgUGT7/8l9r7npQPhjs+TopcmSRocgoNJ6d+DVoMv2AMae483Xm8IT24JsbT9JXOoiMKU5p2VYO3bNxjzFJf0wFIWuRMSmKk5l4WRTeGV8sMiZ7/DCcSYLEJuxzIiVOoij2Na9ezLjdTdo9JJEsI2LvPJeI57brMYm9213C7BOBfrzxxfMSJ8T7JzjQvveZ6nG5Dz7VwX1B8XElE2i1gzbP3xzHVI/nzvyGZRwXLiMMT+jccemfpbgeYq+1EvMcah/QZn43x0QuS2TcD1A++s7GCIQehEKR4aNxoTwN9nydFDmByFBkXKa0lXxyH6Pi4lEyybSOz/ELPKE9+L7h+BR9pZPImGKp+PqSEyeFzt0DxiHHw1QQshaxCUq8ydhtk4WJlNgEKqzfjzfEuk9NJn+TKIpdMmOWAEG8Y4gMTEBLHO2YxCbyJbJ37zV2bD/VpYRM+F248yb2aZYeo45Xzz2+/WqO58VUn6gNhWmgRmTgXCvxJm0dH46rKH4m37g+e21E8VBglojfrOWO5VTIZYkM5aB89Le/YARCD0KhyPD5nd/787mPqTwO9ly9eGRMrt+SMWF/itC7+1q3QZ+XjIwCTEWPHvsjzInWPUhmnwg5HqaCkLWITQAVTa68u8Sp72R44FKeJUmU9p/6BsIQ1WNydZDQOXENsX0qLrZPNjgHYSkMYu74T/49jimVTAcRh+ByKvNq3US8eHwYQ3Ff6wrxas+/jj0+9zgfBwm0066k5gXHtESY6bjiL69jv80iQ+yTHP3947lTUPS48z7Z6XHPYJ89kcsTGU9DVI71GttQKDJ8vvkX7899TCX5ATZCyPkxFYT0QOqSrXh5BiZSHiaxkbpE80BgTH5uoqh2cpicYYKKsQ04xskvmSxHNngsqXX2rp30Oab9HGtMqHeXQtXaTbap8eFTqeQddYinx4VJMnKQyHsxxblL78StEhlTe81vv3pc+ifU14gMHEPqhQSunfYB9QaM1RO5PJGhm2bncqw3TIVCkWH5sc/+xhw/KpvBnitCyIVgKgjphYzJkXeXWpM0vHuMiZSHERnQDy5V0UQxlVwlE0WxCdacOEO9C/blxcT2ycZ9QoGITcr3H1OTPscURAba555QYEJ+IOgiu9z44mNP7g3AmJENLjPTeCrGzFgwpvgiA5dNVYuMyUbFl/aP4wqbr6vHpX9CfY3IwOvO9DfZ4XI1dy+MB8bqiVyeyHgYoKBA6EEoFBmWn/+lL8/xo4Lnidw4Mi4l038/ZtCGnA5TQcgxkDHpyr59iJC1yJiQuwk1uR6m5GCfXGLbmbgfoHz0Nz9jRMJaQqHIsPz6b359jj+Vs3/jQMaE9inBFu1zyLifAmMEcv0s5SHqE9tmcHwlNC7G8Pr0WOmr+zF0f4ramt9NxLOMc3yPMcjxMBWEEELIOZHLExnK8xCVj//uC0YkrCUUigzL++9/OMefivnuw6mR/NuZql+vK2OijP4xuX6Wso36xbYZHGMJjYsxvD49Wn0nvw8cnxKPO17DeKQ/poIQQgg5J3KZIuNxiMonP/hLIxLWEgpFxiE//pNfmGNHZTPYc3RSpJz8H3xhO4WMd/LRN6bUzxK2Ub/YNoNjLKFxMYbXp8dSXxlF2ZNju4Rn4Runjo6pIIQQQs6JXKbIOPjyt5aP/uqzRiisIRSKjEOcpVLVTwmOjeTvpD+ivYfkv/XwnlBkoH1uvpag545PNI6IqSCEEHJ8ZNw/El4Ju98MLuOG8/1/o/0tIZcpMhRNbufSe8lUKBQZhzhLpR4He27OguS/PF0lhhy/mAehyIhtdT7QZg36GXkzJtIHU0EIIeS4iP/hvhj3rWi3glyuyHgc4vLxPxihsIZQKDJekXirVNUypFMg46ZsM+6I7Fi13fGJ0aVBFBmvbJ8dm7Xc45hIH0wFIYSQ4yKvXhGrr7nVb1XEr7p1X9V8S8jliozNAOWj726NWGglFIqMV3zlq9+e407lebDn5axIPvF9RHvwfXR8Avu77JIXGdq3Jum1bKK+MdYMjrPEFNvEmdiifYuvlAWd8iijcNtM6JOm3JI25ewvEXipmApCCCHHRcZlUQev253+m695Hi5aZCjPQ1Q++advGLHQSigUGSNv/vRvzzGjsh3sOTkrkk+Ss0umtN3xCeyfgkheZDxhzFqcWDNoW0Lyc7BF+xbfgp2ywdiTnz4N0r0taB94Qh/SB1NBCLku5NW6fo9wp9z9dsSu/nOOD5JMfMFu/1HARNzU18tjG3eJkPpG8cL/FPTOvx6b+ZCe1z+2J+zm8YONe4xTWxhb/CQijC05b5G/PtFIxs8h43mN50TR/3Y/9uehY4T+ParH1Au5bJHx1gCl1zczQqHIGPmd3/vzOWZU7gd7Ts7Kbqz3OHbAXTKl9Y5tYBYnQpER7HL7Xx4xLvRRNdekL6aCEHJdOP9geuj6f/PVbrFJqoebyDt9J7+KHbdl/M1mZ60DGw/9uvVBUq39xTYYN2FXM8b4GDVBz+2rUFzhNPnj17YDWYEgY7/4JXFEx5U8b1Es/Jq4hzsvx0QuW2To22gONoB/8uHXjGBoIRSKjORTjMfBno+LQPJ3yh/RfvJ5dGyNj1BkBLsnpz3wgHERx2cGbUkfTAUh5LrAfywLHCS9YsWARzJZBbucyFA8EZFsl/EJAcZI8S74nkJklBL9QOopjj6JQFvFzFPkUyNsYoywhHgUGW1sBygf/e0vGNGwlFAoMty9GFpeH+y5uAgk/9Yj90651ju2gU1kN18PDk8YtxYn1gzalpBKoeBR6yt5kbHBuIjjM4O2pA+mghByXcA/lu/KmDgq3nIaZRYN2I6xS0DcksjQ5Pgg4Yb2ObkWP/kNS7/enP6O7bF/1XGBnZtMQx97G7Hj+2Jkr09W3HFl+o45EEyRvT75QGGjMXROUudb5zz5ZGTyK4711Mjliwz7NKPDx/lCuXWRkXiK8TTY83AxSPmr3QdLpiS/ifkZbOfrwUGFylMFD86YMdYM2paQvFB4FjueGG1Hn8A26kNtsT2wwTEhjs8M2pI+mApCyHUB/1iaRFnsHfOkGEDfErVxPRvHPykSxFl2pHVg862UP/om7MzcTTZm/GKT83g/iu7T0GVeAfMkaLI5iAv/bZ5+TLFim3fQZrJDAZYUDmKPI2l7SuTyRYayHaB8/P47RjgsIZRbFxnf/Iv351hRuR/sObgoJP+RuEewze0vOHjbkeRFRi1bZ7xoM4O2JTQ+xujEPG6hyLg6TAUh5LqAfyxTibKbxGI9+pVI9Y1xgVhMmHqxexXcY5psw1ua9qT6R7+EnduPN5ap37henxgs2XCNggFFh9lsLeNTqri/ZF9Te7CdxRciFBlrME8z9t/N+M7GiIdaQrllkaG+Tnkc7PxfHLJgyZTk797fg+18Paxg64wXbWbQtoTGxxidmMctFBlXh6kghFwX8I9lKlHGpHafkKs9/mNbE6/UtxM3XkI0L5sCmyAyVie+cmSR4fjG6LGaJy8QM172tF9qNfmFOiMMoA93rJHtwdMMbI/scK49zJOYYyPXITKUhwHKmk3godyqyPjxn/zCHCMqmpyroMO5v0ikYp+F5JdKvefEnK+HFWyduGgzg7YlND7G6MQ8bqHIuDpMBSHkuoB/LN3kU2wyeWqRoU8n4rvrIbGObVIiY3GSK6cRGXpMeJwxKiTM2MU+BdkLEv0T6g98oc0da2R7ICqxPbLDufYwx3Bs5HpEhvI0QPn4//4HIyBqCOUWRcaP/sSvpZZJvTXYOb9YJP/GqP0yKP3TaQuY4xWKjNDHk9Me2OCYEMdnBm1JH0wFIeS6gH8s3eRTEgms2qM/YJbt1PSNcac63bAd2+N/p0TGRT7JiNp1vPrkIPXWp4PvZYh9a9Z+2ZP+CfUHey6gzYwDbFufZKgwwt9A8XsfvZHrEhn3Ay6b2pWP/uqzRkSUCOUWRcav/+bXZ/+oPA12vi+a+Lfr8DzZPDttgfuFMWvZOnHRZgZtS2h8jNGJedxCkXF1mApCyHUB/1i6yafYzcAn3ZMR1eOyqdg/iAzcnzC/uakWSfSPgJ1ZojTZxGNxN1tHtiqc4r0TZvwC+yVkfOoQiJdRfQ/8luzJOPg4ILZHdigyFgu6YyDXJTIUvft8WHR/xvOPGCGRI5RbExk//0tfnn2josLtfrBzffFIXkTkPgr3JYw1xZuvB4cntK/FiTWDtiUkLzIeZTyGFNqOPoFt1MeT0x7Y4JgQx2cGbUkfTAUh5LqAfyyNyBC7PGfxW5hSpPpOxRW7bCom3hCOibpZsiP2uOakXBL9I5IQX1G7m4Srnf49It50jk8k4nnBpzcl5r0dAkugJCF4au0mW/f4zo1cn8hQngYon/zTNxYJjVBuSWQkXler5WGwc3wVSH45VG7PxgPGmuLN14PDE9rX4sSaQdsSkhcZW7Rv8RWKjKvDVBBCrgv4x3Kf0MqY6GoCiUtzlDhxrUrGU3h9l+KKTYIDscjAZDy8vSm8SUr/jmIl9k/2D2PBZWQqbrRv7UPbsI/90qGpPa6Pjx3FT/wNDRQ1JWJfT6Dpk6EwJ2HZVtxuvk0Cx4/HQZHRjn3b1K58/Pe/b8REilBuRWToRu/33/9w9ovK42Dn92rYHds9Hmsl7gZ3ocgIdrlXBJf6yJ4TtCd9MBWEkOsC/7EsgOv8D5LxBOYpQqLvKpHhtU8cJLhiE+YcKg7m5UNi44f9BYH4uxb4gbsUB0+JHL+wnwGFQNjYjSJBxxw/DQngU5z4uFB8lSi95QpFhod5OnZs5DpFhvL64JRaoRHKLYiMjMDQtyu5yfY1sTvG9/CYCzxijCjWfD04PKF9LU6sGbQtIZVCwaPWt2D3LAmRNvnmni6ZN3qRPpgKQsh14fyDmcJs4habjHscQ2TociNMxs1ddKkTGgcCw+vfAZ884FgQr48av1nUiX1q4gqAkt3UXupX2934EIsioz8Pg1NqhEYoL11kZATG1e7DQHbH+RYed4E3MEYUa74eHJ7QvhYn1gzalpC8ANiifYuv5L9DojyJ/caIfok9F19x98KQ9ZgKQsh14fyDGaPJsS6ZcpfMSDkZV7qLjMkGl00ZkTHZaSKsy4IwsdZjcxNpKR8XPpXQpwzeG6L2G7MxfuSnYinlh+Ig3vSuuBu3tR7s3k3Y6HnFpyk6Dh2Pe74Rocg4FtvBKSWhEcpLFhkFgaFPgnAurxIpLM8B9NhNjCjWfD10YBvFxbZWniSfyM99etT6yigYsN1DnyLpmBRs83jAMZE+mApCCLllZNrPgvUlWv16oP1q/1h/rcj1iwzlcXDKXmgkNoOH8lJFRkZgaNkMdg6vGsnvIYh5G30hDkXGK9tHx2YNWYFH1mEqCCGEkHMiL0NkKI+DU1JvnQrlJYqMxGtqQ3kY7NxdPVJe3hPIPsERiozY9l7yb+haSnKZGlmPqSCE3A4y3n3fbzjGNkLOhbwckaE8Dl7R72jAB/tCeWkiI/GhPS16F/lhsHP2IpBxeU8pIX5GPyS+HjqwjeJiWysnExmd5+MRY5O+mApCyMtHXomLeC+B2UdAyDmQlyUyFF0O45aP33/nxYoMXR71P97967keyovag5FCE1lIbJEt+iDx9dCBuT+nrZWTiozJ53XJf/SwxFsYk/THVBBCXj5yuOFXhUYsNs6yr4CQgIxLIjTx2GLbFfMwJMonH35t+Og7m/m/X4LIUDLlebgBgaFI/gvfyj36IEKRYXwmv/DmqNLTophHqZhz0gdTQQh5+cgoMlRY6NMMfaoRP9mgyCDkOGwG54N9WK5dZBTK0/ACvoOxBBlFggvaesiYTBvfRu5rxrUQfapw79QH5j491vjCsWxlFBFPEbr5XutV7N3U7+4SMBWEkJePTMIiUV/1+lNCSBP3w/jBuWT53x980yTxl06lyMi+RYkQ8rIwFYS8JDRhlvGbCTGfRjvHB79BoH/X7w+4vkt95HA8Bx/Jk1dPFeIvP+sTBv3Owptgqx9mw+NLssBn3psB9V/EY5ls9MN0sZ055qhvPY54ntR+/0QF7Z3+zQcFIzv9GvbBcaBNCR3DNJbi3CPy6psZ3m+g6umQLJwfsfOe3FMzxaidS/yNuOeTrGI7ZMp3v//Xw2/92edNMn9p/Oof/9zwJ9/5Axw+lufhBb6ilhCSx1QQ8pLQREpeJWuBXHJV8xVn/Mhai0/cFn/ETpPcOMH1iL8ijR+0y7LAZ37bVK4tssGPuh0k1TLOUem4dA5NIg82SeGQiG/ipZCFcw++3u8MUbFhhMLk3zQ/YufdnJvJDj/wF0iNB38jVSKJLEb3JWSfaqjY+G//878Mv/hHP2US/HPy+Xd/pUZcaHkcbmx5FCFkxFQQ8pIQ+0XkfbKGdgV7j3lJUaNPXB+LDE1E0c9jL1rEJoNZFvjkRIZycGdbbLI7J6Uy3uEvibAYTKTjNldkyNgHxlHcJy8esnDuG/wU7+vdzfMjdt5TIkOfTGCcnD3+Rigyjst2qNir8fX/89+Hd77+70zCfyr0qYUKHhU+FUXF02awx0oIuRFMBSEvBU2MnKQqYO5wO/Zzgqp/h7Z9ctbiM7XF9bHIiOtVvOzvNKtvygeO4cAO2z0bKSSQYBs4SJY1RiqmjMtt4jY9Lh2D+uifKNI04Z7vsENb1XED7t16BHyq5t5p07HrUw09NkX/jgLiILHXeNBePT+TTTJ2po+AET2J48r+RkgX9G7/41BRvv+Df9wLDl1OpYk/ioGe6BOLr377d/f7RCqLiqWHwR4fIeTGMBWEvBTk8A6zJmpxsmaWvWgiBYnVvKxKxrvNmngF9klXi8/UFvukRAYm8nEsd+391DbHwHbPRgoJJNjGxKIJ5yE1P7ok6CDp1/+e6mO7eE9IXJ8SGbiHwY2VA3yq5l4OBYT+3exd0DrHLiUSFs2P429EhtinPDg/ZqO/xgGb7G+EdOV+qBQboeiTBRUduvlaRUGL8NDlWOqrTypUVOgbrhYWFRfbgUujCCETpoKQl4IcJnZ6RxnXzWMyp8lg3K7+mmwl74S3+Ex+sU8sMvCutwolkwSmmPqe/bHds5FCAgm2yD6p1hheTLFz7vYlYyId7v4rxaVlUTueA90AHifl7t16RBbO/dRPbG8S/MgW5zyIhFXzM/09OwatAxsUHWaPkuPjjosclfthfBtTcRlVqugTDxULOSqXPuXK88AnF4QQB1NByEtA7Bp0TUQxGTV3uMXe5Q3o0idjv8Intsstvwlo0lwjXlpEhgHscRzxU4N9Ai822Q0i42BucCw1QFxPZMRPrPb7bcQeY1IsRHHQJ+DOvWOfTMS1f7ANy+1WzY/26cUFm/h87Zfz6Z9R3bccn+pjI0dHnww8DOP3JS6lqPB5HLjnghCSwVQQ8hJIJVH696jeS1j1jnFKNOxjCSRcjT5x+8E4xN7djtk/KcFxR77HFhl6nCaxdeo8kWHmuwaIa2LI4ROI/TI4SST1JWTB3OvfoT2biIOtJzLMsZXQPr24UbsrrPVPqMff56JjIyfjfsdbO740nL4EYfHGYMdFCCEGU0HItSNj0h8nSPE+CUwi3TvcmlTJeIccl9AEvLX31T5Qb5JLGZNk/O5GjJs0a31sh+2ejYx36sP3EPaAvRmrHM6jHq+btE7xsuMpAXFxbLhkKX7zUrxkytytTyGVc69/Qn0yEZ9iejFWzY/26cWN2vH3HvaC4DVysEdJ40B78tjIWdkM4z6Ip2HFsqpEeR5GMaOi5vXB9k0IIVlMBSHXjpMgaeKvdQq+btRN1iEervFXsq9GLflAvREZEEvvRuObqtzX8EqbyMgmkGAbRIYmqXESjsIqiAycbyPOSoA/igycl3CeFXy61NJ3cu7FCpzkb0msCAtPFFbNj5RFRnxewlurAgfnD/wW/UbIxXA/jMJDhcF2GEXCUwW690PtHyZ/bt4mhKzGVBBy7YhN7nPES6lyb4PCO78h2V7sM7Wl6uNY+D2Gg+OK28B/kY0UEkiwjceKCa6JKTYRdwWV2EQ+Xpbk+oud3xLmjWIwhkVzL2P/+NYoIxImO3wqEjZur5ofsecgnjeMXSJ+a9ai3wghhBCCmApCrhmxy1JqSL0hKU5ocW172EC72GdqS/nE9fGrTjFRPeuTjKgNk18TU6zo0ycMmgDr3OmfGGM+7lz/Yp8OlHDnLNFP1dyLncuwdEyPTdG/o8A4eJuTrJifySZui0UGPiUpEf8+8biyvxFCCCEEMRWEXDNOcqRr0uM71AquU4/3bGBCqP+tSR8uB4rv+rb4xPVx4oyJocbQWNiHe1de2kSGR/FJwtSGd/MDscjA70SUwKcIcVs8V/FyKI2P51nBBN18hDGK1zT3YkVCDu87GM3zIwmRIfa8hDdkITj21AcIs/t2CCGEEMRUEHLNyGFCmNzsm7KTuoQPk8wWn7gNlwBh4oeYRDXyP6nImNq9ZTkHd76lbo4U88pfaN/3L/aJVUp0VdlNtk1zP/nh/g8PtUmdt6b5kbTIwKc8Zl5zdhoH6g0YixBCCIkxFYRcK2KXJ5mPjEW2+DQjfiuRJqbeW6JUmKSStUU+YOM9HdAkD++gh7v1bqI6+Z5cZEw2+MTALK+RV8eFibweV/LDd2AbRAYeQ+4JBfaXm781c+8tbVK0f/MbQDT21AeONzk/khYZOA533FoPduG7Jzi/BoxFCCGExJgKQsgrpiTMJMw5WnxyaCyNifXk+LTOvYyi02wCJ4QQQm4FU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQgghazAVhBBCCCGEELIGU0EIIYQQQggha/j/n2PBXeK2tD4AAAAASUVORK5CYII=';

function montarAreaImpressao(){
    const area=document.getElementById('areaImpressao');
    if(!area) return;

    const hoje=new Date();
    const dataHoje=String(hoje.getDate()).padStart(2,'0')+'/'+
        String(hoje.getMonth()+1).padStart(2,'0')+'/'+hoje.getFullYear();

    const plantonistas=(state.employees?.plantonistas||[]).filter(x=>x.nome && x.nome.trim());
    const vigilantes=(state.employees?.vigilantes||[]).filter(x=>x.nome && x.nome.trim());

    const totalAcolhidos=contarCategoria(()=>true);
    const idadeValida=p=>idadeDaPessoa(p);
    const ehCrianca=p=>idadeValida(p)!==null && idadeValida(p)<12;
    const ehAdolescente=p=>idadeValida(p)!==null && idadeValida(p)>=12 && idadeValida(p)<18;
    const ehIdoso=p=>idadeValida(p)!==null && idadeValida(p)>=60;
    // Crianças, adolescentes e idosos não entram nos totais de gênero
    // Masculino/Feminino. Eles são contabilizados em suas categorias próprias.
    const contarGenero=(genero)=>contarCategoria(p=>
        !ehCrianca(p) && !ehAdolescente(p) && !ehIdoso(p) &&
        normalizarGenero(p.genero)===normalizarGenero(genero)
    );
    const vagasHomem=contarVagasPorTipo('Homem');
    const vagasMulher=contarVagasPorTipo('Mulher');
    const vagasIdoso=contarVagasPorTipo('Idoso');
    const vagasVepema=contarVagasPorTipo('VEPEMA');
    const totalVagas=vagasHomem+vagasMulher+vagasIdoso+contarVagasPorTipo('Trans')+contarVagasPorTipo('Outro');

    let html=`
    <table class="cabecalho">
        <colgroup><col style="width:91.74mm"><col style="width:78.26mm"></colgroup>
        <tr>
            <td class="titulo-institucional">
                PREFEITURA DO MUNICÍPIO DE PORTO VELHO<br>
                Secretaria Municipal de Inclusão e Assistência Social – SEMIAS
            </td>
            <td class="logo-cabecalho"><img src="data:image/png;base64,${LOGO_CABECALHO_BASE64}" alt="Logo" class="logo-cabecalho-img" /></td>
        </tr>
        <tr>
            <td class="data-impressao">Porto Velho-RO, ${dataHoje}</td>
            <td class="logo-cabecalho-vazio"></td>
        </tr>
    </table>

    <table class="equipe">
        <colgroup><col style="width:85mm"><col style="width:35mm"><col style="width:50mm"></colgroup>`;

    plantonistas.forEach(p=>{
        html += `<tr><td>Plantonista: ${escapar(p.nome)}</td><td>${escapar(p.funcao||'')}</td><td>${escapar(p.escala||'')}</td></tr>`;
    });
    vigilantes.forEach(p=>{
        html += `<tr><td>Vigilante: ${escapar(p.nome)}</td><td>${escapar(p.turno||'Dia')} — ${escapar(p.escala||'')}</td><td></td></tr>`;
    });
    const nomesHoje=plantonistas.map(p=>String(p.nome||'').trim()).filter(Boolean).join(', ');
    const nomesOntem=(state.plantonistasAnterior||[]).map(p=>String(p.nome||'').trim()).filter(Boolean).join(', ');
    const textoOntem=nomesOntem
        ? `Às 7h, recebemos o plantão dos servidores: ${escapar(nomesOntem)} com ${totalAcolhidos} acolhidos.`
        : 'Às 7h, recebemos o plantão dos servidores: não informado.';

    html += `</table>
    <table class="informacoes-plantao">
        <colgroup><col style="width:35.97mm"><col style="width:134.03mm"></colgroup>
        <tr class="plantao-hoje">
            <td class="rotulo-plantao">Plantonistas de hoje</td>
            <td class="texto-plantao">${escapar(nomesHoje || 'Não informado')}</td>
        </tr>
        <tr class="plantao-ontem">
            <td class="rotulo-plantao">Plantonistas de ontem</td>
            <td class="texto-plantao">${textoOntem}</td>
        </tr>
        <tr class="codigo-titulo">
            <td colspan="2" class="rotulo-plantao">Código de desligamento</td>
        </tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">01 – Desligamento espontâneo.</td></tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">02 – Pernoitou fora.</td></tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">03 – Fez uso de bebida alcoólica e/ou entorpecentes.</td></tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">04 – Brigou na casa.</td></tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">05 – Causou danos ou destruiu bens da instituição.</td></tr>
        <tr class="codigo-linha"><td colspan="2" class="texto-plantao">06 – Outros motivos.</td></tr>
    </table>`;

    ['feminina','idoso','masculina'].forEach(ala=>{
        const rooms=Object.values(state.rooms)
            .filter(r=>r.ala===ala)
            .sort((a,b)=>a.numero-b.numero);

        html += `<table class="tabela-ala">
            <colgroup>
                <col style="width:16mm">
                <col style="width:57mm">
                <col style="width:19mm">
                <col style="width:19mm">
                <col style="width:19mm">
                <col style="width:17mm">
                <col style="width:23mm">
            </colgroup>
            <tr class="ala-titulo"><td colspan="7">${textoAlaImpressao(ala)}</td></tr>
            <tr class="cabecalho-tabela">
                <td>Quarto</td><td>Nomes</td><td style="text-align:center">Data E</td>
                <td style="text-align:center">Data S</td><td style="text-align:center">Ad.Ver</td>
                <td style="text-align:center">TTP</td><td style="text-align:center">VAGAS</td>
            </tr>`;

        rooms.forEach(room=>{
            const pessoas=(room.pessoas||[]).filter(pessoaOcupada);
            const ocupantesAtivos=pessoas.filter(pessoaAtivaResumo);
            const capacidade=capacidadePadraoRoom(room);
            const total=ocupantesAtivos.length;
            const vagas=Math.max(0,capacidade-total);
            const indisponivel=room.status==='indisponivel';

            if(indisponivel){
                html += `<tr class="linha-dado">
                    <td class="quarto">${descricaoQuartoImpressao(room)}</td>
                    <td class="nome interditado"><strong>INDISPONÍVEL</strong>${String(room.descricao||'').trim() ? `<br><span class="motivo-indisponibilidade">Motivo: ${escapar(String(room.descricao).trim())}</span>` : '<br><span class="motivo-indisponibilidade">Motivo da indisponibilidade não informado</span>'}</td>
                    <td class="data">-</td><td class="data">-</td><td class="adv valor-zero">-</td>
                    <td class="total valor-zero">-</td><td class="vagas valor-zero">ZERO</td>
                </tr>`;
                return;
            }

            const rowspanRoom = pessoas.length > 1 ? ` rowspan="${pessoas.length}"` : '';
            const vagasTexto = vagas===0 ? 'ZERO' : String(vagas);
            const classeVagas = vagas===0 ? ' valor-zero' : ' vagas-disponiveis';

            if(pessoas.length===0){
                const classeDisponivel = vagas>0 ? ' linha-disponivel' : '';
                html += `<tr class="linha-dado${classeDisponivel}">
                    <td class="quarto">${descricaoQuartoImpressao(room)}</td>
                    <td class="nome">-</td><td class="data">-</td><td class="data">-</td>
                    <td class="adv adv-zero">-</td><td class="total">${total}</td>
                    <td class="vagas${classeVagas}">${vagasTexto}</td>
                </tr>`;
                return;
            }

            pessoas.forEach((p,i)=>{
                const idadePessoa=idadeDaPessoa(p);
                const nomeExibicao=escapar(p.nome)+(idadePessoa!==null?` (${idadePessoa} anos)`:'');
                const advertencias=Number.parseInt(p.advertencia,10) || 0;
                const classeAdvertencia = advertencias >= 2 ? ' adv-vermelha' : advertencias === 1 ? ' adv-laranja' : ' adv-zero';
                const classeNomeIdoso = idadePessoa!==null && idadePessoa>=60 ? ' destaque-idoso' : '';
                const tipoQuartoPessoa = normalizarGenero(room.tipoQuarto||tipoQuartoPadrao(room.ala));
                const classeIdoso = (idadePessoa!==null && idadePessoa>=60) ? ' linha-idoso' : '';
                const temSaida=String(p.saida||'').trim();
                const classeDisponivel = vagas>0 ? ' linha-disponivel' : '';
                const classeSaida = temSaida ? ' linha-saida' : '';
                const classeAcessibilidade = p.acessibilidade===true ? ' linha-acessibilidade' : '';
                html += `<tr class="linha-dado${classeIdoso}${classeSaida}${classeAcessibilidade}${classeDisponivel}">
                    ${i===0 ? `<td class="quarto"${rowspanRoom}>${descricaoQuartoImpressao(room)}</td>` : ''}
                    <td class="nome${classeNomeIdoso}">${nomeExibicao || '-'}</td>
                    <td class="data${classeNomeIdoso}" style="text-align:center">${formatarDataImpressao(p.entrada) || '-'}</td>
                    <td class="data${classeNomeIdoso}" style="text-align:center">${formatarDataImpressao(p.saida) || '-'}</td>
                    <td class="adv${classeAdvertencia}">${advertencias ? advertencias : '-'}</td>
                    ${i===0 ? `<td class="total" rowspan="${pessoas.length}" style="text-align:center">${total}</td>` : ''}
                    ${i===0 ? `<td class="vagas${classeVagas}" rowspan="${pessoas.length}" style="text-align:center">${vagasTexto}</td>` : ''}
                </tr>`;
            });
        });
        html += `</table>`;
    });

    html += `<div class="resumo-wrap">
      <table class="resumo resumo-unificado">
        <colgroup>
          <col style="width:67mm"><col style="width:18mm">
          <col style="width:67mm"><col style="width:18mm">
        </colgroup>
        <tr>
          <td>Mulheres acolhidas</td><td class="valor">${contarGenero('feminino')}</td>
          <td>Homens acolhidos</td><td class="valor">${contarGenero('masculino')}</td>
        </tr>
        <tr>
          <td>Crianças acolhidas</td><td class="valor">${contarCategoria(ehCrianca)}</td>
          <td>Adolescentes acolhidos</td><td class="valor">${contarCategoria(ehAdolescente)}</td>
        </tr>
        <tr>
          <td>Idosos acolhidos</td><td class="valor">${contarCategoria(p=>ehIdoso(p))}</td>
          <td>Transexuais acolhidos</td><td class="valor">${contarCategoria(p=>!ehIdoso(p) && ['trans','transexual'].includes(normalizarGenero(p.genero)))}</td>
        </tr>
        <tr>
          <td>VEPEMA</td><td class="valor vepema">${contarCategoria((p,room)=>normalizarGenero(room.tipoQuarto)==='vepema')}</td>
          <td>Total de vagas disponíveis</td><td class="valor">${totalVagas}</td>
        </tr>
        <tr class="total-resumo">
          <td colspan="3">TOTAL DE PESSOAS NA UNIDADE</td><td class="valor">${totalAcolhidos}</td>
        </tr>
        <tr><td class="resumo-titulo" colspan="4">VAGAS DISPONÍVEIS POR DESTINAÇÃO</td></tr>
        <tr>
          <td>Homem</td><td class="valor vagas-detalhe">${vagasHomem}</td>
          <td>Mulher</td><td class="valor vagas-detalhe">${vagasMulher}</td>
        </tr>
        <tr>
          <td>Idoso</td><td class="valor vagas-detalhe">${vagasIdoso}</td>
          <td>VEPEMA</td><td class="valor vagas-detalhe">${vagasVepema}</td>
        </tr>
      </table>
    </div>`;
    area.innerHTML=html;
}

function imprimirRelacao(){
    montarAreaImpressao();
    document.getElementById('areaImpressao').setAttribute('aria-hidden','false');
    window.print();
    setTimeout(()=>document.getElementById('areaImpressao').setAttribute('aria-hidden','true'),500);
}

/* ============================================================
   EXPORTAÇÃO ODT OFFLINE — Conversor XML/ZIP
   ============================================================ */
function xmlEscapeODT(value){
    return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function textoInlineODT(node){
    if(node.nodeType===Node.TEXT_NODE) return xmlEscapeODT(node.nodeValue);
    if(node.nodeType!==Node.ELEMENT_NODE) return '';
    const tag=node.tagName.toLowerCase();
    const conteudo=Array.from(node.childNodes).map(textoInlineODT).join('');
    if(tag==='br') return '<text:line-break/>';
    if(tag==='strong'||tag==='b') return '<text:span text:style-name="Negrito">'+conteudo+'</text:span>';
    if(tag==='em'||tag==='i') return '<text:span text:style-name="Italico">'+conteudo+'</text:span>';
    return conteudo;
}
function estiloCelulaODT(td,tr){
    const cls=String(td.className||'').split(/\s+/);
    const rowCls=String(tr.className||'').split(/\s+/);
    const tableCls=String(tr.closest('table')?.className||'').split(/\s+/);
    if(cls.includes('titulo-institucional')) return 'CelulaCabecalhoInstitucional';
    if(cls.includes('data-impressao')) return 'CelulaCabecalhoData';
    if(cls.includes('logo-cabecalho') || cls.includes('logo-cabecalho-vazio')) return 'CelulaCabecalhoLogo';
    if(tableCls.includes('equipe')) return 'CelulaEquipe';
    if(tableCls.includes('informacoes-plantao')){
        if(rowCls.includes('plantao-hoje') && cls.includes('rotulo-plantao')) return 'CelulaInfoPlantaoHoje';
        if(rowCls.includes('plantao-ontem') && cls.includes('rotulo-plantao')) return 'CelulaInfoPlantaoOntem';
        if(rowCls.includes('codigo-titulo')) return 'CelulaInfoPlantaoCodigoTitulo';
        if(rowCls.includes('codigo-linha')) return 'CelulaInfoPlantaoCodigo';
        return cls.includes('rotulo-plantao') ? 'CelulaInfoPlantaoRotulo' : 'CelulaInfoPlantao';
    }
    if(tableCls.includes('legenda-impressao')) return 'CelulaLegenda';
    if(rowCls.includes('ala-titulo')) return 'CelulaAla';
    if(rowCls.includes('cabecalho-tabela')) return 'CelulaCabecalho';
    // A saída continua tendo prioridade nas células de identificação/data.
    if(rowCls.includes('linha-saida') && (cls.includes('nome') || cls.includes('data'))) return 'CelulaSaida';

    // Amarelo de idoso/acessibilidade somente nas células da pessoa:
    // Quarto, Nome e Datas. Advertência e VAGAS mantêm suas próprias cores.
    const destacarPessoa = rowCls.includes('linha-idoso') || rowCls.includes('linha-acessibilidade');
    if(destacarPessoa && (cls.includes('quarto') || cls.includes('nome') || cls.includes('data'))) {
        return rowCls.includes('linha-acessibilidade') ? 'CelulaAcessibilidade' : 'CelulaIdoso';
    }

    if(cls.includes('adv-vermelha')) return 'CelulaAdvertenciaVermelha';
    if(cls.includes('adv-laranja')) return 'CelulaAdvertenciaLaranja';
    if(cls.includes('adv-zero')) return 'CelulaAdvertenciaZero';
    if(cls.includes('valor-zero')) return 'CelulaZero';
    if(cls.includes('vagas-disponiveis')) return 'CelulaVagasDisponivel';
    if(rowCls.includes('linha-disponivel')) return 'CelulaQuartoDisponivel';
    if(cls.includes('interditado')) return 'CelulaIndisponivel';
    if(cls.includes('quarto')) return 'CelulaQuarto';
    if(cls.includes('vagas')) return 'CelulaVagas';
    if(cls.includes('resumo-titulo')) return 'CelulaResumoTitulo';
    if(cls.includes('total-resumo') || rowCls.includes('total-resumo')) return 'CelulaResumoTotal';
    if(cls.includes('resumo') || cls.includes('valor') || cls.includes('rotulo-vagas') || cls.includes('vagas-detalhe')) return 'CelulaResumo';
    if(cls.includes('nome')) return 'CelulaNome';
    return 'Celula';
}
function textoCelulaODT(node){
    if(node.nodeType===Node.TEXT_NODE) return xmlEscapeODT(node.nodeValue);
    if(node.nodeType!==Node.ELEMENT_NODE) return '';
    const tag=node.tagName.toLowerCase();
    if(tag==='img' && node.classList.contains('logo-cabecalho-img')){
        return '<draw:frame draw:style-name="LogoCabecalho" draw:name="LogoCabecalho" text:anchor-type="char" svg:width="7.632cm" svg:height="1.713cm"><draw:image xlink:href="Pictures/logo-cabecalho.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/png"/></draw:frame>';
    }
    if(tag==='br') return '<text:line-break/>';
    const conteudo=Array.from(node.childNodes).map(textoCelulaODT).join('');
    const classes=String(node.getAttribute('class')||'').split(/\s+/);
    if(classes.includes('numero-quarto')) return '<text:span text:style-name="NumeroQuartoODT">'+conteudo+'</text:span>';
    if(tag==='strong'||tag==='b') return '<text:span text:style-name="Negrito">'+conteudo+'</text:span>';
    if(tag==='em'||tag==='i') return '<text:span text:style-name="Italico">'+conteudo+'</text:span>';
    if(tag==='u') return '<text:span text:style-name="Sublinhado">'+conteudo+'</text:span>';
    return conteudo;
}
function larguraColunaODT(col, totalMm){
    const raw=String(col.getAttribute('style')||'').match(/width\s*:\s*([\d.]+)\s*(mm|cm|in|%)/i);
    if(!raw) return null;
    const val=parseFloat(raw[1]), unit=raw[2].toLowerCase();
    let mm=unit==='mm'?val:unit==='cm'?val*10:unit==='in'?val*25.4:unit==='%'?totalMm*val/100:null;
    return mm && Number.isFinite(mm) ? (mm/10).toFixed(3)+'cm' : null;
}
let contadorTabelasODT = 0;
function blocoODT(node){
    if(node.nodeType!==Node.ELEMENT_NODE) return '';
    const tag=node.tagName.toLowerCase();
    if(tag==='table'){
        let rows='';
        const trs=Array.from(node.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr, :scope > tfoot > tr'));
        const colgroup=node.querySelector(':scope > colgroup');
        const cols=colgroup ? Array.from(colgroup.children).filter(c=>c.tagName.toLowerCase()==='col') : [];
        const colWidths=cols.map(c=>larguraColunaODT(c,170));
        const isCabecalho=node.classList.contains('cabecalho');
        const isInfoPlantao=node.classList.contains('informacoes-plantao');
        const colCount=Math.max(1,...trs.map(tr=>Array.from(tr.children).filter(c=>/^(TD|TH)$/.test(c.tagName)).reduce((n,c)=>n+Number(c.getAttribute('colspan')||1),0)));
        const columns=Array.from({length:colCount},(_,i)=>{
            if(isInfoPlantao && i===0) return '<table:table-column table:style-name="ColInfoPlantaoA"/>';
            if(isInfoPlantao && i===1) return '<table:table-column table:style-name="ColInfoPlantaoB"/>';
            return '<table:table-column'+(colWidths[i]?' table:style-name="Col'+colCount+'_'+i+'"':'')+'/>';
        }).join('');
        const activeSpans=Array(colCount).fill(0);
        trs.forEach(tr=>{
            const rowCls = String(tr.getAttribute('class') || '');
            let cells='';
            let cursor=0;
            const tds=Array.from(tr.children).filter(c=>/^(TD|TH)$/.test(c.tagName));
            for(const td of tds){
                while(cursor<colCount && activeSpans[cursor]>0){
                    cells+='<table:covered-table-cell/>';
                    activeSpans[cursor]--;
                    cursor++;
                }
                const content=Array.from(td.childNodes).map(textoCelulaODT).join('');
                const span=Math.max(1,Number(td.getAttribute('colspan')||1));
                const rowspan=Math.max(1,Number(td.getAttribute('rowspan')||1));
                const spanAttr=span>1?` table:number-columns-spanned="${span}"`:'';
                const rowSpanAttr=rowspan>1?` table:number-rows-spanned="${rowspan}"`:'';
                const style=estiloCelulaODT(td,tr);
                const align=(td.style.textAlign||'').toLowerCase();
                const pStyle = rowCls.includes('linha-disponivel') || align==='center' ? 'ParagrafoCentro' : align==='right' ? 'ParagrafoDireita' : 'Paragrafo';
                const conteudoFinal = content.trim() ? content : '-';
                cells+=`<table:table-cell table:style-name="${style}"${spanAttr}${rowSpanAttr}><text:p text:style-name="${pStyle}">${conteudoFinal}</text:p></table:table-cell>`;
                if(span>1) cells+='<table:covered-table-cell/>'.repeat(span-1);
                if(rowspan>1){
                    for(let k=0;k<span;k++) activeSpans[cursor+k]=rowspan-1;
                }
                cursor+=span;
            }
            while(cursor<colCount){
                if(activeSpans[cursor]>0){
                    cells+='<table:covered-table-cell/>';
                    activeSpans[cursor]--;
                }else{
                    cells+='<table:table-cell><text:p text:style-name="Paragrafo">-</text:p></table:table-cell>';
                }
                cursor++;
            }
            rows+='<table:table-row table:style-name="RowAutoHeight">'+cells+'</table:table-row>';
        });
        const nomeTabela = 'TabelaODT_' + (++contadorTabelasODT);
        return '<table:table table:name="'+nomeTabela+'" table:style-name="Tabela">'+columns+rows+'</table:table>';
    }
    if(tag==='br') return '<text:p/>';
    const children=Array.from(node.childNodes);
    const hasBlock=children.some(ch=>ch.nodeType===Node.ELEMENT_NODE && /^(TABLE|DIV|P|H[1-6]|SECTION|HEADER|FOOTER)$/.test(ch.tagName));
    const inner=children.map(ch=>{
        if(ch.nodeType===Node.ELEMENT_NODE && /^(TABLE|DIV|P|H[1-6]|SECTION|HEADER|FOOTER)$/.test(ch.tagName)) return blocoODT(ch);
        return textoInlineODT(ch);
    }).join('');
    if(/^H[1-6]$/.test(node.tagName)) return '<text:h text:outline-level="2">'+inner+'</text:h>';
    if(tag==='div'||tag==='section'||tag==='header'||tag==='footer') return hasBlock ? inner : (inner.trim()?'<text:p>'+inner+'</text:p>':'');
    if(tag==='p') return inner.trim()?'<text:p>'+inner+'</text:p>':'';
    return inner;
}
function crc32ODT(bytes){
    let c=-1;
    for(let i=0;i<bytes.length;i++){c^=bytes[i];for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xEDB88320:0);}
    return (c^(-1))>>>0;
}
function zipODT(files){
    const enc=new TextEncoder(); const local=[], central=[]; let offset=0;
    const u16=n=>[n&255,(n>>>8)&255]; const u32=n=>[n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255];
    for(const file of files){
        const name=enc.encode(file.name), data=typeof file.data==='string'?enc.encode(file.data):file.data;
        const crc=crc32ODT(data), size=data.length;
        const head=new Uint8Array([...u32(0x04034b50),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(name.length),...u16(0),...name]);
        local.push(head,data);
        const ch=new Uint8Array([...u32(0x02014b50),...u16(20),...u16(20),...u16(0x0800),...u16(0),...u16(0),...u16(0),...u32(crc),...u32(size),...u32(size),...u16(name.length),...u16(0),...u16(0),...u16(0),...u16(0),...u32(0),...u32(offset),...name]);
        central.push(ch); offset+=head.length+size;
    }
    const centralSize=central.reduce((a,b)=>a+b.length,0), count=files.length;
    const end=new Uint8Array([...u32(0x06054b50),...u16(0),...u16(0),...u16(count),...u16(count),...u32(centralSize),...u32(offset),...u16(0)]);
    const all=[...local,...central,end], total=all.reduce((a,b)=>a+b.length,0), out=new Uint8Array(total); let pos=0;
    all.forEach(a=>{out.set(a,pos);pos+=a.length;}); return out;
}

/* Pastas independentes para os dois relatórios ODT. As permissões são
   gerenciadas pelo navegador e os handles ficam no IndexedDB local. */
const PASTA_ODT_PLANILHA='pasta_odt_planilha_v1';
const PASTA_ODT_NOMES='pasta_odt_relacao_nomes_v1';
async function obterPastaODT(tipo){
  return lerDadosArquivoStore(ARCHIVE_FOLDER_STORE,tipo==='planilha'?PASTA_ODT_PLANILHA:PASTA_ODT_NOMES);
}
async function atualizarTextoPastasODT(){
  const aviso=document.getElementById('pastaODTInfo');
  function mostrarPasta(tipo,handle){
    const id=tipo==='planilha'?'Planilha':'Nomes';
    const icone=document.getElementById('iconePastaODT'+id);
    const nome=document.getElementById('nomePastaODT'+id);
    const botao=document.getElementById('btnPastaODT'+id);
    const selecionada=Boolean(handle&&handle.name);
    if(icone)icone.textContent=selecionada?'🗂️':'📂';
    if(nome){nome.textContent=selecionada?handle.name:'Pasta não selecionada';nome.title=selecionada?'Pasta selecionada: '+handle.name:'Nenhuma pasta definida';nome.classList.toggle('configurada',selecionada);}
    if(botao){botao.title=selecionada?'Pasta selecionada: '+handle.name+' — clique para alterar':'Escolher a pasta padrão';botao.classList.toggle('pasta-configurada',selecionada);}
  }
  try{
    const [a,b]=await Promise.all([obterPastaODT('planilha'),obterPastaODT('nomes')]);
    mostrarPasta('planilha',a);mostrarPasta('nomes',b);
    if(aviso){aviso.hidden=true;aviso.textContent='';}
  }catch(e){
    mostrarPasta('planilha',null);mostrarPasta('nomes',null);
    if(aviso){aviso.textContent='Não foi possível consultar as pastas salvas neste navegador.';aviso.hidden=false;}
  }
}
async function escolherPastaODT(tipo){
  if(typeof window.showDirectoryPicker!=='function'||!window.isSecureContext){
    alert('A seleção de pasta padrão não é suportada neste navegador ou contexto. O relatório continuará disponível para download normal. Em Chrome ou Edge, use um contexto compatível (HTTPS ou localhost).');
    return;
  }
  try{
    const handle=await window.showDirectoryPicker({mode:'readwrite'});
    await gravarDadosArquivoStore(ARCHIVE_FOLDER_STORE,tipo==='planilha'?PASTA_ODT_PLANILHA:PASTA_ODT_NOMES,handle);
    await atualizarTextoPastasODT();
    setStatus('✓ Pasta padrão da '+(tipo==='planilha'?'Planilha':'Relação de Nomes')+': '+handle.name);
  }catch(e){if(e?.name!=='AbortError')setStatus('Não foi possível definir pasta ODT: '+(e?.message||e),true);}
}
async function salvarNaPastaODT(blob,nome,tipo){
  let pasta;
  try{pasta=await obterPastaODT(tipo);}catch(e){return false;}
  if(!pasta)return false;
  try{
    let permissao=await pasta.queryPermission({mode:'readwrite'});
    if(permissao!=='granted' && typeof pasta.requestPermission==='function')permissao=await pasta.requestPermission({mode:'readwrite'});
    if(permissao!=='granted')return false;
    const arquivo=await pasta.getFileHandle(nome,{create:true});
    const writer=await arquivo.createWritable();
    await writer.write(blob);
    await writer.close();
    setStatus('✓ '+(tipo==='planilha'?'Planilha':'Relação de Nomes')+' salva na pasta '+pasta.name+'.');
    window.confirmarArquivoGerado?.(tipo==='planilha'?'Planilha':'Lista',nome,pasta);
    return true;
  }catch(e){
    setStatus('⚠ Não foi possível salvar na pasta padrão. Será aberto o download normal: '+(e?.message||e),true);
    return false;
  }
}

async function baixarODT(){
    montarAreaImpressao();
    const alvo=document.getElementById('areaImpressao');
    if(!alvo || !alvo.innerHTML.trim()){ alert('Não foi possível montar a área de impressão. Confira se há dados carregados no sistema.'); return; }
    const body=Array.from(alvo.children).map(blocoODT).join('');
    
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" 
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" 
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" 
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" 
  xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" 
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.2">
  <office:automatic-styles><style:style style:name="RowAutoHeight" style:family="table-row"><style:table-row-properties style:use-optimal-row-height="true"/></style:style>
    <style:style style:name="Tabela" style:family="table">
      <style:table-cell-properties style:width="17cm" table:align="margins" fo:margin-bottom="0.12cm"/>
    </style:style>
    
    <style:style style:name="ColCabecalhoA" style:family="table-column"><style:table-column-properties style:column-width="9.174cm"/></style:style>
    <style:style style:name="ColCabecalhoB" style:family="table-column"><style:table-column-properties style:column-width="7.826cm"/></style:style>
    <style:style style:name="CabecalhoTabela" style:family="table">
      <style:table-cell-properties style:width="17cm" table:align="margins" fo:margin-bottom="0.12cm"/>
    </style:style>
    <style:style style:name="CelulaCabecalhoInstitucional" style:family="table-cell">
      <style:table-cell-properties style:vertical-align="middle" fo:background-color="#ffffff" fo:padding="0.079cm" fo:border-left="0.5pt solid #000000" fo:border-right="none" fo:border-top="none" fo:border-bottom="none"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaCabecalhoData" style:family="table-cell">
      <style:table-cell-properties style:vertical-align="middle" fo:background-color="#ffffff" fo:padding="0.079cm" fo:border-left="0.5pt solid #000000" fo:border-right="none" fo:border-top="none" fo:border-bottom="none"/>
      <style:text-properties fo:color="#000000" fo:font-size="12pt"/>
    </style:style>
    <style:style style:name="CelulaCabecalhoLogo" style:family="table-cell">
      <style:table-cell-properties style:vertical-align="middle" fo:background-color="#ffffff" fo:padding="0.079cm" fo:border="0.5pt solid #000000"/>
    </style:style>
    <style:style style:name="LogoCabecalho" style:family="graphic">
      <style:graphic-properties style:vertical-rel="paragraph" style:wrap="none" style:horizontal-pos="center" style:horizontal-rel="paragraph" style:mirror="none" fo:clip="rect(0cm, 0cm, 0cm, 0cm)"/>
    </style:style>
    <style:style style:name="Celula" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#ffffff" style:vertical-align="middle"/>
    </style:style>
    <style:style style:name="CelulaInstitucional" style:family="table-cell">
      <style:table-cell-properties fo:border="none" fo:padding="0.08cm" fo:background-color="#ffffff" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="12pt"/>
    </style:style>
    <style:style style:name="CelulaData" style:family="table-cell">
      <style:table-cell-properties fo:border="none" fo:padding="0.08cm" fo:background-color="#ffffff" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaEquipe" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#eaf3fb" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="ColInfoPlantaoA" style:family="table-column">
      <style:table-column-properties style:column-width="3.597cm" style:rel-column-width="2040*"/>
    </style:style>
    <style:style style:name="ColInfoPlantaoB" style:family="table-column">
      <style:table-column-properties style:column-width="13.403cm" style:rel-column-width="7605*"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantaoRotulo" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#B4C7DC" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantaoHoje" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#B4C7DC" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantaoOntem" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#FFB66C" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantaoCodigoTitulo" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#F6F9D4" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantaoCodigo" style:family="table-cell">
      <style:table-cell-properties fo:border-left="0.5pt solid #000000" fo:border-right="0.5pt solid #000000" fo:border-top="none" fo:border-bottom="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#F6F9D4" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt"/>
    </style:style>
    <style:style style:name="CelulaInfoPlantao" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.101cm" fo:background-color="#ffffff" style:vertical-align="top"/>
      <style:text-properties fo:color="#000000" fo:font-size="10pt"/>
    </style:style>
    <style:style style:name="CelulaLegenda" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#fff9df" style:vertical-align="middle"/>
      <style:paragraph-properties fo:text-align="center"/><style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaAla" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.10cm" fo:background-color="#c8e6fe" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="13pt"/>
    </style:style>
    <style:style style:name="CelulaCabecalho" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.10cm" fo:background-color="#c8e6fe" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="9.5pt"/>
    </style:style>
    <style:style style:name="CelulaSaida" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#ff6d6d" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaIndisponivel" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#fdebed" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaQuartoDisponivel" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#E1F9E1" style:vertical-align="middle"/>
      <style:text-properties fo:font-weight="bold" fo:font-size="9pt" fo:color="#000000"/>
    </style:style>
    <style:style style:name="CelulaAdvertenciaLaranja" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#FFBF00" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaAdvertenciaVermelha" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#FF8000" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaZero" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#FFFFFF" style:vertical-align="middle"/>
      <style:paragraph-properties fo:text-align="center"/><style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="12pt"/>
    </style:style>

    <style:style style:name="CelulaAdvertenciaZero" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#E1F9E1" style:vertical-align="middle"/><style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="9pt"/></style:style>
    <style:style style:name="CelulaVagasDisponivel" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#E1F9E1" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="12pt"/></style:style>
    <style:style style:name="CelulaDisponivel" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#E1F9E1" style:vertical-align="middle"/><style:text-properties fo:color="#000000" fo:font-size="9pt"/></style:style>
    <style:style style:name="CelulaQuarto" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#f1f7fc" style:vertical-align="middle"/>
      <style:text-properties fo:font-weight="bold" fo:font-size="9pt" fo:color="#000000"/>
    </style:style>
    <style:style style:name="CelulaVagas" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#f1f7fc" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-weight="bold" fo:font-size="9.5pt"/>
    </style:style>
    <style:style style:name="CelulaNome" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#ffffff" style:vertical-align="middle"/>
    </style:style>
    <style:style style:name="CelulaIdoso" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#FFE994" style:vertical-align="middle"/>
    </style:style>
    <style:style style:name="CelulaAcessibilidade" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#FFF2A8" style:vertical-align="middle"/>
      <style:text-properties fo:color="#000000" fo:font-size="9pt"/>
    </style:style>
    <style:style style:name="CelulaResumo" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#eaf3fb" style:vertical-align="middle"/>
      <style:text-properties fo:font-size="10pt"/>
    </style:style>
    <style:style style:name="CelulaResumoTitulo" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#dceaf5" style:vertical-align="middle"/>
      <style:text-properties fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>
    <style:style style:name="CelulaResumoTotal" style:family="table-cell">
      <style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.08cm" fo:background-color="#f2f7d2" style:vertical-align="middle"/>
      <style:text-properties fo:font-size="10pt" fo:font-weight="bold"/>
    </style:style>

    <style:style style:name="Paragrafo" style:family="paragraph">
      <style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:line-height="100%"/>
      <style:text-properties style:font-name="Arial" fo:font-size="9pt" fo:color="#000000"/>
    </style:style>
    <style:style style:name="ParagrafoCentro" style:family="paragraph">
      <style:paragraph-properties fo:text-align="center" fo:margin-top="0cm" fo:margin-bottom="0cm"/>
      <style:text-properties style:font-name="Arial" fo:font-size="9pt" fo:color="#000000"/>
    </style:style>
    <style:style style:name="ParagrafoDireita" style:family="paragraph">
      <style:paragraph-properties fo:text-align="end" fo:margin-top="0cm" fo:margin-bottom="0cm"/>
      <style:text-properties style:font-name="Arial" fo:font-size="9pt" fo:color="#000000"/>
    </style:style>
    
    <style:style style:name="Negrito" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="Italico" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="Sublinhado" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-type="single"/></style:style>
    <style:style style:name="NumeroQuartoODT" style:family="text"><style:text-properties style:font-name="Arial" fo:font-size="20pt" fo:font-weight="bold"/></style:style>
    
    <style:style style:name="Col7_0" style:family="table-column"><style:table-column-properties style:column-width="1.79cm"/></style:style>
    <style:style style:name="Col7_1" style:family="table-column"><style:table-column-properties style:column-width="8.58cm"/></style:style>
    <style:style style:name="Col7_2" style:family="table-column"><style:table-column-properties style:column-width="1.80cm"/></style:style>
    <style:style style:name="Col7_3" style:family="table-column"><style:table-column-properties style:column-width="1.72cm"/></style:style>
    <style:style style:name="Col7_4" style:family="table-column"><style:table-column-properties style:column-width="1.91cm"/></style:style>
    <style:style style:name="Col7_5" style:family="table-column"><style:table-column-properties style:column-width="1.32cm"/></style:style>
    <style:style style:name="Col7_6" style:family="table-column"><style:table-column-properties style:column-width="1.88cm"/></style:style>
    
    <style:style style:name="Col4_0" style:family="table-column"><style:table-column-properties style:column-width="6.7cm"/></style:style>
    <style:style style:name="Col4_1" style:family="table-column"><style:table-column-properties style:column-width="1.8cm"/></style:style>
    <style:style style:name="Col4_2" style:family="table-column"><style:table-column-properties style:column-width="6.7cm"/></style:style>
    <style:style style:name="Col4_3" style:family="table-column"><style:table-column-properties style:column-width="1.8cm"/></style:style>
  </office:automatic-styles>
  <office:body>
    <office:text>${body}</office:text>
  </office:body>
</office:document-content>`;

    const styles = '<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2"><office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.08cm"/><style:text-properties style:font-name="Arial" fo:font-size="9pt" fo:color="#000000"/></style:default-style></office:styles><office:automatic-styles><style:page-layout style:name="A4"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait" fo:margin-top="1cm" fo:margin-bottom="0.8cm" fo:margin-left="1cm" fo:margin-right="1cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="A4"/></office:master-styles></office:document-styles>';
    
    const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="Pictures/logo-cabecalho.png" manifest:media-type="image/png"/></manifest:manifest>';
    
    const bytes = zipODT([
      {name:'mimetype', data:'application/vnd.oasis.opendocument.text'},
      {name:'content.xml', data:content},
      {name:'styles.xml', data:styles},
      {name:'Pictures/logo-cabecalho.png', data:Uint8Array.from(atob(LOGO_CABECALHO_BASE64), c=>c.charCodeAt(0))},
      {name:'META-INF/manifest.xml', data:manifest}
    ]);
    
    const blob = new Blob([bytes], {type:'application/vnd.oasis.opendocument.text'});
    // O ODT usa exatamente a mesma composição de nome do backup JSON,
    // alterando somente a extensão para .odt.
    const nomeJson = nomeArquivoBackup();
    if(!nomeJson) return;
    const nome = nomeJson.replace(/\.json$/i, '.odt');
    
    try {
        if(await salvarNaPastaODT(blob,nome,'planilha'))return;
        if(window.showSaveFilePicker){
          const handle = await window.showSaveFilePicker({
            suggestedName: nome,
            types: [{
              description: 'Documento OpenDocument',
              accept: {'application/vnd.oasis.opendocument.text': ['.odt']}
            }]
          });
          const w = await handle.createWritable();
          await w.write(blob);
          await w.close();
          setStatus('✓ Arquivo ODT salvo.');
          window.confirmarArquivoGerado?.('Planilha',nome,null);
        } else {
          const url = URL.createObjectURL(blob), a = document.createElement('a');
          a.href = url; a.download = nome;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
          setStatus('✓ Arquivo ODT gerado. Escolha a pasta na janela de download do navegador.');
          window.confirmarArquivoGerado?.('Planilha',nome,null);
        }
    } catch(e) {
      if(e.name !== 'AbortError') { alert('Não foi possível salvar o ODT: ' + e.message); }
    }
}


/* ============================================================
   ODT — RELAÇÃO DE NOMES / CONTROLE DIÁRIO DE ENTRADAS E SAÍDAS
   Baseado no modelo "Modelo Relação de Entrada e Saída.odt".
   Apenas NOME e IDADE são preenchidos automaticamente.
   Os campos de saída/entrada/destino permanecem em branco para
   preenchimento durante o controle diário.
   ============================================================ */
const CHAVE_RELACAO_OPCOES='relacao_nomes_opcoes_v1';
let relacaoOpcoes={idade:false,entradaSaida:false,quantidade:2,celulas:{}};
try{const o=JSON.parse(localStorage.getItem(CHAVE_RELACAO_OPCOES)||'null');if(o&&typeof o==='object')relacaoOpcoes={...relacaoOpcoes,...o,celulas:o.celulas&&typeof o.celulas==='object'?o.celulas:{}};}catch(e){}
function relacaoSalvarOpcoes(){try{localStorage.setItem(CHAVE_RELACAO_OPCOES,JSON.stringify(relacaoOpcoes));}catch(e){console.warn('Não foi possível salvar preferências da relação.',e);}}
function relacaoQtd(){return Math.max(1,Math.min(8,Math.floor(Number(relacaoOpcoes.quantidade)||2)));}
function relacaoChavePessoa(p){return String(p.id||'') || [String(p.nome||'').trim().toLowerCase(),String(p.nascimento||''),String(p.entrada||'')].join('|');}
function relacaoPessoas(){return obterPessoasControleEntradaSaida().map(({room,p})=>({id:relacaoChavePessoa(p),nome:String(p.nome||'').trim(),quarto:String(room.numero??'').trim(),idade:idadeDaPessoa(p)}));}
function relacaoLerCelula(id,col){return String(relacaoOpcoes.celulas[id]?.[col]||'');}
function relacaoDesenharTabela(){
 const el=document.getElementById('relacaoTabelaPreview');if(!el)return;
 const t=document.createElement('table');const head=document.createElement('thead'),body=document.createElement('tbody');
 t.className=relacaoOpcoes.entradaSaida?'relacao-com-horarios':'relacao-sem-horarios';
 const titulos=['Nº','Nome','Apt'];
 if(relacaoOpcoes.entradaSaida)for(let i=0;i<relacaoQtd();i++)titulos.push('Entrada '+(i+1),'Saída '+(i+1));
 titulos.push('Observações');
 const trh=document.createElement('tr');
 titulos.forEach((h,idx)=>{const th=document.createElement('th');th.textContent=h;if(idx===0)th.className='relacao-col-numero';else if(h==='Nome')th.className='relacao-nome';else if(h==='Apt')th.className='relacao-col-apt';else if(h==='Observações')th.className='relacao-col-observacao';else th.className='relacao-col-horario';trh.append(th)});
 head.append(trh);
 const pessoas=state?.rooms?relacaoPessoas():[];
 pessoas.forEach((p,index)=>{
  const tr=document.createElement('tr');
  function texto(s,classe){const td=document.createElement('td');td.textContent=s;if(classe)td.className=classe;tr.append(td)}
  texto(String(index+1).padStart(2,'0'),'relacao-col-numero');
  texto(p.nome+(relacaoOpcoes.idade&&p.idade!==null?' • '+p.idade+' '+(p.idade===1?'ano':'anos'):''),'relacao-nome');
  texto(p.quarto,'relacao-col-apt');
  const cols=[];if(relacaoOpcoes.entradaSaida)for(let i=0;i<relacaoQtd();i++)cols.push('e'+i,'s'+i);cols.push('obs');
  cols.forEach(col=>{const td=document.createElement('td'),input=document.createElement('input');input.type='text';input.value=relacaoLerCelula(p.id,col);input.setAttribute('aria-label',col==='obs'?'Observações de '+p.nome:col+' de '+p.nome);td.className=col==='obs'?'relacao-col-observacao':'relacao-col-horario';input.addEventListener('input',()=>{if(!relacaoOpcoes.celulas[p.id])relacaoOpcoes.celulas[p.id]={};relacaoOpcoes.celulas[p.id][col]=input.value;relacaoSalvarOpcoes()});td.append(input);tr.append(td)});
  body.append(tr);
 });
 if(!pessoas.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=titulos.length;td.textContent='Nenhum acolhido ativo encontrado.';tr.append(td);body.append(tr)}
 t.append(head,body);el.replaceChildren(t);
}
function relacaoConfigurarInicializar(){
 const painel=document.getElementById('painelConfiguracaoRelacao');if(!painel)return;
 const idade=document.getElementById('relacaoMostrarIdade'),es=document.getElementById('relacaoEntradaSaida'),quant=document.getElementById('relacaoQuantidade'),wrap=document.getElementById('relacaoQuantidadeWrap');
 const sincronizar=()=>{idade.checked=!!relacaoOpcoes.idade;es.checked=!!relacaoOpcoes.entradaSaida;quant.value=relacaoQtd();wrap.hidden=!es.checked;relacaoDesenharTabela()};
 idade.addEventListener('change',()=>{relacaoOpcoes.idade=idade.checked;relacaoSalvarOpcoes();sincronizar()});
 es.addEventListener('change',()=>{relacaoOpcoes.entradaSaida=es.checked;relacaoSalvarOpcoes();sincronizar()});
 quant.addEventListener('change',()=>{relacaoOpcoes.quantidade=Math.max(1,Math.min(8,Math.floor(Number(quant.value)||2)));relacaoSalvarOpcoes();sincronizar()});
 document.getElementById('btnConfigurarRelacao')?.addEventListener('click',()=>{painel.hidden=false;sincronizar();document.querySelector('[data-abd-nav="arquivos"]')?.click();painel.scrollIntoView({block:'start'})});
 const fecharConfiguracao=document.getElementById('fecharConfiguracaoRelacao');
 const controles=document.getElementById('relacaoOpcoesPainel');
 const ajuda=document.getElementById('relacaoOpcoesAjuda');
 // Fechar recolhe todo o painel (inclusive a tabela); reabrir usa o botão Configurar relação.
 fecharConfiguracao?.addEventListener('click',()=>{
   painel.hidden=true;
   painel.setAttribute('aria-hidden','true');
 });
 document.getElementById('btnConfigurarRelacao')?.addEventListener('click',()=>{
   if(controles)controles.hidden=false;
   if(ajuda)ajuda.hidden=false;
   painel.removeAttribute('aria-hidden');
   if(fecharConfiguracao)fecharConfiguracao.textContent='✕ Fechar';
 });
 document.getElementById('relacaoGerarConfigurada')?.addEventListener('click',()=>gerarODTRelacaoNomes());
 sincronizar();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',relacaoConfigurarInicializar);else relacaoConfigurarInicializar();
async function gerarODTRelacaoNomes(){
    try{
        const hoje=new Date();
        const dd=String(hoje.getDate()).padStart(2,'0');
        const mm=String(hoje.getMonth()+1).padStart(2,'0');
        const aaaa=hoje.getFullYear();
        const dataHoje=`${dd}/${mm}/${aaaa}`;

        // Somente pessoas atualmente acolhidas entram na relação.
        // Pessoas com Data de Saída continuam armazenadas no sistema,
        // mas não são consideradas acolhidas ativas.
        // Utiliza exatamente a mesma sequência do Controle de Entrada e Saída:
        // primeiro horário de saída registrado, seguido dos quartos/pessoas sem saída.
        // A busca visual do controle não interfere na relação completa.
        const pessoas=obterPessoasControleEntradaSaida().map(({room,p})=>({
            id:relacaoChavePessoa(p),
            nome:String(p.nome||'').trim(),
            idade:idadeDaPessoa(p),
            quarto:String(room.numero??'').trim()
        }));

        // O resumo desta relação usa as MESMAS funções de cálculo do
        // relatório/"Baixar Planilha". Assim, os dois documentos ficam
        // sempre sincronizados e obedecem exatamente às mesmas regras.
        const totalAcolhidos=contarCategoria(()=>true);
        const idadeValida=p=>idadeDaPessoa(p);
        const ehCrianca=p=>idadeValida(p)!==null && idadeValida(p)<12;
        const ehAdolescente=p=>idadeValida(p)!==null && idadeValida(p)>=12 && idadeValida(p)<18;
        const ehIdoso=p=>idadeValida(p)!==null && idadeValida(p)>=60;

        // Crianças, adolescentes e idosos não entram nos totais de gênero,
        // exatamente como no relatório principal.
        const contarGenero=(genero)=>{
            const esperado=normalizarGenero(genero);
            return contarCategoria((p,room)=>{
                if(ehCrianca(p) || ehAdolescente(p) || ehIdoso(p)) return false;
                const generoPessoa=normalizarGenero(p?.genero);
                const generoQuarto=normalizarGenero(room?.tipoQuarto||tipoQuartoPadrao(room?.ala));
                // O gênero informado na pessoa é prioritário. Quando ele não
                // estiver preenchido, usamos o tipo de quarto como referência
                // para manter a contagem compatível com a classificação da unidade.
                const referencia=generoPessoa && !['nao informado','não informado',''].includes(generoPessoa)
                    ? generoPessoa
                    : generoQuarto;
                return referencia===esperado;
            });
        };

        const mulheres=contarGenero('Feminino');
        const homens=contarGenero('Masculino');
        const criancas=contarCategoria(ehCrianca);
        const adolescentes=contarCategoria(ehAdolescente);
        const idosos=contarCategoria(ehIdoso);
        const trans=contarCategoria(p=>!ehIdoso(p) && ['trans','transexual'].includes(normalizarGenero(p.genero)));
        const vepema=contarCategoria((p,room)=>normalizarGenero(room?.tipoQuarto||tipoQuartoPadrao(room?.ala))==='vepema');

        const vagasHomem=contarVagasPorTipo('Homem');
        const vagasMulher=contarVagasPorTipo('Mulher');
        const vagasIdoso=contarVagasPorTipo('Idoso');
        const vagasVepema=contarVagasPorTipo('VEPEMA');

        // O total global usa a soma de todas as destinações existentes,
        // inclusive Trans e Outro, para não deixar vagas fora do cálculo.
        const totalVagas=Object.values(state.rooms||{}).reduce((total,room)=>{
            if(!room || room.status==='indisponivel' || destinoVagaDoQuarto(room)==='vepema') return total;
            const ocupantesAtivos=(room.pessoas||[]).filter(pessoaAtivaResumo).length;
            return total+Math.max(0,capacidadePadraoRoom(room)-ocupantesAtivos);
        },0);

        const esc=xmlEscapeODT;
        const cell=(value,style='CelulaRelacao')=>`<table:table-cell table:style-name="${style}"><text:p text:style-name="ParagrafoRelacao">${esc(value ?? '')}</text:p></table:table-cell>`;
        const cellC=(value,style='CelulaRelacaoCentro')=>`<table:table-cell table:style-name="${style}"><text:p text:style-name="ParagrafoRelacaoCentro">${esc(value ?? '')}</text:p></table:table-cell>`;
        const blank=()=>cellC('');

        const qtdPares=relacaoOpcoes.entradaSaida?relacaoQtd():0;
        const celulaNome=p=>p.nome+(relacaoOpcoes.idade&&p.idade!==null?' • '+p.idade+' '+(p.idade===1?' ano':' anos'):'');
        const celulasVariaveis=p=>{
            let x='';for(let i=0;i<qtdPares;i++)x+=cellC(relacaoLerCelula(p.id,'e'+i))+cellC(relacaoLerCelula(p.id,'s'+i));
            return x;
        };
        let rows='';
        pessoas.forEach((p,i)=>{
            rows += '<table:table-row table:style-name="RowRelacao">';
            rows += cellC(String(i+1).padStart(2,'0'),'CelulaRelacaoNumero');
            rows += cell(celulaNome(p),'CelulaRelacaoNome');
            rows += cellC(p.quarto || '-','CelulaRelacaoQuarto');
            rows += celulasVariaveis(p);
            rows += cell(relacaoLerCelula(p.id,'obs'),'CelulaRelacao');
            rows += '</table:table-row>';
        });
        if(!rows){
            rows='<table:table-row table:style-name="RowRelacao">'+
                cellC('-','CelulaRelacaoNumero')+cell('Nenhum acolhido ativo cadastrado.','CelulaRelacaoNome')+cellC('-','CelulaRelacaoQuarto')+
                Array.from({length:qtdPares*2},()=>blank()).join('')+cell('','CelulaRelacao')+
                '</table:table-row>';
        }

        const resumoRows = `
          <table:table-row table:style-name="RowResumo">${cell('Mulheres acolhidas','CelulaResumoRelacao')}${cellC(mulheres,'CelulaResumoValor')}${cell('Homens acolhidos','CelulaResumoRelacao')}${cellC(homens,'CelulaResumoValor')}</table:table-row>
          <table:table-row table:style-name="RowResumo">${cell('Crianças acolhidas','CelulaResumoRelacao')}${cellC(criancas,'CelulaResumoValor')}${cell('Adolescentes acolhidos','CelulaResumoRelacao')}${cellC(adolescentes,'CelulaResumoValor')}</table:table-row>
          <table:table-row table:style-name="RowResumo">${cell('Idosos acolhidos','CelulaResumoRelacao')}${cellC(idosos,'CelulaResumoValor')}${cell('Transexuais acolhidos','CelulaResumoRelacao')}${cellC(trans,'CelulaResumoValor')}</table:table-row>
          <table:table-row table:style-name="RowResumo">${cell('VEPEMA','CelulaResumoRelacao')}${cellC(vepema,'CelulaResumoValor')}${cell('Total de vagas disponíveis','CelulaResumoRelacao')}${cellC(totalVagas,'CelulaResumoValor')}</table:table-row>
          <table:table-row table:style-name="RowResumoTotal"><table:table-cell table:style-name="CelulaResumoTotalRelacao" table:number-columns-spanned="3"><text:p text:style-name="ParagrafoRelacaoCentro">TOTAL DE PESSOAS NA UNIDADE</text:p></table:table-cell><table:covered-table-cell/><table:covered-table-cell/>${cellC(totalAcolhidos,'CelulaResumoTotalValor')}</table:table-row>
          <table:table-row table:style-name="RowResumoTitulo"><table:table-cell table:style-name="CelulaResumoTituloRelacao" table:number-columns-spanned="4"><text:p text:style-name="ParagrafoRelacaoCentro">VAGAS DISPONÍVEIS POR DESTINAÇÃO</text:p></table:table-cell><table:covered-table-cell/><table:covered-table-cell/><table:covered-table-cell/></table:table-row>
          <table:table-row table:style-name="RowResumo">${cell('Homem','CelulaResumoRelacao')}${cellC(vagasHomem,'CelulaResumoValor')}${cell('Mulher','CelulaResumoRelacao')}${cellC(vagasMulher,'CelulaResumoValor')}</table:table-row>
          <table:table-row table:style-name="RowResumo">${cell('Idoso','CelulaResumoRelacao')}${cellC(vagasIdoso,'CelulaResumoValor')}${cell('VEPEMA','CelulaResumoRelacao')}${cellC(vagasVepema,'CelulaResumoValor')}</table:table-row>`;

        const content=`<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 office:version="1.2">
 <office:automatic-styles>
  <style:style style:name="RowRelacao" style:family="table-row"><style:table-row-properties style:use-optimal-row-height="true"/></style:style>
  <style:style style:name="RowResumo" style:family="table-row"><style:table-row-properties style:use-optimal-row-height="true"/></style:style>
  <style:style style:name="RowResumoTotal" style:family="table-row"><style:table-row-properties style:use-optimal-row-height="true"/></style:style>
  <style:style style:name="RowResumoTitulo" style:family="table-row"><style:table-row-properties style:use-optimal-row-height="true"/></style:style>
  <style:style style:name="TabelaRelacao" style:family="table"><style:table-properties table:align="left"/></style:style>
  <style:style style:name="TabelaResumoRelacao" style:family="table"><style:table-properties table:align="margins"/></style:style>
  <style:style style:name="CelulaTituloRelacao" style:family="table-cell"><style:table-cell-properties fo:border="none" fo:padding="0cm" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaDataRelacao" style:family="table-cell"><style:table-cell-properties fo:border="none" fo:padding="0cm" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaSubtituloRelacao" style:family="table-cell"><style:table-cell-properties fo:border="none" fo:padding="0cm" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaCabRelacao" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#dceaf5" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaRelacao" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#ffffff" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaRelacaoCentro" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#ffffff" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaRelacaoNumero" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#f2f2f2" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaRelacaoNome" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#ffffff" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaRelacaoQuarto" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #000000" fo:padding="0.07cm" fo:background-color="#ffffff" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaResumoRelacao" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #7e9fb9" fo:padding="0.07cm" fo:background-color="#eaf3fb" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaResumoValor" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #7e9fb9" fo:padding="0.07cm" fo:background-color="#ffffff" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold" fo:color="#000000"/></style:style>
  <style:style style:name="CelulaResumoTotalRelacao" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #7e9fb9" fo:padding="0.07cm" fo:background-color="#f2f7d2" style:vertical-align="middle"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="CelulaResumoTotalValor" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #7e9fb9" fo:padding="0.07cm" fo:background-color="#f2f7d2" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="CelulaResumoTituloRelacao" style:family="table-cell"><style:table-cell-properties fo:border="0.5pt solid #7e9fb9" fo:padding="0.07cm" fo:background-color="#dceaf5" style:vertical-align="middle"/><style:paragraph-properties fo:text-align="center"/><style:text-properties style:font-name="Arial" fo:font-size="12pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="ParagrafoRelacao" style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:line-height="100%"/><style:text-properties style:font-name="Arial" fo:font-size="12pt"/></style:style>
  <style:style style:name="ParagrafoRelacaoCentro" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0cm" fo:margin-bottom="0cm" fo:line-height="100%"/><style:text-properties style:font-name="Arial" fo:font-size="12pt"/></style:style>
  <style:style style:name="ColRNHeader" style:family="table-column"><style:table-column-properties style:column-width="19cm"/></style:style>
  <style:style style:name="ColRN0" style:family="table-column"><style:table-column-properties style:column-width="0.90cm"/></style:style>
  <style:style style:name="ColRN1" style:family="table-column"><style:table-column-properties style:column-width="${qtdPares?5.8:7.99}cm"/></style:style>
  <style:style style:name="ColRN2" style:family="table-column"><style:table-column-properties style:column-width="1.005cm"/></style:style>
  <style:style style:name="ColRN3" style:family="table-column"><style:table-column-properties style:column-width="${qtdPares?3.5:9.075}cm"/></style:style>
  ${qtdPares?`<style:style style:name="ColRNExtra" style:family="table-column"><style:table-column-properties style:column-width="${qtdPares>4?0.75:1.4}cm"/></style:style>`:''}
  <style:style style:name="ColRS0" style:family="table-column"><style:table-column-properties style:column-width="7.489cm"/></style:style>
  <style:style style:name="ColRS1" style:family="table-column"><style:table-column-properties style:column-width="2.011cm"/></style:style>
  <style:style style:name="ColRS2" style:family="table-column"><style:table-column-properties style:column-width="7.489cm"/></style:style>
  <style:style style:name="ColRS3" style:family="table-column"><style:table-column-properties style:column-width="2.011cm"/></style:style>
 </office:automatic-styles>
 <office:body><office:text>
  <table:table table:name="CabecalhoRelacaoNomes" table:style-name="TabelaRelacao">
   <table:table-column table:style-name="ColRNHeader"/>
   <table:table-row table:style-name="RowRelacao"><table:table-cell table:style-name="CelulaTituloRelacao"><text:p text:style-name="ParagrafoRelacaoCentro">PREFEITURA DO MUNICÍPIO DE PORTO VELHO</text:p></table:table-cell></table:table-row>
   <table:table-row table:style-name="RowRelacao"><table:table-cell table:style-name="CelulaSubtituloRelacao"><text:p text:style-name="ParagrafoRelacaoCentro">Secretaria Municipal de Inclusão e Assistência Social – SEMIAS</text:p></table:table-cell></table:table-row>
   <table:table-row table:style-name="RowRelacao"><table:table-cell table:style-name="CelulaDataRelacao"><text:p text:style-name="ParagrafoRelacaoCentro">Porto Velho-RO, ${esc(dataHoje)}</text:p></table:table-cell></table:table-row>
   <table:table-row table:style-name="RowRelacao"><table:table-cell table:style-name="CelulaTituloRelacao"><text:p text:style-name="ParagrafoRelacaoCentro">RELAÇÃO DE ACOLHIDOS</text:p></table:table-cell></table:table-row>
  </table:table>
  <table:table table:name="RelacaoNomes" table:style-name="TabelaRelacao">
   <table:table-column table:style-name="ColRN0"/><table:table-column table:style-name="ColRN1"/><table:table-column table:style-name="ColRN2"/>
   ${Array.from({length:qtdPares*2},()=>'<table:table-column table:style-name="ColRNExtra"/>').join('')}
   <table:table-column table:style-name="ColRN3"/>
   <table:table-row table:style-name="RowRelacao">
    ${cellC('Nº','CelulaCabRelacao')}${cellC('Nome','CelulaCabRelacao')}${cellC('Apt','CelulaCabRelacao')}${Array.from({length:qtdPares},()=>cellC('Entrada','CelulaCabRelacao')+cellC('Saída','CelulaCabRelacao')).join('')}${cellC('Observações','CelulaCabRelacao')}
   </table:table-row>
   ${rows}
  </table:table>
  <table:table table:name="ResumoRelacao" table:style-name="TabelaResumoRelacao">
   <table:table-column table:style-name="ColRS0"/><table:table-column table:style-name="ColRS1"/><table:table-column table:style-name="ColRS2"/><table:table-column table:style-name="ColRS3"/>
   ${resumoRows}
  </table:table>
 </office:text></office:body>
</office:document-content>`;

        const styles=`<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.2">
 <office:styles><style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.08cm"/><style:text-properties style:font-name="Arial" fo:font-size="9pt"/></style:default-style></office:styles>
 <office:automatic-styles><style:page-layout style:name="A4"><style:page-layout-properties fo:page-width="${qtdPares>=2?'29.7':'21'}cm" fo:page-height="${qtdPares>=2?'21':'29.7'}cm" style:print-orientation="${qtdPares>=2?'landscape':'portrait'}" fo:margin-top="1cm" fo:margin-bottom="0.8cm" fo:margin-left="1cm" fo:margin-right="1cm"/></style:page-layout></office:automatic-styles>
 <office:master-styles><style:master-page style:name="Standard" style:page-layout-name="A4"/></office:master-styles>
</office:document-styles>`;
        const manifest=`<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
        const bytes=zipODT([
            {name:'mimetype',data:'application/vnd.oasis.opendocument.text'},
            {name:'content.xml',data:content},
            {name:'styles.xml',data:styles},
            {name:'META-INF/manifest.xml',data:manifest}
        ]);
        const blob=new Blob([bytes],{type:'application/vnd.oasis.opendocument.text'});
        const nome=`Relacao_de_Nomes_${dd}-${mm}-${aaaa}.odt`;
        if(await salvarNaPastaODT(blob,nome,'nomes'))return;
        if(window.showSaveFilePicker){
            const handle=await window.showSaveFilePicker({suggestedName:nome,types:[{description:'Documento OpenDocument',accept:{'application/vnd.oasis.opendocument.text':['.odt']}}]});
            const w=await handle.createWritable(); await w.write(blob); await w.close();
            setStatus('✓ ODT — Relação de Nomes salvo.');
            window.confirmarArquivoGerado?.('Lista',nome,null);
        }else{
            const url=URL.createObjectURL(blob),a=document.createElement('a');
            a.href=url;a.download=nome;document.body.appendChild(a);a.click();a.remove();
            setTimeout(()=>URL.revokeObjectURL(url),1500);
            setStatus('✓ ODT — Relação de Nomes gerado.');
            window.confirmarArquivoGerado?.('Lista',nome,null);
        }
    }catch(e){
        if(e.name!=='AbortError') alert('Não foi possível gerar o ODT — Relação de Nomes: '+e.message);
    }
}

function inicializar(){
    state=carregarEstado();
    carregarHistorico();
    carregarHistoricoAcolhimentos();
    inicializarArquivosHistoricos();
    // Corrige também quartos que já tinham uma primeira linha vazia salva.
    // Preserva os ids e a sequência relativa de todos os cadastros existentes.
    let cadastrosReordenados=false;
    Object.values(state.rooms||{}).forEach(room=>{
        if(compactarPrimeiroCadastroVazio(room))cadastrosReordenados=true;
    });
    if(cadastrosReordenados){
        localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
    }
    if(migrarVinculosResponsavelParaIds()) salvarNoStorage();
    sincronizarHistoricoComEstado();
    limparHistoricoExpirado();
    render();

    document.getElementById('selectPlantao').onchange=mudarPlantao;
    const campoDataInicio=document.getElementById('dataInicioPlantao');
    campoDataInicio.value=state.dataInicioPlantao||'';
    campoDataInicio.onchange=()=>{
        const novaData=campoDataInicio.value;
        if(novaData!==state.dataInicioPlantao){
            snapshotAntes();
            state.plantonistasAnterior=deepClone(state.employees?.plantonistas||[]);
            state.dataInicioPlantaoAnterior=state.dataInicioPlantao||'';
            state.dataInicioPlantao=novaData;
            salvarNoStorage();
            salvarHistorico();
            atualizarStatusPasta('');
            atualizarStatusPasta(''); obterHandlePasta().then(h=>{if(h)atualizarStatusPasta(h.name);}).catch(()=>{});
            setStatus('✓ Data de início registrada. Os plantonistas anteriores foram armazenados para a tabela de ontem. Se este for um novo mês, use “Selecionar pasta mensal” para escolher a pasta deste mês.');
        }
    };
    document.getElementById('btnDesfazer').onclick=desfazer;
    document.getElementById('btnRefazer').onclick=refazer;
    document.getElementById('btnEscolherPastaBackup').onclick=escolherPastaBackup;
    document.getElementById('btnExportar').onclick=exportarBackup;
    atualizarStatusPasta(''); obterHandlePasta().then(h=>{if(h)atualizarStatusPasta(h.name);}).catch(()=>{});
    document.getElementById('arquivoBackup').onchange=importarBackup;
    document.getElementById('btnRestaurarUltimo').onclick=restaurarUltimoBackup;
    document.getElementById('btnAbrirHistorico').onclick=abrirHistorico;
    document.getElementById('btnFecharHistorico').onclick=fecharHistorico;
    document.getElementById('btnPesquisarHistorico').onclick=pesquisarHistorico;
    document.getElementById('historicoFotoInput').onchange=processarFotoHistorico;
    document.getElementById('historicoBusca').onkeydown=e=>{if(e.key==='Enter')pesquisarHistorico();};
    document.getElementById('historicoMostrarTodos').onchange=pesquisarHistorico;
    document.getElementById('historicoOrdenacao').onchange=pesquisarHistorico;
    const btnImprimir=document.getElementById('btnImprimir');
    if(btnImprimir) btnImprimir.onclick=imprimirRelacao;
    const btnBaixarODT=document.getElementById('btnBaixarODT');
    if(btnBaixarODT) btnBaixarODT.onclick=baixarODT;
    const btnGerarODTRelacaoNomes=document.getElementById('btnGerarODTRelacaoNomes');
    if(btnGerarODTRelacaoNomes) btnGerarODTRelacaoNomes.onclick=gerarODTRelacaoNomes;
    document.getElementById('btnPastaODTPlanilha').onclick=()=>escolherPastaODT('planilha');
    document.getElementById('btnPastaODTNomes').onclick=()=>escolherPastaODT('nomes');
    atualizarTextoPastasODT();
    const btnAbrirControleEntradaSaida=document.getElementById('btnAbrirControleEntradaSaida');
    if(btnAbrirControleEntradaSaida) btnAbrirControleEntradaSaida.onclick=alternarControleEntradaSaida;
    const btnFecharControleEntradaSaida=document.getElementById('btnFecharControleEntradaSaida');
    if(btnFecharControleEntradaSaida) btnFecharControleEntradaSaida.onclick=alternarControleEntradaSaida;
    document.getElementById('btnLimparTodosHorariosControleES')?.addEventListener('click',limparTodosHorariosControleES);
    controleESAtualizarOrdemUI();
    document.getElementById('controleESDataLista')?.addEventListener('change',e=>{
        const nova=e.target.value;
        if(!/^\d{4}-\d{2}-\d{2}$/.test(nova))return;
        controleESSalvarOrdemDia();
        const cfg=controleESPreferenciasOrdem();
        cfg.dataLista=nova;
        salvarNoStorage();controleESAtualizarOrdemUI();renderControleEntradaSaida();
    });
    document.getElementById('controleESUsarOrdemOntem')?.addEventListener('change',e=>{
        const cfg=controleESPreferenciasOrdem();
        cfg.usarOrdemOntem=e.target.checked;
        salvarNoStorage();controleESAtualizarOrdemUI();renderControleEntradaSaida();
    });
    const buscaControleES=document.getElementById('controleEntradaSaidaBusca');
    if(buscaControleES) buscaControleES.addEventListener('input',renderControleEntradaSaida);
    const limparBuscaControleES=document.getElementById('btnLimparBuscaControleES');
    if(limparBuscaControleES) limparBuscaControleES.onclick=()=>{if(buscaControleES)buscaControleES.value='';renderControleEntradaSaida();};
    const fecharAutorizacao=document.getElementById('btnFecharControleAutorizacao');
    if(fecharAutorizacao) fecharAutorizacao.onclick=fecharMensagemAutorizacao;
    const backdropAutorizacao=document.getElementById('controleAutorizacaoModalBackdrop');
    if(backdropAutorizacao) backdropAutorizacao.onclick=e=>{if(e.target===backdropAutorizacao)fecharMensagemAutorizacao();};
    const btnCancelarControleChave=document.getElementById('btnCancelarControleChave');
    if(btnCancelarControleChave) btnCancelarControleChave.onclick=fecharPerguntaChave;
    document.getElementById('modalCancelar').onclick=fecharModal;
    document.getElementById('modalSalvar').onclick=salvarConfiguracao;
    document.querySelectorAll('[data-add-func]').forEach(btn=>btn.onclick=()=>adicionarFuncionario(btn.dataset.addFunc==='ulVigilantes'?'vigilantes':'plantonistas'));

    window.addEventListener('beforeunload',()=>{salvarNoStorage();salvarHistorico();salvarHistoricoAcolhimentos();});
    setStatus('✓ Sistema offline pronto. Dados armazenados neste computador.');
    if(window.__authBoot)window.__authBoot();
}
document.addEventListener('DOMContentLoaded',()=>{
    if(typeof window.__secureStart==='function')window.__secureStart(inicializar);
    else document.body.replaceChildren(Object.assign(document.createElement('p'),{textContent:'Erro de segurança: módulo de autenticação indisponível. Nenhum dado foi carregado.'}));
});
