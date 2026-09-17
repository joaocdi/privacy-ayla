// Loaded only by authenticated editors. Canvas normalizes EXIF orientation and
// strips metadata; full aspect ratio stays unchanged so relative crops survive.
(function (root) {
  const optimizedProfiles = new WeakSet();
  async function profile(file, role) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const avatar = role === 'avatar', limit = avatar ? 25 * 1024 : 150 * 1024;
      let scale = Math.min(1, avatar ? 320 / Math.max(img.naturalWidth, img.naturalHeight) : 1280 / img.naturalWidth);
      const canvas = document.createElement('canvas');
      for (let attempt = 0; attempt < 8; attempt++) {
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const quality of [avatar ? .8 : .78, .7, .6, .5]) {
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
          if (blob && blob.size <= limit) { const result = new File([blob], role + (blob.type === 'image/webp' ? '.webp' : '.png'), { type: blob.type }); optimizedProfiles.add(result); return result; }
        }
        scale *= .85;
      }
      throw new Error('Não foi possível otimizar esta imagem. Escolha outra imagem.');
    } finally { URL.revokeObjectURL(url); }
  }
  function preview(source, width, height) {
    // 160x200 com desfoque leve: dá noção da foto sem entregar o conteúdo.
    const W = 160, H = 200;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const context = canvas.getContext('2d');
    context.fillStyle = '#111'; context.fillRect(0, 0, W, H);
    // Overscan keeps blur kernels away from transparent edges.
    const scale = Math.max(W * 1.2 / width, H * 1.2 / height);
    context.filter = 'blur(2px)';
    context.drawImage(source, (W - width * scale) / 2, (H - height * scale) / 2, width * scale, height * scale);
    return canvas.toDataURL('image/jpeg', .72);
  }
  // Optimize once per File, including resumable uploads. Preserve relative crop.
  const postCache = new WeakMap();
  async function post(file) {
    if (optimizedProfiles.has(file)) return file;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    if (postCache.has(file)) return postCache.get(file);
    const task = (async () => {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image(); img.src = url; await img.decode();
        let scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        for (let attempt=0; attempt<7; attempt++) {
          canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
          canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
          const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
          for(const quality of [.84,.76,.68]) {
            const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
            if(blob && blob.size<=450*1024) return new File([blob],file.name.replace(/\.[^.]+$/,'')+(blob.type==='image/webp'?'.webp':'.png'),{type:blob.type});
          }
          scale*=.85;
        }
        throw new Error('Esta foto não pôde ser otimizada. Escolha uma versão menor.');
      } finally { URL.revokeObjectURL(url); }
    })();
    postCache.set(file,task);return task;
  }
  root.AylaImageTools = { profile, preview, post };
})(window);
