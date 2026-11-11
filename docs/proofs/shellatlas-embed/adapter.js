// Feasibility adapter, injected before the original theme bundle. No theme file changes.
sessionStorage.setItem('cfsm-luminaplus:node-view-mode-session:desktop','large');
sessionStorage.setItem('cfsm-luminaplus:node-view-mode-session:mobile','large');
localStorage.setItem('appearance',JSON.stringify('light'));
const style=document.createElement('style');
style.textContent=`html,body{background:transparent!important;margin:0!important}#root{visibility:hidden}html[data-sa-ready] #root{visibility:visible}[data-sa-path]{display:block!important;min-height:0!important;height:auto!important;max-width:none!important;padding:0!important;margin:0!important;grid-template-columns:1fr!important;gap:0!important}[data-sa-path]>:not([data-sa-path]):not(.server-card){display:none!important}.server-card{margin:0!important;width:100%!important;box-sizing:border-box!important}.server-card-detail-link{display:none!important}`;
document.head.appendChild(style);
function adapt(){
 const cards=document.querySelectorAll('article.server-card');
 if(cards.length!==1)return;
 for(let n=cards[0].parentElement;n&&n!==document.body;n=n.parentElement)n.setAttribute('data-sa-path','');
 document.documentElement.setAttribute('data-sa-ready','');
}
document.addEventListener('DOMContentLoaded',()=>{new MutationObserver(adapt).observe(document.getElementById('root'),{subtree:true,childList:true});adapt();});
document.addEventListener('click',e=>{if(e.target.closest('a')){e.preventDefault();e.stopImmediatePropagation();}},true);
