(()=>{
 const creator=document.documentElement.dataset.creator;
 const key=creator+'.funnel.session';let sessionId;
 try{sessionId=sessionStorage.getItem(key);if(!/^[a-f0-9]{32}$/.test(sessionId||'')){sessionId=Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');sessionStorage.setItem(key,sessionId);}}catch(_){return;}
 function track(event_name,product_id=null,order_id=null){const body=JSON.stringify({creator,session_id:sessionId,event_name,product_id,order_id,page:location.pathname});try{fetch('/api/analytics/event',{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true,credentials:'same-origin'}).catch(()=>{});}catch(_){}}
 window.FunnelAnalytics={track,sessionId};track('page_view');if(window.__ageConfirmedNow){window.__ageConfirmedNow=false;track('age_gate_confirm');}
})();
