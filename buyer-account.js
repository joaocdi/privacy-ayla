const $=id=>document.getElementById(id),path=location.pathname;
let pending = AylaCheckouts.selected();
const claim=()=>pending?{orderId:pending.payment?.orderId,claimToken:pending.token}:{};
const clearClaim=()=>{if(pending)AylaCheckouts.remove(pending);pending=null;};
const hash=new URLSearchParams(location.hash.slice(1));let recoveryToken=hash.get('access_token');
if(location.hash)history.replaceState(null,'',location.pathname);
function link(text,url){const a=document.createElement('a');a.href=url;a.textContent=text;$('links').append(a);}
async function post(route,body){const r=await fetch('/api/buyer/account/'+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'Não foi possível continuar.');return d;}
function field(name,visible,required=visible){if(!$(name+'Label'))return;$(name+'Label').hidden=!visible;const input=$(name+'Label').querySelector('input');input.disabled=!visible;input.required=required;}
function form(title,intro,button){$('title').textContent=title;$('intro').textContent=intro;$('submit').textContent=button;$('accountForm').hidden=false;}
field('phone',false);field('confirm',false);
(async()=>{
 $('links').replaceChildren();
 const catalog=await fetch('/api/catalog').then(r=>r.json());
 if(!catalog.accountFlow)throw Error('Cadastro de comprador ainda não habilitado neste ambiente.');
 if(path==='/meu-acesso'){
  const r=await fetch('/api/buyer/account');if(r.status===401)return location.replace('/login');const data=await r.json();
  $('title').textContent='Seu acesso, sempre aqui';$('intro').textContent=data.email;
  if(!data.orders?.length)$('message').textContent='Você ainda não tem compras vinculadas. Abra seu checkout pago para concluir o vínculo.';
  for(const order of data.orders||[]){const card=document.createElement('article');card.className='order';const title=document.createElement('h2');title.textContent=catalog.products.find(p=>p.id===order.product_id)?.name||order.product_id;const desc=document.createElement('p');const active=order.status==='ACTIVE'&&(!order.expires_at||Date.parse(order.expires_at.replace(' ','T')+'Z')>Date.now());desc.textContent=!active?'Acesso encerrado':order.expires_at?'Acesso até '+new Date(order.expires_at.replace(' ','T')+'Z').toLocaleDateString('pt-BR'):'Seu contato, disponível sempre';card.append(title,desc);if(active){const btn=document.createElement('button');btn.textContent=order.grant_type==='contact'?'Abrir meu WhatsApp':'Entrar no VIP';btn.onclick=async()=>{if(order.grant_type!=='contact')return location.assign('/vip');try{const r=await fetch('/api/contact/'+order.public_id);const d=await r.json();if(!r.ok)throw Error(d.error);location.assign(d.whatsapp);}catch(e){$('message').textContent=e.message;}};card.append(btn);}$('orders').append(card);}
  if(AylaCheckouts.list().length)link('Retomar outras compras','/#pixNotificationBell');
  link('Ver planos','/');const logout=document.createElement('a');logout.href='/login';logout.textContent='Sair da conta';logout.onclick=async e=>{e.preventDefault();await post('logout',{});location.assign('/login');};$('links').append(logout);return;
 }
 if(path==='/criar-acesso'){
  if(!pending?.payment?.orderId||!pending.token)throw Error('Abra seu checkout pago neste navegador para criar o acesso.');
  const r=await fetch('/api/orders/'+pending.payment.orderId+'/status',{headers:{Authorization:'Bearer '+pending.token}});const d=await r.json();
  if(!r.ok||d.status!=='PAID')throw Error('Estamos aguardando a confirmação do seu pagamento. Volte ao checkout para acompanhar.');
  if(!d.needsClaim){clearClaim();return location.replace('/meu-acesso');}
  const account=await fetch('/api/buyer/account');if(account.ok){await post('claim',claim());clearClaim();return location.replace('/meu-acesso');}
  $('eyebrow').textContent='Pagamento aprovado';
  form('Pagamento confirmado — crie seu acesso','Sua compra já está paga. Cadastre e-mail, celular e senha para guardar seu acesso. Depois, você entra com e-mail e senha, sem pagar novamente.','Criar meu acesso');field('phone',true);field('confirm',true);$('passwordLabel').querySelector('input').autocomplete='new-password';link('Já tenho conta · entrar','/login?order='+encodeURIComponent(pending.payment.orderId));
 }else if(path==='/esqueci-senha'){
  form('Vamos recuperar seu acesso','Informe o e-mail usado na sua conta. Enviaremos as instruções para criar uma nova senha.','Enviar instruções');field('password',false);link('Voltar para entrar','/login');
 }else if(path==='/redefinir-senha'){
  if(!recoveryToken)throw Error('Abra o link de recuperação enviado ao seu e-mail.');
  form('Sua nova senha','Escolha uma senha com pelo menos 8 caracteres.','Salvar nova senha');field('email',false);field('confirm',true);$('passwordLabel').querySelector('input').autocomplete='new-password';
 }else{form('Entrar','Acesse sua conta para ver seu conteúdo.','Entrar');link('Esqueci minha senha','/esqueci-senha');}
})().catch(e=>{$('intro').textContent='';$('message').textContent=e.message;link('Voltar ao perfil','/');link('Entrar na minha conta','/login');});
$('accountForm').onsubmit=async e=>{
 e.preventDefault();$('submit').disabled=true;$('message').textContent='Só um instante…';const body=Object.fromEntries(new FormData(e.target));
 try{
  if(path==='/esqueci-senha'){const d=await post('recover',body);$('message').textContent=d.message;return;}
  if(path==='/redefinir-senha'){await post('reset',{...body,accessToken:recoveryToken});recoveryToken=null;location.replace('/login');return;}
  let purchase=claim();
  if(path!=='/criar-acesso'&&purchase.orderId){const r=await fetch('/api/orders/'+purchase.orderId+'/status',{headers:{Authorization:'Bearer '+purchase.claimToken}});const state=await r.json();if(!r.ok||!state.needsClaim)purchase={};}
  const d=await post(path==='/criar-acesso'?'register':'login',{...body,...purchase});
  if(d.confirmEmail){$('message').textContent=d.message;e.target.reset();return;}
  if(purchase.orderId)clearClaim();location.replace('/meu-acesso');
 }catch(e){$('message').textContent=e.message;}finally{$('submit').disabled=false;}
};
