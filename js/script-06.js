
/* Máscara progressiva para todos os campos de CPF, inclusive os criados dinamicamente. */
(function(){
  function formatarCPF(valor){
    const digitos=String(valor||'').replace(/\D/g,'').slice(0,11);
    return digitos.replace(/^(\d{3})(\d)/,'$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/,'$1.$2.$3')
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/,'$1.$2.$3-$4');
  }
  function campoCPF(el){return el instanceof HTMLInputElement && (el.classList.contains('cpf-input') || el.name==='cpf');}
  document.addEventListener('input',function(e){
    const el=e.target;
    if(!campoCPF(el))return;
    const pos=el.selectionStart;
    const antes=pos===null?null:el.value.slice(0,pos).replace(/\D/g,'').length;
    const formatado=formatarCPF(el.value);
    if(el.value!==formatado){
      el.value=formatado;
      if(antes!==null && document.activeElement===el){
        let p=0,n=0;
        while(p<formatado.length&&n<antes){if(/\d/.test(formatado[p]))n++;p++;}
        el.setSelectionRange(p,p);
      }
    }
  },true);
  document.addEventListener('focusin',function(e){
    const el=e.target;
    if(!campoCPF(el))return;
    el.placeholder='000.000.000-00';el.maxLength=14;el.inputMode='numeric';el.autocomplete='off';
    el.value=formatarCPF(el.value);
  },true);
})();
