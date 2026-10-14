(() => {
  'use strict';

  // Nome sulla busta: modificalo qui oppure usa ?nome=Giulia nell'URL
  const NOME = new URLSearchParams(location.search).get('nome') || 'Giulia Miele';

  // Geometria della linea di taglio (unità del viewBox SVG)
  const LINE_Y = 58, START_X = 40, END_X = 360;
  const SLIP = 20;          // oltre questa distanza dalla linea il taglio si interrompe
  const GRAB_R = 26;        // raggio del cerchio da cui (ri)partire
  const AHEAD = 50;         // salto massimo in avanti consentito
  const PEEK = 36;          // quanto spunta la lettera dopo il taglio
  const PULL_OUT = 110;     // quanto tirarla perché esca del tutto
  // Su touch la punta sta sopra al dito, così il dito non copre la linea
  const TOUCH_OFFSET = { x: 28, y: -40 };

  const $ = s => document.querySelector(s);
  const svg = $('#envelope'), tool = $('#tool'), rest = $('#rest'), stage = $('#stage');
  const cutEl = $('#cut'), guide = $('#guide'), marker = $('#marker'), letter = $('#letter');
  const hintEl = $('#hint'), reader = $('#reader'), fold = $('#fold'), paper = $('#paper');

  const S = {
    phase: 'grab',          // grab → cut → opening → pull → read
    pressed: false,
    cutting: false,
    cutX: START_X,
    pts: [`${START_X},${LINE_Y}`],
    lastCut: 0,
    pullStart: 0,
    pullOff: 0,
  };

  // ---------- Suoni (sintetizzati, nessun file) ----------
  const Sfx = {
    ctx: null,
    init() {
      if (this.ctx) return this.ctx.resume();
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      const ctx = this.ctx = new C();
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.7;
      this.noise = ctx.createGain();
      this.noise.gain.value = 0;
      src.connect(bp).connect(this.noise).connect(ctx.destination);
      src.start();
    },
    rustle(level) {
      if (this.ctx) this.noise.gain.setTargetAtTime(level, this.ctx.currentTime, 0.03);
    },
    tone(freq, dur, vol = 0.12, when = 0) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + when;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur);
    },
    tick() { this.tone(880, 0.08, 0.08); },
    soft() { this.tone(220, 0.15, 0.08); },
    chime() { [659, 784, 988].forEach((f, i) => this.tone(f, 0.5, 0.1, i * 0.12)); },
  };

  // ---------- UI ----------
  function hint(text, el = hintEl) {
    if (el.dataset.text === text) return;
    el.dataset.text = text;
    el.classList.add('swap');
    setTimeout(() => { el.textContent = text; el.classList.remove('swap'); }, 200);
  }
  function setStep(i) {
    document.querySelectorAll('.steps span').forEach((d, j) => d.classList.toggle('on', j <= i));
  }

  // ---------- Tagliacarte ----------
  function placeTool(tipX, tipY, angle) {
    const w = tool.offsetWidth, h = tool.offsetHeight;
    tool.style.left = `${tipX - w}px`;
    tool.style.top = `${tipY - h / 2}px`;
    tool.style.transform = `rotate(${angle}deg)`;
  }
  function parkTool() {
    const r = rest.getBoundingClientRect();
    tool.classList.remove('idle');
    placeTool(r.left + r.width / 2 + tool.offsetWidth / 2, r.top + r.height / 2, -4);
    requestAnimationFrame(() => tool.classList.add('idle'));
  }
  function tipOf(e) {
    const off = e.pointerType === 'mouse' ? { x: 0, y: 0 } : TOUCH_OFFSET;
    return { x: e.clientX + off.x, y: e.clientY + off.y };
  }
  function toSvg(x, y) {
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  function showMarker(on) {
    marker.setAttribute('cx', S.cutX);
    marker.style.display = on ? '' : 'none';
  }

  // ---------- Passo 2: taglio ----------
  function interrupt(text) {
    S.cutting = false;
    Sfx.rustle(0);
    showMarker(true);
    hint(text);
  }

  function slip() {
    interrupt('Resta sulla linea · riparti dal cerchio');
    Sfx.soft();
    navigator.vibrate?.(60);
    stage.classList.remove('shake');
    void stage.getBoundingClientRect();
    stage.classList.add('shake');
  }

  function handleCut(e) {
    const t = tipOf(e);
    tool.classList.remove('idle');
    placeTool(t.x, t.y, S.cutting ? -14 : -24);
    if (!S.pressed) return;

    const p = toSvg(t.x, t.y);
    const dx = p.x - S.cutX, dy = p.y - LINE_Y;

    if (!S.cutting) {
      if (Math.hypot(dx, dy) <= GRAB_R) {
        S.cutting = true;
        showMarker(false);
        Sfx.tick();
        hint('Segui la linea');
      }
      return;
    }

    if (Math.abs(dy) > SLIP) return slip();
    if (dx > AHEAD) return interrupt('Più piano · riparti dal cerchio');
    if (dx <= 0) return;

    const nx = Math.min(END_X, p.x);
    const step = nx - S.cutX;
    S.cutX = nx;
    S.pts.push(`${nx.toFixed(1)},${(LINE_Y + Math.max(-5, Math.min(5, dy * 0.5))).toFixed(1)}`);
    cutEl.setAttribute('points', S.pts.join(' '));
    guide.setAttribute('x1', S.cutX);
    Sfx.rustle(Math.min(0.35, 0.1 + step * 0.04));
    S.lastCut = performance.now();

    if (S.cutX >= END_X) cutDone();
  }

  function cutDone() {
    S.phase = 'opening';
    S.cutting = S.pressed = false;
    Sfx.rustle(0);
    Sfx.tick();
    document.body.classList.remove('mouse-hold');
    tool.classList.remove('holding');
    tool.classList.add('idle', 'gone');
    svg.classList.add('opened');
    hint('');
    setTimeout(() => {
      setLetter(-PEEK);
      S.phase = 'pull';
      setStep(2);
      hint('Tira fuori la lettera ↑');
    }, 900);
  }

  // ---------- Passo 3: estrai la lettera ----------
  function setLetter(y) {
    letter.style.transform = `translateY(${y}px)`;
  }

  function startPull(e) {
    S.pressed = true;
    S.pullStart = toSvg(e.clientX, e.clientY).y;
    S.pullOff = 0;
    letter.classList.add('dragging');
  }

  function movePull(e) {
    const y = toSvg(e.clientX, e.clientY).y;
    const off = Math.max(0, Math.min(PULL_OUT + 20, S.pullStart - y));
    Sfx.rustle(Math.abs(off - S.pullOff) > 0.5 ? 0.12 : 0);
    S.lastCut = performance.now();
    S.pullOff = off;
    setLetter(-PEEK - off);
    if (off >= PULL_OUT) pullDone();
  }

  function endPull() {
    letter.classList.remove('dragging');
    setLetter(-PEEK);
    if (S.pullOff > 15) hint('Ancora un po’ più su ↑');
  }

  function pullDone() {
    S.phase = 'read';
    S.pressed = false;
    Sfx.rustle(0);
    letter.classList.remove('dragging');
    setLetter(-320);
    letter.style.opacity = '0';
    svg.classList.add('away');
    hint('');
    setTimeout(openReader, 800);
  }

  // ---------- Passo 4: apri e leggi ----------
  function openReader() {
    setStep(3);
    // Ogni pannello mostra un terzo della stessa lettera
    fold.querySelectorAll('.front').forEach(f => {
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.innerHTML = paper.innerHTML;
      f.appendChild(sheet);
    });
    reader.hidden = false;
    Sfx.chime();
    fold.addEventListener('click', unfold, { once: true });
  }

  function unfold() {
    Sfx.tick();
    fold.classList.remove('folded');
    hint('', $('#readHint'));
    setTimeout(() => Sfx.tick(), 450);
    setTimeout(() => {
      paper.classList.add('show');
      fold.querySelectorAll('.panel').forEach(p => p.remove());
      fold.style.cursor = 'auto';
      // Aggancio per eventuali passi successivi (es. popup dell'immagine)
      window.dispatchEvent(new CustomEvent('lettera-aperta'));
    }, 1300);
  }

  // ---------- Input ----------
  window.addEventListener('pointerdown', e => {
    Sfx.init();
    if (S.phase === 'grab') {
      if (!e.target.closest('#tool')) return;
      S.phase = 'cut';
      setStep(1);
      Sfx.tick();
      hint('Appoggia la punta sul cerchio');
    }
    if (S.phase === 'cut') {
      S.pressed = true;
      tool.classList.add('holding');
      if (e.pointerType === 'mouse') document.body.classList.add('mouse-hold');
      handleCut(e);
    } else if (S.phase === 'pull') {
      startPull(e);
    }
  });

  window.addEventListener('pointermove', e => {
    if (S.phase === 'cut') {
      // Col mouse il tagliacarte segue il cursore anche senza premere
      if (S.pressed || e.pointerType === 'mouse') handleCut(e);
    } else if (S.phase === 'pull' && S.pressed) {
      movePull(e);
    }
  });

  function release() {
    if (!S.pressed) return;
    S.pressed = false;
    Sfx.rustle(0);
    if (S.phase === 'pull') return endPull();
    if (S.cutting) interrupt('Riprendi dal cerchio');
  }
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  window.addEventListener('contextmenu', e => e.preventDefault());

  // Silenzia il fruscio quando ci si ferma
  (function loop() {
    if (S.lastCut && performance.now() - S.lastCut > 80) {
      Sfx.rustle(0);
      S.lastCut = 0;
    }
    requestAnimationFrame(loop);
  })();

  window.addEventListener('resize', () => {
    if (S.phase === 'grab') parkTool();
  });

  // ---------- Avvio ----------
  const nameEl = $('#addrName');
  nameEl.textContent = NOME;
  if (NOME.length > 11) nameEl.setAttribute('font-size', Math.max(22, 40 - (NOME.length - 11) * 2));
  document.querySelectorAll('#paper .nome').forEach(n => { n.textContent = NOME; });

  parkTool();
  document.fonts?.ready.then(parkTool);
})();
