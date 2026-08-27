let ws = null;
let cameras = {};
let gridLayout = 4;
let currentLink = '';

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}?role=viewer`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe-all' }));
  };

  ws.onmessage = (event) => {
    // Прием бинарного видеокадра
    if (event.data instanceof ArrayBuffer) {
      renderBinaryFrame(event.data);
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {}
  };

  ws.onclose = () => setTimeout(connectWebSocket, 2000);
}

function renderBinaryFrame(buffer) {
  const view = new Uint8Array(buffer);
  const idLen = view[0];
  const cameraId = new TextDecoder().decode(view.subarray(1, 1 + idLen));
  const jpegBytes = view.subarray(1 + idLen);

  const canvas = document.getElementById(`canvas-${cameraId}`);
  if (!canvas) return;

  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
  createImageBitmap(blob).then(bitmap => {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    canvas.style.display = 'block';
    const ph = document.getElementById(`ph-${cameraId}`);
    if (ph) ph.style.display = 'none';

    const timeEl = document.getElementById(`time-${cameraId}`);
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString();
  }).catch(() => {});
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'camera-list':
      cameras = {};
      msg.cameras.forEach(c => cameras[c.id] = c);
      renderCameraList();
      renderGrid();
      ws.send(JSON.stringify({ type: 'subscribe-all' }));
      updateStats();
      break;

    case 'camera-online':
      cameras[msg.camera.id] = msg.camera;
      renderCameraList();
      renderGrid();
      ws.send(JSON.stringify({ type: 'subscribe-all' }));
      updateStats();
      break;

    case 'camera-offline':
    case 'camera-removed':
      if (cameras[msg.cameraId]) {
        cameras[msg.cameraId].status = 'offline';
        renderCameraList();
        const canvas = document.getElementById(`canvas-${msg.cameraId}`);
        if (canvas) canvas.style.display = 'none';
        const ph = document.getElementById(`ph-${msg.cameraId}`);
        if (ph) {
          ph.style.display = 'flex';
          ph.querySelector('span').textContent = 'Камера оффлайн';
        }
        updateStats();
      }
      break;
  }
}

function renderCameraList() {
  const list = document.getElementById('cameraList');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:20px"><p>Нет подключенных камер</p></div>`;
    return;
  }

  list.innerHTML = cams.map(c => `
    <div class="camera-item" onclick="focusCamera('${c.id}')">
      <div class="cam-status" style="background:${c.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></div>
      <div class="cam-info">
        <div class="cam-name">${escapeHtml(c.name)}</div>
        <div class="cam-location">${escapeHtml(c.location)}</div>
      </div>
      <div class="cam-actions">
        <button class="btn btn-sm btn-icon btn-danger" onclick="event.stopPropagation(); deleteCamera('${c.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

function renderGrid() {
  const grid = document.getElementById('viewGrid');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📹</div>
        <h3>Камеры не подключены</h3>
        <p>Создайте ссылку и откройте её на других устройствах</p>
        <button class="btn btn-primary" onclick="openGenerateLink()">+ Сгенерировать ссылку</button>
      </div>`;
    return;
  }

  const displayCams = cams.slice(0, gridLayout);

  grid.innerHTML = displayCams.map(cam => `
    <div class="video-cell" id="cell-${cam.id}" ondblclick="openFullscreen('${cam.id}')">
      <div class="video-cell-header">
        <div class="video-cell-name">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${cam.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></span>
          ${escapeHtml(cam.name)} (${escapeHtml(cam.location)})
        </div>
        <span class="badge ${cam.status === 'online' ? 'badge-live' : ''}">${cam.status === 'online' ? 'LIVE' : 'OFFLINE'}</span>
      </div>
      <div class="video-cell-body">
        <canvas id="canvas-${cam.id}" style="width:100%; height:100%; object-fit:contain; display:none;"></canvas>
        <div class="video-placeholder" id="ph-${cam.id}">
          <div class="ph-icon">📷</div>
          <span>${cam.status === 'online' ? 'Ожидание потока...' : 'Камера оффлайн'}</span>
        </div>
      </div>
      <div class="video-cell-footer">
        <button class="btn btn-sm" onclick="openFullscreen('${cam.id}')">⛶ На весь экран</button>
        <div class="video-cell-time" id="time-${cam.id}">--:--:--</div>
      </div>
    </div>
  `).join('');
}

function setGridLayout(n) {
  gridLayout = n;
  const grid = document.getElementById('viewGrid');
  grid.className = `view-grid grid-${n}`;
  const side = Math.sqrt(n) | 0;
  document.getElementById('gridInfo').textContent = `Сетка: ${side}×${side}`;
  renderGrid();
  ws.send(JSON.stringify({ type: 'subscribe-all' }));
}

function openFullscreen(cameraId) {
  const canvas = document.getElementById(`canvas-${cameraId}`);
  if (!canvas || canvas.style.display === 'none') return;
  const overlay = document.getElementById('fullscreenOverlay');
  const img = document.getElementById('fullscreenImg');
  img.src = canvas.toDataURL('image/jpeg');
  overlay.classList.add('open');
}

function closeFullscreen() {
  document.getElementById('fullscreenOverlay').classList.remove('open');
}

async function deleteCamera(cameraId) {
  if (!confirm('Удалить камеру из списка?')) return;
  await fetch(`/api/cameras/${cameraId}`, { method: 'DELETE' });
  delete cameras[cameraId];
  renderCameraList();
  renderGrid();
  updateStats();
}

function openGenerateLink() {
  document.getElementById('linkStep1').style.display = 'block';
  document.getElementById('linkStep2').style.display = 'none';
  document.getElementById('qrContainer').style.display = 'none';
  document.getElementById('linkModal').classList.add('open');
}

function closeLinkModal() {
  document.getElementById('linkModal').classList.remove('open');
}

async function generateLink() {
  const name = document.getElementById('linkName').value.trim() || 'Камера';
  const location = document.getElementById('linkLocation').value.trim() || 'Помещение';

  const resp = await fetch('/api/generate-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, location })
  });
  const data = await resp.json();
  currentLink = data.url;
  document.getElementById('linkResult').value = data.url;
  document.getElementById('linkStep1').style.display = 'none';
  document.getElementById('linkStep2').style.display = 'block';
}

function copyLink() {
  const input = document.getElementById('linkResult');
  input.select();
  navigator.clipboard.writeText(input.value);
  alert('Ссылка скопирована!');
}

function showQR() {
  const container = document.getElementById('qrContainer');
  const img = document.getElementById('qrImage');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentLink)}`;
  container.style.display = 'block';
}

function updateStats() {
  const online = Object.values(cameras).filter(c => c.status === 'online').length;
  document.getElementById('statOnline').textContent = online;
}

function refreshCameras() {
  fetch('/api/cameras').then(r => r.json()).then(list => {
    cameras = {};
    list.forEach(cam => cameras[cam.id] = cam);
    renderCameraList();
    renderGrid();
    updateStats();
  });
}

function escapeHtml(str) {
  return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
}
