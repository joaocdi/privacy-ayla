(()=>{
 const $=id=>document.getElementById(id),store=window.AylaCheckouts||window.JoiceCheckouts,params=new URLSearchParams(location.search),money=n=>Number(n).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
 let item,version=0,timer,poller,expiresAt,regenRequested=params.has('regen'),smallerRequested=params.has('smaller');
 const say=s=>{$('status').textContent=s;};
 const track=name=>window.FunnelAnalytics?.track(name,item?.productId,item?.payment?.orderId);
 const auth=()=>({Authorization:'Bearer '+item.token});
 function stop(){clearInterval(timer);clearTimeout(poller);version++;}
 function clock(value,v){clearInterval(timer);expiresAt=value;const ms=value?Date.parse(String(value).replace(' ','T')+(String(value).includes('Z')?'':'Z')):NaN;
  if(!Number.isFinite(ms)){$('remaining').textContent='';$('remaining').hidden=true;return;}
  $('remaining').hidden=false;
  function tick(){if(v!==version)return;const seconds=Math.max(0,Math.ceil((ms-Date.now())/1000));$('remaining').textContent=seconds?('Tempo restante: '+String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')):'Prazo encerrado';if(!seconds){clearInterval(timer);track('pix_expired');$('pix').hidden=true;expired();}}
  tick();timer=setInterval(tick,1000);
 }
 async function monthlyPrice(){try{const id=item.productId.startsWith('ayla_')?'ayla_monthly':'monthly';const r=await fetch('/api/catalog');if(!r.ok)return;const data=await r.json(),plan=data.products?.find(p=>p.id===id);if(plan)$('monthly').textContent='Começar por 1 mês — '+money(plan.price);}catch(_){}}
 function expired(){say('Este PIX expirou. Se já pagou, aguarde a confirmação antes de fazer outra cobrança.');$('alternatives').hidden=false;$('monthly').hidden=!['ayla_quarterly','ayla_semester','quarterly','semester'].includes(item.productId);if(!$('monthly').hidden)monthlyPrice();}
 async function check(v){if(v!==version||!item)return;
  try{const r=await fetch('/api/orders/'+encodeURIComponent(item.payment.orderId)+'/status',{headers:auth(),signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Pedido indisponível. Volte ao perfil e escolha um plano.');const state=await r.json();if(v!==version)return;
   $('detail').textContent=(item.payment?.product?.name||item.productId)+' · '+money(state.amount);if(state.status==='PAID'){stop();$('pix').hidden=true;$('remaining').textContent='';say('Pagamento confirmado.');if(state.accountFlow){store.select(item);$('access').href=state.needsClaim?'/criar-acesso?order='+encodeURIComponent(item.payment.orderId):'/meu-acesso';$('access').textContent=state.needsClaim?'Criar meu acesso':'Ir para Meu acesso';$('access').hidden=false;if(!state.needsClaim)store.remove(item);}else store.remove(item);return;}
   if(state.status==='EXPIRED'||state.status==='CANCELED'){stop();track('pix_expired');expired();if(regenRequested||smallerRequested){const smaller=smallerRequested;regenRequested=false;smallerRequested=false;history.replaceState({},'', '/continuar?order='+encodeURIComponent(item.payment.orderId));regenerate(smaller?(item.productId.startsWith('ayla_')?'ayla_monthly':'monthly'):item.productId);}return;}
   if(state.status==='PENDING'){
    if($('pix').hidden){const p=await fetch('/api/orders/'+encodeURIComponent(item.payment.orderId)+'/pix',{headers:auth(),signal:AbortSignal.timeout(12000)});if(!p.ok)throw Error('PIX indisponível. Consulte novamente mais tarde.');const data=await p.json();if(v!==version)return;$('qr').src=data.pix.qrCode;$('code').value=data.pix.copyPaste;$('pix').hidden=false;clock(data.expiresAt,v);track('pix_qr_viewed');}
    say('Aguardando pagamento... não precisa atualizar');
   }else say('Seu PIX está sendo preparado. Aguarde um instante.');
  }catch(e){if(v===version)say(e.message||'Sem conexão. Tentando novamente…');}
  if(v===version)poller=setTimeout(()=>check(v),3500);
 }
 async function regenerate(productId){if(!item)return;const old=item;stop();$('renew').disabled=true;$('monthly').disabled=true;$('alternatives').hidden=true;$('pix').hidden=true;say('Gerando novo PIX…');
  const retry=item&&item.productId===productId&&!item.payment?.orderId;const token=retry?item.token:Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');let next=retry?item:{productId,token,createdAt:Date.now()};
  try{store.save(next);store.select(next);const r=await fetch('/api/payments/pix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId,checkoutToken:token}),signal:AbortSignal.timeout(25000)}),data=await r.json();if(!r.ok&&r.status!==202)throw Error(data.error||'Não foi possível gerar o PIX.');next=store.save({...next,payment:data});item=next;history.replaceState({},'', '/continuar?order='+encodeURIComponent(data.orderId));$('renew').disabled=false;$('monthly').disabled=false;window.FunnelAnalytics?.track('pix_regenerated',productId,data.orderId);check(version);
  }catch(e){item=next;$('renew').disabled=false;$('monthly').disabled=true;$('alternatives').hidden=false;say(e.name==='TimeoutError'?'Conexão interrompida. Toque em consultar este mesmo pedido antes de tentar outro.':e.message);$('renew').textContent='CONSULTAR O MESMO PEDIDO';}
 }
 $('renew').onclick=()=>regenerate(item.productId);$('monthly').onclick=()=>regenerate(item.productId.startsWith('ayla_')?'ayla_monthly':'monthly');
 $('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('code').value);$('copy').textContent='PIX COPIADO';track('pix_copied');setTimeout(()=>$('copy').textContent='COPIAR PIX',1800);}catch(_){$('code').select();say('Selecione e copie o código PIX.');}};
 const list=store.list();item=list.find(p=>p.payment?.orderId===params.get('order'))||store.selected()||list.filter(p=>p.payment?.orderId).at(-1);
 if(!item?.payment?.orderId){say('Nenhum PIX pendente neste navegador.');$('access').href='/';$('access').textContent='Ver planos';$('access').hidden=false;return;}
 track('pix_pending_return');check(version);
})();
