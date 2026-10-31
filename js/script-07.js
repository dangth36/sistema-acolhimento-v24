
(function(){
  const KEY='frei_damiao_equipes_paineis_recolhidos_v1';
  let saved={};
  try{ saved=JSON.parse(localStorage.getItem(KEY)||'{}')||{}; }catch(e){}
  document.querySelectorAll('.btn-recolher-equipe').forEach(btn=>{
    const content=document.getElementById(btn.getAttribute('aria-controls'));
    if(!content)return;
    function show(expanded){
      content.hidden=!expanded;
      btn.setAttribute('aria-expanded',String(expanded));
      btn.textContent=expanded?'− Minimizar':'+ Maximizar';
    }
    const key=btn.dataset.equipe;
    show(saved[key]!==false);
    btn.addEventListener('click',()=>{
      const expanded=btn.getAttribute('aria-expanded')!=='true';
      show(expanded);saved[key]=expanded;
      try{localStorage.setItem(KEY,JSON.stringify(saved));}catch(e){}
    });
  });
})();
