let ws = null;
let cameras = {};
let gridLayout = 4;
let alertsPanelOpen = false;
let editingCameraId = null;
let currentLink = '';

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  loadStats();
  loadAlerts();
  setInterval(loadStats, 10000);
  document.getElementById('alertStat').addEventListener('click', toggleAlerts);
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}?role=viewer`);
  ws.binaryType = 'arraybuffer'; // Включаем прием чистого бинарного потока

  const connBar = document.getElementById('connectionBar');

  ws.onopen = () => {
    connBar.className = 'connection-bar';
    showToast('Подключено к серверу', 'success');
  };

  ws.onmessage = (event) => {
    // ОБРАБОТКА БИНАРНОГО КАДРА ВИДЕО
    if (event.data instanceof ArrayBuffer) {
      renderBinaryFrame(event.data);
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {}
  };

  ws.onclose = () => {
    connBar.className = 'connection-bar disconnected';
    setTimeout(connectWebSocket, 3000);
  };
}

// Аппаратная отрисовка на Canvas через GPU
function renderBinaryFrame(buffer) {
  const view = new Uint8Array(buffer);
  const idLen = view[0];
  const cameraId = new TextDecoder().decode(view.subarray(1, 1 + idLen));
  const jpegBytes = view.subarray(1 + idLen);

  const canvas = document.getElementById(`canvas-${cameraId}`);
  if (!canvas) return;

  const blob = new Blob([jpegBytes], { type: 'image/jpeg' });

  // createImageBitmap декодирует картинку в фоновом потоке GPU
  createImageBitmap(blob).then(bitmap => {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close(); // Очищаем GPU память

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
      msg.cameras.forEach(cam => cameras[cam.id] = cam);
      renderCameraList();
      renderGrid();
      subscribeAll();
      break;

    case 'camera-online':
      cameras[msg.camera.id] = msg.camera;
      renderCameraList();
      renderGrid();
      wsSend({ type: 'subscribe', cameraId: msg.camera.id });
      showToast(`📷 ${msg.camera.name} подключена`, 'success');
      loadStats();
      break;

    case 'camera-offline':
      if (cameras[msg.cameraId]) {
        cameras[msg.cameraId].status = 'offline';
        renderCameraList();
        updateCellStatus(msg.cameraId, 'offline');
        showToast(`📷 ${cameras[msg.cameraId].name} отключена`, 'warning');
        loadStats();
      }
      break;

    case 'alert':
      handleAlert(msg.alert);
      break;
  }
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function renderCameraList() {
  const list = document.getElementById('cameraList');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:40px 20px"><p>Нет камер.</p></div>`;
    return;
  }

  list.innerHTML = cams.map(cam => `
    <div class="camera-item" data-cam-id="${cam.id}">
      <div class="cam-status" style="background:${cam.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></div>
      <div class="cam-info">
        <div class="cam-name">${escapeHtml(cam.name)}</div>
        <div class="cam-location">${escapeHtml(cam.location)}</div>
      </div>
      <div class="cam-actions">
        <button class="btn btn-sm btn-icon" onclick="openEditCamera('${cam.id}')">⚙</button>
      </div>
    </div>
  `).join('');
}

function setGridLayout(n) {
  gridLayout = n;
  const grid = document.getElementById('viewGrid');
  grid.className = `view-grid grid-${n}`;
  document.getElementById('gridInfo').textContent = `Сетка: ${Math.sqrt(n)|0}×${Math.sqrt(n)|0}`;
  renderGrid();
  subscribeAll();
}

