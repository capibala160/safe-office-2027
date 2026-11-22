'use strict';

(function () {
  const initialAngle = -0.58;
  const particleColors = ['#baf4ff', '#5de0ff', '#8e9dff'];
  const particleLimit = 96;
  const floor = [
    [-6, -4, 0, 0.5, '#dce8f5', '开放工位'],
    [0, -4, 6, 0.5, '#d6efed', '会议室'],
    [-6, 0.5, 0, 4, '#ede6f5', '休息区'],
    [0, 0.5, 6, 4, '#f7ead9', '前台'],
  ];

  function box(xPos, zPos, bottom, width, length, height, sides) {
    return { xPos, zPos, bottom, width, length, height, sides };
  }

  const white = ['#ffffff', '#dbe5f0', '#bdccdf'];
  const wood = ['#e7c399', '#cda274', '#b48760'];
  const steel = ['#718aad', '#4c668a', '#344c6a'];
  const screen = ['#b8e9ff', '#4076ab', '#244765'];
  const greenery = ['#68c8a5', '#309981', '#257466'];
  const glass = ['#d3f8f7', '#a9dcd9', '#86bbb8'];
  const furniture = [
    box(3.25, -2.35, 0, 0.36, 0.72, 0.69, steel),
    box(3.25, -2.35, 0.69, 2.45, 1.05, 0.13, white),
    box(5.64, -2.1, 0, 0.12, 1.7, 1.05, glass),
    box(3.2, -3.78, 0, 2.45, 0.12, 1.12, glass),
    box(3.2, -3.65, 0.58, 1.55, 0.12, 0.42, screen),
    box(-4.56, 2.7, 0, 2.15, 0.74, 0.37, ['#b9acd9', '#9281bc', '#746399']),
    box(-4.56, 3.02, 0.37, 2.15, 0.18, 0.48, ['#b9acd9', '#9281bc', '#746399']),
    box(-4.48, 1.6, 0, 1.15, 0.47, 0.36, white),
    box(3.6, 2.2, 0, 2.15, 0.66, 0.95, wood),
    box(3.6, 2.2, 0.95, 2.25, 0.72, 0.11, white),
    box(3.75, 2.24, 1.06, 0.48, 0.14, 0.29, screen),
  ];

  for (const deskX of [-4.3, -2.55]) {
    for (const deskZ of [-2.9, -1.35]) {
      furniture.push(
        box(deskX - 0.46, deskZ, 0, 0.12, 0.6, 0.68, steel),
        box(deskX + 0.46, deskZ, 0, 0.12, 0.6, 0.68, steel),
        box(deskX, deskZ, 0.68, 1.16, 0.76, 0.12, wood),
        box(deskX, deskZ - 0.23, 0.8, 0.51, 0.12, 0.31, screen),
        box(deskX, deskZ + 0.65, 0, 0.42, 0.42, 0.45, steel),
      );
    }
  }

  for (const chairX of [2.5, 3.25, 4]) {
    for (const chairZ of [-3.13, -1.56]) {
      furniture.push(box(chairX, chairZ, 0, 0.43, 0.4, 0.5, steel));
    }
  }

  for (const [plantX, plantZ] of [[-5.52, -3.45], [-5.42, 3.56], [5.33, 3.4], [5.3, -3.47], [-0.37, 3.56]]) {
    furniture.push(
      box(plantX, plantZ, 0, 0.34, 0.34, 0.37, white),
      box(plantX, plantZ, 0.37, 0.14, 0.14, 0.38, wood),
      box(plantX, plantZ, 0.59, 0.44, 0.43, 0.44, greenery),
    );
  }

  const people = [
    { colors: ['#86a9ff', '#4979ef', '#3455b4'], speed: 1.22, offset: 1.5,
      stops: [[-1.35, -3.25], [-1.35, 0.05], [1.35, 0.05], [1.35, -3.18]] },
    { colors: ['#ffcc8f', '#ee9a57', '#c67743'], speed: 1.05, offset: 4,
      stops: [[1.55, 3.36], [1.55, 0.52], [-1.85, 0.52], [-1.85, 2.83]] },
    { colors: ['#81ebcf', '#3ab99c', '#288570'], speed: 0.92, offset: 3,
      stops: [[-5.28, 0.14], [-0.38, 0.14], [-0.38, -3.25]] },
    { colors: ['#e2baff', '#b481eb', '#8558bb'], speed: 0.99, offset: 6,
      stops: [[5.24, 1.04], [2.1, 1.04], [2.1, -0.87], [4.98, -0.87]] },
  ].map((person) => {
    const loop = person.stops.concat(person.stops.slice(1, -1).reverse());
    const segments = loop.map(([fromX, fromZ], index) => {
      const [toX, toZ] = loop[(index + 1) % loop.length];
      const deltaX = toX - fromX;
      const deltaZ = toZ - fromZ;
      const distance = Math.hypot(deltaX, deltaZ);
      return { fromX, fromZ, deltaX, deltaZ, distance };
    });
    return { ...person, segments, length: segments.reduce((total, segment) => total + segment.distance, 0) };
  });

  function locate(person, elapsed) {
    let remaining = (elapsed * person.speed + person.offset) % person.length;
    for (const segment of person.segments) {
      if (remaining < segment.distance) {
        const fraction = remaining / segment.distance;
        return {
          xPos: segment.fromX + segment.deltaX * fraction,
          zPos: segment.fromZ + segment.deltaZ * fraction,
          headingX: segment.deltaX / segment.distance,
          headingZ: segment.deltaZ / segment.distance,
        };
      }
      remaining -= segment.distance;
    }
  }

  function personBoxes(person, position, elapsed) {
    const { xPos, zPos, headingX, headingZ } = position;
    const phase = (elapsed * person.speed + person.offset) * 8.6;
    const stride = Math.sin(phase) * 0.16;
    const bob = Math.abs(Math.cos(phase)) * 0.045;
    const skin = ['#ffdfc0', '#edb78e', '#cc9779'];
    const hair = ['#6b514d', '#533c42', '#403138'];
    const parts = [
      box(xPos, zPos, 0.58 + bob, 0.3, 0.27, 0.37, person.colors),
      box(xPos, zPos, 0.95 + bob, 0.25, 0.23, 0.23, skin),
      box(xPos - headingX * 0.035, zPos - headingZ * 0.035, 1.13 + bob, 0.25, 0.24, 0.08, hair),
    ];
    for (const side of [-1, 1]) {
      const armX = xPos + side * (-headingZ * 0.19 - headingX * stride * 0.65);
      const armZ = zPos + side * (headingX * 0.19 - headingZ * stride * 0.65);
      parts.push(
        box(xPos + side * (-headingZ * 0.079 + headingX * stride),
          zPos + side * (headingX * 0.079 + headingZ * stride), Math.max(0, side * Math.cos(phase)) * 0.11,
          0.118, 0.118, 0.59, steel),
        box(armX, armZ, 0.63 + bob, 0.092, 0.092, 0.26, person.colors),
        box(armX, armZ, 0.55 + bob, 0.092, 0.092, 0.08, skin),
      );
    }
    return parts;
  }

  function draw(context, width, height, angle, zoom, elapsed) {
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const scale = Math.min(width / 15.8, height / 10.3) * zoom;
    const pitch = 0.58;
    const lift = Math.sqrt(1 - pitch ** 2);
    const project = ([xPos, elevation, zPos]) => {
      const depth = xPos * sine + zPos * cosine;
      return [width / 2 + (xPos * cosine - zPos * sine) * scale,
        height / 2 + (depth * pitch - elevation * lift) * scale,
        depth * lift + elevation * pitch];
    };
    const paint = (points, color) => {
      context.beginPath();
      points.forEach(([screenX, screenY], index) => {
        if (index === 0) context.moveTo(screenX, screenY);
        else context.lineTo(screenX, screenY);
      });
      context.closePath();
      context.fillStyle = color;
      context.fill();
    };
    const quad = (left, back, right, front, elevation = 0) => [
      [left, elevation, back], [right, elevation, back], [right, elevation, front], [left, elevation, front],
    ];
    const faces = [];
    function addBox(object) {
      const { xPos, zPos, width: boxWidth, length, bottom, height: boxHeight, sides } = object;
      const left = xPos - boxWidth / 2;
      const right = xPos + boxWidth / 2;
      const back = zPos - length / 2;
      const front = zPos + length / 2;
      const lower = quad(left, back, right, front, bottom).map(project);
      const upper = quad(left, back, right, front, bottom + boxHeight).map(project);
      function face(points, color) {
        const depth = points.reduce((sum, point) => sum + point[2], 0) / points.length;
        faces.push({ points, color, depth });
      }
      const zSide = cosine >= 0 ? [2, 3] : [0, 1];
      const xSide = sine >= 0 ? [1, 2] : [3, 0];
      for (const [[start, end], color] of [[zSide, sides[1]], [xSide, sides[2]]]) {
        face([lower[start], lower[end], upper[end], upper[start]], color);
      }
      face(upper, sides[0]);
    }

    context.clearRect(0, 0, width, height);
    addBox(box(0, 0, -0.39, 12.28, 8.28, 0.38, ['#a9bfd2', '#809bb9', '#647f9e']));
    faces.sort((first, second) => first.depth - second.depth);
    faces.forEach(({ points, color }) => paint(points, color));
    faces.length = 0;
    for (const [left, back, right, front, color] of floor) {
      paint(quad(left + 0.035, back + 0.035, right - 0.035, front - 0.035).map(project), color);
    }
    const positions = people.map((person) => locate(person, elapsed));
    const shadows = positions.concat(furniture.filter(({ bottom }) => bottom === 0));
    for (const shadow of shadows) {
      const sizeX = (shadow.width || 0.44) / 2 + 0.07;
      const sizeZ = (shadow.length || 0.44) / 2 + 0.06;
      const points = Array.from({ length: 16 }, (_, index) => {
        const turn = index * Math.PI / 8;
        return project([shadow.xPos + Math.cos(turn) * sizeX, 0, shadow.zPos + Math.sin(turn) * sizeZ]);
      });
      paint(points, '#28405e1a');
    }
    furniture.forEach(addBox);
    people.forEach((person, index) => personBoxes(person, positions[index], elapsed).forEach(addBox));
    faces.sort((first, second) => first.depth - second.depth);
    faces.forEach(({ points, color }) => paint(points, color));
  }

  function mount(root) {
    const scene = document.createElement('section');
    scene.className = 'office-scene';
    scene.innerHTML = `
      <div class="office-stage">
        <canvas tabindex="0" aria-label="可旋转的三维办公楼层" aria-describedby="office-controls-help"></canvas>
        <p class="office-unavailable" hidden>当前浏览器无法绘制三维办公场景。</p>
        <ul class="office-legend" aria-label="办公区域">${floor.map((area) => `<li>${area[5]}</li>`).join('')}</ul>
      </div>
      <div class="office-toolbar">
        <div class="btn-row" aria-label="场景控制">
          <button class="btn" type="button" data-office="play">暂停走动</button>
          <button class="btn ghost" type="button" data-office="particles" aria-pressed="true">粒子特效</button>
          <button class="btn ghost" type="button" data-office="left" aria-label="向左旋转">↶</button>
          <button class="btn ghost" type="button" data-office="right" aria-label="向右旋转">↷</button>
          <button class="btn ghost" type="button" data-office="out" aria-label="缩小">−</button>
          <button class="btn ghost" type="button" data-office="in" aria-label="放大">＋</button>
          <button class="btn ghost" type="button" data-office="reset">重置视角</button>
        </div>
        <p id="office-controls-help">拖动旋转，方向键和 ＋／− 调整视角，点击或按回车触发粒子。</p>
      </div>`;
    root.append(scene);
    const canvas = scene.querySelector('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      canvas.hidden = true;
      scene.querySelector('.office-unavailable').hidden = false;
      scene.querySelector('.office-toolbar').hidden = true;
      return;
    }

    const play = scene.querySelector('[data-office="play"]');
    const particleButton = scene.querySelector('[data-office="particles"]');
    let playing = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let effectsEnabled = playing;
    let particles = [];
    let trailTime = -Infinity;
    let angle = initialAngle;
    let zoom = 1;
    let elapsed = 0;
    let previous = null;
    let frame = 0;
    let drag = null;

    function render() {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * ratio);
      const pixelHeight = Math.round(height * ratio);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(context, width, height, angle, zoom, elapsed);
      for (const particle of particles) {
        const opacity = 1 - particle.age / particle.lifetime;
        const screenX = particle.originX + particle.velocityX * particle.age;
        const screenY = particle.originY + particle.velocityY * particle.age;
        const radius = particle.radius * (0.55 + opacity * 0.45);
        context.fillStyle = particle.color;
        context.globalAlpha = opacity * 0.22;
        context.beginPath();
        context.arc(screenX, screenY, radius * 2.6, 0, Math.PI * 2);
        context.fill();
        context.globalAlpha = opacity * 0.95;
        context.beginPath();
        context.arc(screenX, screenY, radius, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    }

    function animate(now) {
      frame = 0;
      if (!scene.isConnected) return;
      const step = previous === null ? 0 : Math.min((now - previous) / 1000, 0.05);
      if (playing) elapsed += step;
      previous = now;
      for (const particle of particles) particle.age += step;
      particles = particles.filter((particle) => particle.age < particle.lifetime);
      render();
      syncFrame();
    }

    function syncFrame() {
      if (playing || particles.length) {
        if (!frame) frame = requestAnimationFrame(animate);
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        previous = null;
      }
    }

    function emitParticles(originX, originY, burst) {
      if (!effectsEnabled) return;
      const count = burst ? 24 : 3;
      const baseAngle = Math.random() * Math.PI * 2;
      for (let index = 0; index < count; index += 1) {
        const direction = baseAngle + index / count * Math.PI * 2;
        const speed = burst ? 45 + Math.random() * 135 : 12 + Math.random() * 32;
        particles.push({
          originX, originY,
          velocityX: Math.cos(direction) * speed,
          velocityY: Math.sin(direction) * speed,
          color: particleColors[index % particleColors.length],
          radius: 1.1 + Math.random() * 1.9,
          age: 0,
          lifetime: burst ? 0.4 + Math.random() * 0.38 : 0.28 + Math.random() * 0.25,
        });
      }
      if (particles.length > particleLimit) particles.splice(0, particles.length - particleLimit);
      syncFrame();
    }

    function emitAtPointer(event, burst) {
      const bounds = canvas.getBoundingClientRect();
      emitParticles(event.clientX - bounds.left, event.clientY - bounds.top, burst);
    }

    function control(action) {
      if (action === 'play') {
        playing = !playing;
        play.textContent = playing ? '暂停走动' : '继续走动';
        syncFrame();
      } else if (action === 'particles') {
        effectsEnabled = !effectsEnabled;
        particleButton.setAttribute('aria-pressed', String(effectsEnabled));
        if (!effectsEnabled) particles = [];
        syncFrame();
      } else if (action === 'reset') {
        angle = initialAngle;
        zoom = 1;
      } else if (action === 'left' || action === 'right') {
        angle += action === 'left' ? -0.26 : 0.26;
      } else {
        zoom = Math.max(0.65, Math.min(1.8, zoom + (action === 'in' ? 0.15 : -0.15)));
      }
      render();
    }

    scene.querySelector('.office-toolbar').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-office]');
      if (button) control(button.dataset.office);
    });
    canvas.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        if (!event.repeat) emitParticles(canvas.clientWidth / 2, canvas.clientHeight / 2, true);
        return;
      }
      const action = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'in', ArrowDown: 'out', '+': 'in', '=': 'in', '-': 'out' }[event.key];
      if (!action) return;
      event.preventDefault();
      control(action);
    });
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || drag) return;
      drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, angle, moved: false };
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (drag?.pointer === event.pointerId) {
        const shift = event.clientX - drag.startX;
        if (Math.hypot(shift, event.clientY - drag.startY) >= 5) drag.moved = true;
        if (drag.moved) {
          angle = drag.angle + shift * 0.012;
          render();
        }
      }
      if (effectsEnabled && event.pointerType === 'mouse' && event.timeStamp - trailTime >= 32) {
        trailTime = event.timeStamp;
        emitAtPointer(event, false);
      }
    });
    canvas.addEventListener('pointerup', (event) => {
      if (drag?.pointer !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) {
        emitAtPointer(event, true);
      }
    });
    canvas.addEventListener('lostpointercapture', (event) => {
      if (drag?.pointer === event.pointerId) drag = null;
    });
    const resize = new ResizeObserver(render);
    resize.observe(canvas);
    const detach = new MutationObserver(() => {
      if (scene.isConnected) return;
      resize.disconnect();
      detach.disconnect();
      cancelAnimationFrame(frame);
    });
    detach.observe(root, { childList: true });
    play.textContent = playing ? '暂停走动' : '继续走动';
    particleButton.setAttribute('aria-pressed', String(effectsEnabled));
    render();
    syncFrame();
  }

  window.OfficeScene = { mount };
})();
