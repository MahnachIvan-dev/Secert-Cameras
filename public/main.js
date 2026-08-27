let ws = null;
let cameras = {};
let gridLayout = 4;
let alertsPanelOpen = false;
let editingCameraId = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
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

  const connBar = document.getElementById('connectionBar');

  ws.onopen = () => {
    connBar.className = 'connection-bar';
    reconnectAttempt = 0;
    showToast('Подключено к серверу', 'success');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Parse error:', e);
    }
  };

  ws.onclose = () => {
    connBar.className = 'connection-bar disconnected';
    connBar.textContent = '⚠ Соединение потеряно. Переподключение...';
    scheduleReconnect();
  };

  ws.onerror = () => {
    connBar.className = 'connection-bar disconnected';
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempt++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  const connBar = document.getElementById('connectionBar');
  connBar.className = 'connection-bar reconnecting';
  connBar.textContent = `↻ Переподключение через ${Math.round(delay/1000)}с (попытка ${reconnectAttempt})...`;
  reconnectTimer = setTimeout(connectWebSocket, delay);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'camera-list':
      cameras = {};
      msg.cameras.forEach(cam => {
        cameras[cam.id] = cam;
      });
      renderCameraList();
      renderGrid();
      Object.values(cameras).forEach(cam => {
        if (cam.status === 'online') {
          wsSend({ type: 'subscribe', cameraId: cam.id });
        }
      });
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

    case 'camera-updated':
      cameras[msg.camera.id] = msg.camera;
      renderCameraList();
      break;

    case 'camera-removed':
      delete cameras[msg.cameraId];
      renderCameraList();
      renderGrid();
      loadStats();
      break;

    case 'video-frame':
      updateVideoFrame(msg.cameraId, msg.frame, msg.timestamp);
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
    list.innerHTML = `<div class="empty-state" style="padding: 40px 20px"><p>Нет камер.</p></div>`;
    return;
  }

  list.innerHTML = cams.map(cam => `
    <div class="camera-item" 
         onclick="focusCamera('${cam.id}')"
         data-cam-id="${cam.id}">
      <div class="cam-status" style="background: ${cam.status === 'online' ? 'var(--success)' : 'var(--danger)'}; 
           box-shadow: ${cam.status === 'online' ? '0 0 8px var(--success)' : 'none'}"></div>
      <div class="cam-info">
        <div class="cam-name">${escapeHtml(cam.name)}</div>
        <div class="cam-location">${escapeHtml(cam.location)}</div>
      </div>
      <div class="cam-actions">
        <button class="btn btn-sm btn-icon" onclick="event.stopPropagation(); openEditCamera('${cam.id}')">⚙</button>
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
}

function renderGrid() {
  const grid = document.getElementById('viewGrid');
  const cams = Object.values(cameras);

  if (cams.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" id="emptyState">
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
        <img id="frame-${cam.id}" src="" style="display:none">
        <div class="video-placeholder" id="ph-${cam.id}">
          <div class="ph-icon">📷</div>
          <span>${cam.status === 'online' ? 'Ожидание видео...' : 'Камера оффлайн'}</span>
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

function updateVideoFrame(cameraId, frame, timestamp) {
  if (!frame) return; // Защита от пустых кадров (убирает иконку сломанной картинки)
  
  const img = document.getElementById(`frame-${cameraId}`);
  const ph = document.getElementById(`ph-${cameraId}`);

  if (img) {
    img.src = frame;
    img.style.display = 'block';
    if (ph) ph.style.display = 'none';
  }

  const timeEl = document.getElementById(`time-${cameraId}`);
  if (timeEl) {
    const d = new Date(timestamp);
    timeEl.textContent = d.toLocaleTimeString();
  }

  const fsImg = document.getElementById('fullscreenImg');
  if (fsImg && fsImg.dataset.cameraId === cameraId) {
    fsImg.src = frame;
  }
}

function updateCellStatus(cameraId, status) {
  const ph = document.getElementById(`ph-${cameraId}`);
  const img = document.getElementById(`frame-${cameraId}`);
  if (status === 'offline') {
    if (img) img.style.display = 'none';
    if (ph) {
      ph.style.display = 'flex';
      ph.querySelector('span').textContent = 'Камера оффлайн';
    }
  }
}

function openFullscreen(cameraId) {
  const overlay = document.getElementById('fullscreenOverlay');
  const img = document.getElementById('fullscreenImg');
  const frameImg = document.getElementById(`frame-${cameraId}`);

  if (frameImg && frameImg.src && frameImg.style.display !== 'none') {
    img.src = frameImg.src;
    img.dataset.cameraId = cameraId;
    overlay.classList.add('open');
  }
}

function closeFullscreen() {
  document.getElementById('fullscreenOverlay').classList.remove('open');
  document.getElementById('fullscreenImg').dataset.cameraId = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeFullscreen();
    closeEditModal();
    closeLinkModal();
  }
});

function focusCamera(cameraId) {
  document.querySelectorAll('.camera-item').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-cam-id="${cameraId}"]`);
  if (item) item.classList.add('active');
  // Можно добавить логику для одиночного просмотра
}

