(function(root) {
  const defaults = role => ({x:50,y:50,zoom:1,ratio:role==='avatar'?'1:1':role==='cover'?'2.44:1':'original'});
  const ratio = (crop,w,h) => crop.ratio==='original' ? (w && h ? w/h : 4/5) : crop.ratio==='4:5' ? 4/5 : crop.ratio==='2.44:1' ? 2.44 : 1;
  function geometry(crop,w,h,cw,ch) {
    const scale=Math.max(cw/w,ch/h)*crop.zoom;
    return {width:w*scale,height:h*scale,left:(cw-w*scale)*crop.x/100,top:(ch-h*scale)*crop.y/100};
  }
  function apply(media,value,options={}) {
    const crop={...defaults(options.role),...value};
    let box=options.box || media._cropBox;
    if (!box) {
      box=document.createElement('span');box.className='crop-frame';
      if(options.role==='avatar') {
        const css=getComputedStyle(media);
        box.style.width=/^[1-9][0-9.]*px$/.test(css.width)?css.width:'32px';
        box.style.height=box.style.width;box.style.borderRadius='50%';box.style.flexShrink='0';
      } else { box.style.width='100%'; }
      media.before(box);box.append(media);media._cropBox=box;
    }
    box.classList.add('crop-frame');
    media._cropValue=crop;
    const draw=()=>{
      const c=media._cropValue,w=media.naturalWidth||media.videoWidth||4,h=media.naturalHeight||media.videoHeight||5;
      box.style.aspectRatio=String(options.preview ? 4/5 : ratio(c,w,h));
      if(options.role!=='avatar') {box.style.height='auto';box.style.minHeight='0';}
      const g=geometry(c,w,h,box.clientWidth,box.clientHeight);
      for(const [k,v]of Object.entries(g))media.style.setProperty(k,v+'px','important');
      media.style.setProperty('position','absolute','important');
      media.style.setProperty('max-width','none','important');media.style.setProperty('max-height','none','important');
      media.style.setProperty('transform',options.preview && media.tagName==='IMG'?'scale(1.2)':'none','important');media.style.setProperty('border-radius','0','important');
      media.style.setProperty('object-fit','fill','important');
    };
    if(media._cropDraw)media._cropObserver?.disconnect();
    media._cropDraw=draw;
    if(!media._cropEvents){media.addEventListener('load',()=>media._cropDraw());media.addEventListener('loadedmetadata',()=>media._cropDraw());media._cropEvents=true;}
    media._cropObserver=new ResizeObserver(draw);media._cropObserver.observe(box);draw();
    return box;
  }
  function editor(parent,{src,type='image',crop,role='post',label='Enquadramento'}) {
    let value={...defaults(role),...crop},url=null;
    const panel=document.createElement('section');panel.className='crop-editor';panel.setAttribute('aria-label',label);
    const heading=document.createElement('strong');heading.textContent=label;panel.append(heading);
    const viewport=document.createElement('div');viewport.className='crop-editor-view';panel.append(viewport);
    let element;
    const controls=document.createElement('div');controls.className='crop-controls';
    const select=document.createElement('select');select.setAttribute('aria-label','Proporção');
    for(const r of role==='post'?['original','4:5','1:1']:[defaults(role).ratio]){const o=document.createElement('option');o.value=r;o.textContent=r==='original'?'Original':r;select.append(o);}select.value=value.ratio;
    const slider=document.createElement('input');slider.type='range';slider.min='1';slider.max='4';slider.step='0.05';slider.setAttribute('aria-label','Zoom');
    const output=document.createElement('output');
    function draw(){slider.value=value.zoom;output.textContent=Number(value.zoom).toFixed(2)+'×';if(element)apply(element,value,{box:viewport,role});}
    function button(text,fn){const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',()=>{fn();draw();});return b;}
    controls.append(select,button('−',()=>value.zoom=Math.max(1,value.zoom-.1)),slider,button('+',()=>value.zoom=Math.min(4,value.zoom+.1)),output,
      button('Centralizar',()=>{value.x=50;value.y=50;}),button('Resetar',()=>{value=defaults(role);select.value=value.ratio;}));
    slider.addEventListener('input',()=>{value.zoom=Number(slider.value);draw();});select.addEventListener('change',()=>{value.ratio=select.value;draw();});
    panel.append(controls);parent.append(panel);
    let drag;
    viewport.addEventListener('pointerdown',e=>{if(!element)return;drag={x:e.clientX,y:e.clientY,crop:{...value}};viewport.setPointerCapture(e.pointerId);e.preventDefault();});
    viewport.addEventListener('pointermove',e=>{if(!drag)return;const w=element.naturalWidth||element.videoWidth||4,h=element.naturalHeight||element.videoHeight||5;
      const g=geometry(drag.crop,w,h,viewport.clientWidth,viewport.clientHeight);
      value.x=Math.max(0,Math.min(100,drag.crop.x-(e.clientX-drag.x)/Math.max(1,g.width-viewport.clientWidth)*100));
      value.y=Math.max(0,Math.min(100,drag.crop.y-(e.clientY-drag.y)/Math.max(1,g.height-viewport.clientHeight)*100));draw();});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(event,()=>drag=null);
    function setSource(next,nextType=type){element?._cropObserver?.disconnect();viewport.replaceChildren();
      // Sem arquivo ainda: aviso curto, nunca <img src=""> (ícone quebrado).
      if(!next){element=null;const vazio=document.createElement('p');vazio.className='crop-editor-empty';
        vazio.textContent='Escolha um arquivo para enquadrar.';viewport.append(vazio);return;}
      element=document.createElement(nextType==='video'?'video':'img');
      element.alt=label;element.draggable=false;if(nextType==='video'){element.muted=true;element.playsInline=true;element.preload='metadata';}
      element.src=next;viewport.append(element);draw();}
    setSource(src,type);
    return {get:()=>({...value}),setFile(file){if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(file);setSource(url,file.type.startsWith('video/')?'video':'image');},destroy(){element?._cropObserver?.disconnect();if(url)URL.revokeObjectURL(url);}};
  }
  const api={defaults,ratio,geometry,apply,editor};
  if(typeof module!=='undefined')module.exports=api;else root.AylaFrame=api;
})(typeof window!=='undefined'?window:globalThis);
