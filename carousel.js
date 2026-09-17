/* ==========================================================================
   CARROSSEL DE MÍDIAS.

   Uma publicação pode ter uma mídia só — e aí nada muda: nem seta, nem ponto,
   nem contador aparecem, e o cartão fica idêntico ao que sempre foi. A partir
   de duas, o mesmo cartão ganha swipe, setas no desktop e o indicador 1/4.

   A rolagem é a do próprio navegador (`scroll-snap`), não uma simulação em
   JavaScript: o swipe sai natural no celular, com a inércia e o "encaixe" que
   a pessoa já conhece, e continua funcionando com o teclado e com leitor de
   tela. As setas só empurram o mesmo scroll — elas não bloqueiam o arrasto.

   VÍDEO

   Só o slide visível toca. Ao trocar de slide o anterior pausa, então nunca
   existem dois vídeos tocando ao mesmo tempo. E nada é baixado antes da hora:
   o primeiro slide pede `metadata`, os outros ficam em `none` até chegarem
   perto — no celular isso é a diferença entre abrir o feed e baixar o feed.

   Este arquivo NÃO decide o que pode ser mostrado. Ele recebe os slides já
   prontos de quem sabe disso: no /vip, links assinados por item; na HOME,
   somente derivadas seguras.
   ========================================================================== */

(function carousel(global) {
  /** Quantos slides adiante já podem começar a carregar. */
  const LOOKAHEAD = 1;

  function arrow(direction, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'car-arrow car-arrow-' + (direction < 0 ? 'prev' : 'next');
    button.setAttribute('aria-label', direction < 0 ? 'Mídia anterior' : 'Próxima mídia');
    button.innerHTML = direction < 0
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
    button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    return button;
  }

  /**
   * Monta o carrossel dentro de `box`.
   *
   * `slides` é uma lista de funções: cada uma recebe o elemento do slide e o
   * índice e desenha o que quiser lá dentro. `mount(index)` é chamado tarde —
   * só quando aquele slide entra no campo de visão — para não baixar tudo de
   * uma vez.
   *
   * Devolve `{ element, count, go, destroy }`.
   */
  function build(box, slides, options = {}) {
    const count = slides.length;
    box.classList.add('car');
    const track = document.createElement('div');
    track.className = 'car-track';
    track.setAttribute('role', 'group');
    track.setAttribute('aria-label', `Carrossel com ${count} mídias`);

    const cells = slides.map((_, index) => {
      const cell = document.createElement('div');
      cell.className = 'car-cell';
      cell.dataset.index = String(index);
      track.append(cell);
      return cell;
    });
    box.append(track);

    // Uma mídia: sem controle nenhum. O cartão fica como sempre foi.
    if (count < 2) {
      box.classList.add('car-single');
      slides[0](cells[0], 0);
      return { element: track, count, go: () => {}, destroy: () => {} };
    }
    box.classList.add('car-many');

    /* --------------------------------------------------------- indicador */
    const status = document.createElement('div');
    status.className = 'car-count';
    status.setAttribute('aria-live', 'polite');
    const dots = document.createElement('div');
    dots.className = 'car-dots';
    dots.setAttribute('aria-hidden', 'true');
    const bullets = slides.map(() => {
      const dot = document.createElement('span');
      dot.className = 'car-dot';
      dots.append(dot);
      return dot;
    });

    let current = 0;
    const mounted = new Set();
    function mount(index) {
      if (index < 0 || index >= count || mounted.has(index)) return;
      mounted.add(index);
      slides[index](cells[index], index);
    }
    function paint() {
      status.textContent = `${current + 1}/${count}`;
      bullets.forEach((dot, index) => dot.classList.toggle('is-on', index === current));
      prev.disabled = current === 0;
      next.disabled = current === count - 1;
      // Carrega o vizinho antes de ele aparecer, mas nunca o feed inteiro.
      for (let step = 0; step <= LOOKAHEAD; step++) { mount(current + step); mount(current - step); }
      // Nunca dois vídeos ao mesmo tempo: o que sai de cena para.
      cells.forEach((cell, index) => {
        cell.querySelectorAll('video').forEach(video => {
          if (index === current) options.onEnter?.(video, index);
          else if (!video.paused) video.pause();
        });
      });
      options.onChange?.(current);
    }

    const go = index => {
      const target = Math.max(0, Math.min(count - 1, index));
      cells[target].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    };
    const prev = arrow(-1, () => go(current - 1));
    const next = arrow(1, () => go(current + 1));

    // Quem manda no slide atual é o scroll de verdade, venha ele do dedo, das
    // setas ou do teclado — assim as três formas nunca discordam.
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const index = Number(visible.target.dataset.index);
      if (index === current) return;
      current = index;
      paint();
    }, { root: track, threshold: [0.5, 0.75] });
    cells.forEach(cell => observer.observe(cell));

    const controls = document.createElement('div');
    controls.className = 'car-controls';
    controls.append(prev, next);
    box.append(controls, status, dots);

    mount(0);
    paint();

    return {
      element: track,
      count,
      go,
      destroy: () => observer.disconnect()
    };
  }

  global.AylaCarousel = { build };
})(window);
