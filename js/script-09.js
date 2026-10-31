
document.getElementById('modoQuartosCartoes')?.addEventListener('click',()=>definirModoQuartos('cartoes'));
document.getElementById('modoQuartosMapa')?.addEventListener('click',()=>definirModoQuartos('mapa'));
document.querySelectorAll('[data-abd-nav]').forEach(b=>b.addEventListener('click',()=>navegarABD(b.dataset.abdNav)));
document.getElementById('modoQuartosDetalhes')?.addEventListener('click',()=>definirModoQuartos('detalhes'));
if(typeof aplicarModoQuartos==='function')aplicarModoQuartos();
