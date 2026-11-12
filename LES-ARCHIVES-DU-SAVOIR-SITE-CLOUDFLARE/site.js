'use strict';
(async () => {
  const status=document.getElementById('download-status');
  try {
    const response=await fetch('./updates.json',{cache:'no-store'});
    if(!response.ok)throw new Error('manifest');
    const manifest=await response.json();
    let count=0;
    for(const card of document.querySelectorAll('[data-key]')) {
      const item=manifest?.downloads?.[card.dataset.key];
      if(!item || typeof item.url!=='string' || item.url.length>2048 || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(item.version||''))continue;
      let url;try{url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password)continue;}catch{continue;}
      card.querySelector('.release-label').textContent='Version '+item.version;
      const a=document.createElement('a');a.className='download-link active';a.href=url.href;a.textContent='Télécharger ↗';a.setAttribute('aria-label',`Télécharger ${card.querySelector('h3').textContent} ${card.querySelector('p').textContent}, version ${item.version}`);
      card.querySelector('.download-link').replaceWith(a);count++;
    }
    status.textContent=count ? 'Choisissez une version disponible ci-dessous.' : 'Les téléchargements ne sont pas encore publiés.';
  } catch {status.textContent='Les disponibilités sont momentanément indisponibles. Réessayez plus tard.';}
})();
