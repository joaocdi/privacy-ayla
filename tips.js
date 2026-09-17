/* Mimos reuse the existing order/provider/webhook. No access is sold here. */
(() => {
  const money = cents => (cents / 100).toLocaleString('pt-BR', {style:'currency',currency:'BRL'});
  const gift = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 8h18v4H3zM5 12v9h14v-9M12 8v13"/><path d="M12 8H8a3 3 0 1 1 3-3l1 3Zm0 0h4a3 3 0 1 0-3-3l-1 3Z"/></svg>';
  let config, state, timer, busy=false, generation=0, lastFocus;
  const modal=document.createElement('dialog');modal.className='tip-dialog';modal.setAttribute('aria-labelledby','tipTitle');
  modal.innerHTML='<button class="tip-close" type="button" aria-label="Fechar mimo">×</button><div class="tip-icon">'+gift+'</div><h2 id="tipTitle">Enviar um mimo</h2><p class="tip-intro">Um carinho no valor que você escolher.</p><p class="tip-note">Não inclui assinatura ou desbloqueio de contato.</p><form id="tipForm"><label for="tipAmount">Valor do mimo</label><div class="tip-presets"><button type="button" data-cents="500">R$ 5</button><button type="button" data-cents="1000">R$ 10</button><button type="button" data-cents="2000">R$ 20</button><button type="button" data-cents="5000">R$ 50</button></div><div class="tip-input"><span>R$</span><input id="tipAmount" type="text" inputmode="decimal" value="5,00" maxlength="8" autocomplete="off" required></div><small>A partir de R$ 5,00</small><button class="tip-primary" id="tipGenerate" type="submit">GERAR PIX DO MIMO</button></form><div id="tipPix" hidden><strong id="tipTotal"></strong><img id="tipQr" width="220" height="220" alt="QR Code PIX do mimo"><label for="tipCode">PIX Copia e Cola</label><input id="tipCode" readonly><button type="button" class="tip-primary" id="tipCopy">COPIAR CÓDIGO PIX</button><p class="tip-note">Abra seu banco, escolha PIX e cole o código ou escaneie o QR Code. Confira o valor antes de confirmar.</p><button type="button" id="tipSimulate" hidden>SIMULAR PAGAMENTO — TESTE</button></div><p id="tipStatus" role="status" aria-live="polite"></p><button type="button" id="tipNew" hidden>Enviar outro mimo</button>';
  document.body.append(modal);
  const $=id=>modal.querySelector('#'+id), say=t=>{$('tipStatus').textContent=t;};
  const track=(name)=>window.FunnelAnalytics?.track(name,config?.productId,state?.payment?.orderId);
  const save=()=>{try{const stored={...state,payment:state?.payment?{...state.payment,pix:undefined}:undefined};localStorage.setItem(config.productId+'.pending',JSON.stringify(stored));}catch(_){}};
  function clear(){state=null;try{localStorage.removeItem(config.productId+'.pending');}catch(_){}}
  function stop(){clearTimeout(timer);generation++;}
  function reset(){ $('tipForm').hidden=false;$('tipPix').hidden=true;$('tipNew').hidden=true;$('tipAmount').disabled=false;$('tipGenerate').disabled=false;$('tipGenerate').textContent='GERAR PIX DO MIMO';modal.querySelectorAll('[data-cents]').forEach(b=>b.disabled=false);say(''); }
  function locked(){ $('tipAmount').disabled=true;modal.querySelectorAll('[data-cents]').forEach(b=>b.disabled=true); }
  async function open(){
    if(modal.open)return;lastFocus=document.activeElement;modal.showModal();reset();say('Carregando…');
    try{
      const r=await fetch('/api/tips/config',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Mimos indisponíveis agora.');config=await r.json();if(!config.available)throw Error('Mimos indisponíveis neste meio de pagamento.');track('tip_started');
      if(!modal.open)return;
      if(!state){try{const old=JSON.parse(localStorage.getItem(config.productId+'.pending'));if(old&&/^[a-f0-9]{64}$/.test(old.token)&&Number.isSafeInteger(old.cents)&&old.cents>=config.minCents&&old.cents<=config.maxCents){state=old;save();}}catch(_){}}
      say('');if(state){$('tipAmount').value=(state.cents/100).toFixed(2).replace('.',',');locked();if(state.payment?.orderId){$('tipForm').hidden=true;const status=await fetch('/api/orders/'+encodeURIComponent(state.payment.orderId)+'/status',{headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(12000)});if(!status.ok)throw Error('Não foi possível consultar este mimo. Abra novamente para tentar.');const order=await status.json();if(order.status==='PAID'){clear();say('Mimo recebido! Obrigada pelo carinho ♥');return;}if(order.status==='PENDING'){const response=await fetch('/api/orders/'+encodeURIComponent(state.payment.orderId)+'/pix',{headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(12000)});if(!response.ok)throw Error('PIX indisponível. Abra novamente para consultar.');state.payment={...state.payment,...await response.json()};save();showPix();track('pix_pending_return');return;}if(['EXPIRED','CANCELED'].includes(order.status)){say('Este PIX expirou. Se já pagou, aguarde a confirmação antes de gerar outro.');$('tipNew').hidden=false;return;}say('Seu pedido está em verificação. Aguarde antes de tentar outro.');}else{$('tipGenerate').textContent='RETOMAR ESTE PIX';say('Retome o mesmo pedido para evitar cobrança duplicada.');}}
    }catch(e){say(e.message);$('tipGenerate').disabled=true;}
  }
  function showPix(){
    $('tipForm').hidden=true;$('tipPix').hidden=false;$('tipTotal').textContent='Mimo de '+money(Math.round(Number(state.payment.product.price)*100));
    $('tipCode').value=state.payment.pix.copyPaste||'';const qr=state.payment.pix.qrCode;
    $('tipQr').src=typeof qr==='string'&&qr.startsWith('data:image/png;base64,')?qr:'';
    $('tipCopy').disabled=false;$('tipSimulate').hidden=!state.payment.mock;
    say('Aguardando pagamento... não precisa atualizar');poll(generation);
  }
  async function create(event){
    event?.preventDefault();if(busy||!config)return;
    const raw=$('tipAmount').value.trim().replace(',','.');
    if(!state){if(!/^\d{1,5}(\.\d{1,2})?$/.test(raw)){say('Informe um valor com até duas casas decimais.');return;}const cents=Math.round(Number(raw)*100);if(cents<config.minCents||cents>config.maxCents){say('Escolha de '+money(config.minCents)+' a '+money(config.maxCents)+'.');return;}state={cents,token:Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('')};save();}
    busy=true;locked();$('tipGenerate').disabled=true;say('Gerando seu PIX…');
    try{
      const response=await fetch('/api/payments/pix',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:config.productId,tipAmountCents:state.cents,checkoutToken:state.token}),signal:AbortSignal.timeout(25000)});
      const data=await response.json();if(data.orderId){state.payment={...state.payment,...data};save();}
      if(!response.ok)throw Error(data.error||'Não foi possível gerar o PIX.');
      if(response.status===202){say('PIX em preparação. Toque em retomar para consultar o mesmo pedido.');return;}
      if(modal.open)showPix();
    }catch(e){say(e.name==='TimeoutError'?'A conexão demorou. Retome para consultar o mesmo PIX.':e.message);}
    finally{busy=false;$('tipGenerate').disabled=false;$('tipGenerate').textContent='RETOMAR ESTE PIX';}
  }
  async function poll(version){
    clearTimeout(timer);if(!modal.open||version!==generation||!state?.payment?.orderId)return;
    try{
      const r=await fetch('/api/orders/'+encodeURIComponent(state.payment.orderId)+'/status',{headers:{Authorization:'Bearer '+state.token},signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();const data=await r.json();
      if(!modal.open||version!==generation)return;
      if(data.status==='PAID'){say('Mimo recebido! Obrigada pelo carinho ♥');$('tipPix').hidden=true;$('tipNew').hidden=false;clear();return;}
      if(['EXPIRED','CANCELED','FAILED'].includes(data.status)){say('Este PIX está indisponível. Se já pagou, aguarde a confirmação; não pague de novo.');$('tipCopy').disabled=true;$('tipSimulate').hidden=true;if(['EXPIRED','CANCELED'].includes(data.status))$('tipNew').hidden=false;return;}
      say('Aguardando pagamento... não precisa atualizar');
    }catch(_){if(modal.open&&version===generation)say('Reconectando para confirmar seu mimo…');}
    if(modal.open&&version===generation)timer=setTimeout(()=>poll(version),3500);
  }
  modal.querySelector('.tip-close').onclick=()=>modal.close();modal.addEventListener('close',()=>{stop();lastFocus?.focus();});
  modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
  $('tipForm').onsubmit=create;modal.querySelectorAll('[data-cents]').forEach(b=>b.onclick=()=>{$('tipAmount').value=(Number(b.dataset.cents)/100).toFixed(2).replace('.',',');});
  $('tipCopy').onclick=async()=>{try{await navigator.clipboard.writeText($('tipCode').value);$('tipCopy').textContent='CÓDIGO COPIADO';track('pix_copied');setTimeout(()=>{$('tipCopy').textContent='COPIAR CÓDIGO PIX';},2000);}catch(_){$('tipCode').focus();$('tipCode').select();say('Selecione e copie o código acima.');}};
  $('tipNew').onclick=()=>{stop();clear();reset();$('tipAmount').value='5,00';};
  $('tipSimulate').onclick=async()=>{if(!state?.payment?.mock)return;const data=state.payment;await fetch(data.staging?'/api/staging/confirm':'/api/dev/orders/'+encodeURIComponent(data.orderId)+'/pay',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},body:JSON.stringify({orderId:data.orderId,claimToken:state.token})});poll(generation);};
  function decorate(){document.querySelectorAll('.profile-actions,.vip-profile-actions,.preview-actions,.vip-actions').forEach(container=>{if(container.querySelector('.tip-trigger'))return;const b=document.createElement('button');b.type='button';b.className='tip-trigger';b.innerHTML=gift+'<span>Enviar mimo</span>';b.onclick=open;container.append(b);});}
  decorate();new MutationObserver(decorate).observe(document.body,{childList:true,subtree:true});
})();