function subscribeAll() {
  wsSend({ type: 'subscribe-all' });
  showToast('Запрошено видео со всех камер', 'info');
}

function unsubscribeAll() {
  wsSend({ type: 'unsubscribe-all' });
  showToast('Остановлен прием видео', 'info');
}

// ===== GENERATE LINK =====
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
  } catch (e) {
    showToast('Ошибка генерации', 'error');
  }
}

function copyLink() {
  const input = document.getElementById('linkResult');
  input.select();
  input.setSelectionRange(0, 99999);
  try {
    navigator.clipboard.writeText(currentLink).then(() => {
      showToast('Ссылка скопирована в буфер', 'success');
    });
  } catch {
    document.execCommand('copy');
    showToast('Ссылка скопирована', 'success');
  }
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
  editingCameraId = null;
}

async function saveEditCamera() {
  if (!editingCameraId) return;
  const data = {
    name: document.getElementById('editName').value,
    location: document.getElementById('editLocation').value
  };
  try {
    const resp = await fetch(`/api/cameras/${editingCameraId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (resp.ok) {
      Object.assign(cameras[editingCameraId], data);
      renderCameraList();
      renderGrid();
      showToast('Настройки сохранены', 'success');
      closeEditModal();
    }
  } catch (e) {}
}

async function deleteEditCamera() {
  if (!editingCameraId) return;
  if (!confirm('Удалить камеру?')) return;
  try {
    await fetch(`/api/cameras/${editingCameraId}`, { method: 'DELETE' });
    closeEditModal();
  } catch (e) {}
}

function takeSnapshot(cameraId) {
  const img = document.getElementById(`frame-${cameraId}`);
  if (!img || !img.src || img.style.display === 'none') {
    showToast('Нет кадра для снимка', 'warning');
    return;
  }
  const a = document.createElement('a');
  a.href = img.src;
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
    const resp = await fetch('/api/alerts?limit=50');
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
    <div class="alert-item ${a.read ? '' : 'unread'}" onclick="markAlertRead('${a.id}', this)">
      <div class="alert-type">⚠ ${a.type}</div>
      <div class="alert-msg">${escapeHtml(a.message)}</div>
      <div class="alert-time">${new Date(a.timestamp).toLocaleString()}</div>
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
  const statEl = document.getElementById('statAlerts');
  statEl.textContent = parseInt(statEl.textContent) + 1;
  if (alertsPanelOpen) loadAlerts();
}

async function markAlertRead(alertId, el) {
  try {
    await fetch(`/api/alerts/${alertId}/read`, { method: 'PUT' });
    el.classList.remove('unread');
  } catch (e) {}
}

async function clearAlerts() {
  try {
    await fetch('/api/alerts', { method: 'DELETE' });
    loadAlerts();
    document.getElementById('statAlerts').textContent = '0';
  } catch (e) {}
}

async function loadStats() {
  try {
    const resp = await fetch('/api/stats');
    const stats = await resp.json();
    document.getElementById('statOnline').textContent = stats.onlineCameras;
    document.getElementById('statTotal').textContent = stats.totalCameras;
    document.getElementById('statAlerts').textContent = stats.unreadAlerts;
  } catch (e) {}
}

function refreshCameras() {
  fetch('/api/cameras')
    .then(r => r.json())
    .then(list => {
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
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