function renderGrid() {
  const grid = document.getElementById('viewGrid');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📹</div>
        <h3>Нет активных камер</h3>
        <button class="btn btn-primary" onclick="openGenerateLink()">Подключить камеру</button>
      </div>`;
    return;
  }

  const displayCams = cams.slice(0, gridLayout);

  grid.innerHTML = displayCams.map(cam => `
    <div class="video-cell" id="cell-${cam.id}" ondblclick="openFullscreen('${cam.id}')">
      <div class="video-cell-header">
        <div class="video-cell-name">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${cam.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></span>
          ${escapeHtml(cam.name)}
        </div>
        <div class="video-cell-badges">
          ${cam.status === 'online' ? '<span class="badge badge-live">LIVE</span>' : ''}
        </div>
      </div>
      <div class="video-cell-body">
        <div class="motion-indicator" id="motion-${cam.id}"></div>
        <canvas id="canvas-${cam.id}" style="width:100%; height:100%; object-fit:contain; display:none;"></canvas>
        <div class="video-placeholder" id="ph-${cam.id}">
          <div class="ph-icon">📷</div>
          <span>${cam.status === 'online' ? 'Подключение потока...' : 'Камера оффлайн'}</span>
        </div>
      </div>
      <div class="video-cell-footer">
        <div class="video-cell-controls">
          <button class="btn btn-sm" onclick="event.stopPropagation(); openFullscreen('${cam.id}')">⛶</button>
          <button class="btn btn-sm" onclick="event.stopPropagation(); takeSnapshot('${cam.id}')">📸</button>
        </div>
        <div class="video-cell-time" id="time-${cam.id}">--:--:--</div>
      </div>
    </div>
  `).join('');
}

function updateCellStatus(cameraId, status) {
  const ph = document.getElementById(`ph-${cameraId}`);
  const canvas = document.getElementById(`canvas-${cameraId}`);
  if (status === 'offline') {
    if (canvas) canvas.style.display = 'none';
    if (ph) {
      ph.style.display = 'flex';
      ph.querySelector('span').textContent = 'Камера оффлайн';
    }
  }
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

function subscribeAll() {
  wsSend({ type: 'subscribe-all' });
}

function unsubscribeAll() {
  wsSend({ type: 'unsubscribe-all' });
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
  const name = document.getElementById('linkName').value.trim() || 'Camera';
  const location = document.getElementById('linkLocation').value.trim() || 'Unknown';

  try {
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
  } catch (e) {}
}

function copyLink() {
  const input = document.getElementById('linkResult');
  input.select();
  navigator.clipboard.writeText(currentLink);
  showToast('Ссылка скопирована', 'success');
}

function showQR() {
  const container = document.getElementById('qrContainer');
  const img = document.getElementById('qrImage');
  img.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentLink)}`;
  container.style.display = 'block';
}

function openEditCamera(cameraId) {
  editingCameraId = cameraId;
  const cam = cameras[cameraId];
  if (!cam) return;
  document.getElementById('editName').value = cam.name;
  document.getElementById('editLocation').value = cam.location;
  document.getElementById('editModal').classList.add('open');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('open');
}

async function saveEditCamera() {
  if (!editingCameraId) return;
  const data = {
    name: document.getElementById('editName').value,
    location: document.getElementById('editLocation').value
  };
  await fetch(`/api/cameras/${editingCameraId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  closeEditModal();
}

async function deleteEditCamera() {
  if (!editingCameraId || !confirm('Удалить камеру?')) return;
  await fetch(`/api/cameras/${editingCameraId}`, { method: 'DELETE' });
  closeEditModal();
}

function takeSnapshot(cameraId) {
  const canvas = document.getElementById(`canvas-${cameraId}`);
  if (!canvas || canvas.style.display === 'none') return;
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/jpeg');
  a.download = `snapshot_${cameraId}_${Date.now()}.jpg`;
  a.click();
}

function toggleAlerts() {
  alertsPanelOpen = !alertsPanelOpen;
  document.getElementById('alertsPanel').classList.toggle('open', alertsPanelOpen);
  if (alertsPanelOpen) loadAlerts();
}

async function loadAlerts() {
  try {
    const resp = await fetch('/api/alerts');
    const alerts = await resp.json();
    renderAlerts(alerts);
  } catch (e) {}
}

function renderAlerts(alerts) {
  const list = document.getElementById('alertsList');
  if (alerts.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:40px 20px"><p>Нет алертов</p></div>';
    return;
  }
  list.innerHTML = alerts.map(a => `
    <div class="alert-item">
      <div class="alert-type">⚠ ${a.type}</div>
      <div class="alert-msg">${escapeHtml(a.message)}</div>
      <div class="alert-time">${new Date(a.timestamp).toLocaleTimeString()}</div>
    </div>
  `).join('');
}

function handleAlert(alert) {
  showToast(`⚠ ${alert.message}`, 'warning');
  const motionEl = document.getElementById(`motion-${alert.cameraId}`);
  if (motionEl) {
    motionEl.classList.add('active');
    setTimeout(() => motionEl.classList.remove('active'), 3000);
  }
}

async function clearAlerts() {
  await fetch('/api/alerts', { method: 'DELETE' });
  loadAlerts();
}

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();
    document.getElementById('statOnline').textContent = stats.onlineCameras;
    document.getElementById('statTotal').textContent = stats.totalCameras;
    document.getElementById('statAlerts').textContent = stats.totalAlerts;
  } catch (e) {}
}

function refreshCameras() {
  fetch('/api/cameras').then(r => r.json()).then(list => {
    cameras = {};
    list.forEach(cam => cameras[cam.id] = cam);
    renderCameraList();
    renderGrid();
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
}
