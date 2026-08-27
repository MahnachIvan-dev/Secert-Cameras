let ws = null;
let cameras = {};

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
    // Получение бинарного кадра
    if (event.data instanceof ArrayBuffer) {
      renderBinaryFrame(event.data);
      return;
    }

    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'camera-list') {
        cameras = {};
        msg.cameras.forEach(c => cameras[c.id] = c);
        renderCameraList();
        renderGrid();
        ws.send(JSON.stringify({ type: 'subscribe-all' }));
      } else if (msg.type === 'camera-online') {
        cameras[msg.camera.id] = msg.camera;
        renderCameraList();
        renderGrid();
        ws.send(JSON.stringify({ type: 'subscribe-all' }));
      } else if (msg.type === 'camera-offline') {
        if (cameras[msg.cameraId]) {
          cameras[msg.cameraId].status = 'offline';
          renderCameraList();
          const canvas = document.getElementById(`canvas-${msg.cameraId}`);
          if (canvas) canvas.style.display = 'none';
        }
      }
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
  }).catch(() => {});
}

function renderCameraList() {
  const list = document.getElementById('cameraList');
  const cams = Object.values(cameras);
  if (cams.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>Нет камер</p></div>`;
    return;
  }
  list.innerHTML = cams.map(c => `
    <div class="camera-item">
      <div class="cam-status" style="background:${c.status === 'online' ? 'var(--success)' : 'var(--danger)'}"></div>
      <div class="cam-info"><div class="cam-name">${c.name}</div></div>
    </div>
  `).join('');
}

function renderGrid() {
  const grid = document.getElementById('viewGrid');
  const cams = Object.values(cameras);
  if (cams.length === 0) {
    grid.innerHTML = `<div class="empty-state"><h3>Нет камер</h3><button class="btn btn-primary" onclick="openGenerateLink()">Подключить камеру</button></div>`;
    return;
  }
  grid.innerHTML = cams.map(cam => `
    <div class="video-cell">
      <div class="video-cell-header">
        <div class="video-cell-name">${cam.name}</div>
        <span class="badge badge-live">LIVE</span>
      </div>
      <div class="video-cell-body">
        <canvas id="canvas-${cam.id}" style="width:100%; height:100%; object-fit:contain; display:none;"></canvas>
        <div class="video-placeholder" id="ph-${cam.id}">
          <span>Подключение...</span>
        </div>
      </div>
    </div>
  `).join('');
}

function openGenerateLink() {
  document.getElementById('linkModal').classList.add('open');
}

function closeLinkModal() {
  document.getElementById('linkModal').classList.remove('open');
}

async function generateLink() {
  const name = document.getElementById('linkName').value.trim() || 'Camera';
  const resp = await fetch('/api/generate-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const data = await resp.json();
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
