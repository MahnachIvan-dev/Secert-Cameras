let ws = null;
let stream = null;
let sendInterval = null;
let cameraId = null;
let frameCount = 0;
let motionEnabled = true;
let prevFrameData = null;
let canvas = null;
let ctx = null;
let motionCanvas = null;
let motionCtx = null;
let video = null;
let cameraToken = null;

document.addEventListener('DOMContentLoaded', () => {
  const fpsRange = document.getElementById('fpsRange');
  if (fpsRange) {
    fpsRange.addEventListener('input', (e) => {
      document.getElementById('fpsValue').textContent = e.target.value + ' fps';
    });
  }

  const qualityRange = document.getElementById('qualityRange');
  if (qualityRange) {
    qualityRange.addEventListener('input', (e) => {
      document.getElementById('qualityValue').textContent = e.target.value + '%';
    });
  }

  initFromURL();
});

function initFromURL() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const name = params.get('name');
  const location = params.get('location');
  const autostart = params.get('autostart');

  if (token) cameraToken = token;
  if (name) {
    const el = document.getElementById('cameraName');
    if (el) el.value = decodeURIComponent(name);
  }
  if (location) {
    const el = document.getElementById('cameraLocation');
    if (el) el.value = decodeURIComponent(location);
  }

  if (autostart === '1') {
    setTimeout(() => startCamera(), 500);
  }
}

async function startCamera() {
  const nameInput = document.getElementById('cameraName');
  const locInput = document.getElementById('cameraLocation');
  const resSelect = document.getElementById('resolutionSelect');

  const name = nameInput ? nameInput.value.trim() : 'Camera';
  const location = locInput ? locInput.value.trim() : 'Unknown';
  const resStr = resSelect ? resSelect.value : '640x480';
  const [width, height] = resStr.split('x').map(Number);

  log('Запрос доступа к камере...', 'info');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'environment' },
      audio: false
    });

    video = document.getElementById('videoPreview');
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    log(`Камера открыта: ${settings.width}x${settings.height}`, 'success');

    const resInfo = document.getElementById('resInfo');
    if (resInfo) resInfo.textContent = `${settings.width}x${settings.height}`;

    canvas = document.createElement('canvas');
    canvas.width = settings.width;
    canvas.height = settings.height;
    ctx = canvas.getContext('2d');

    motionCanvas = document.getElementById('motionCanvas');
    if (motionCanvas) {
      motionCanvas.width = settings.width;
      motionCanvas.height = settings.height;
      motionCtx = motionCanvas.getContext('2d');
    }

    const motionCheck = document.getElementById('motionDetection');
    motionEnabled = motionCheck ? motionCheck.checked : true;

    document.getElementById('settingsSection').style.display = 'none';
    document.getElementById('previewSection').style.display = 'block';

    connectWS(name, location, resStr);

  } catch (err) {
    log(`Ошибка: ${err.message}`, 'error');
  }
}

function stopCamera() {
  if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
  if (ws) { ws.close(); ws = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }

  document.getElementById('settingsSection').style.display = 'block';
  document.getElementById('previewSection').style.display = 'none';
  updateStatus('disconnected');
  log('Камера остановлена', 'warn');
}

function connectWS(name, location, resolution) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const encodedName = encodeURIComponent(name);
  const encodedLocation = encodeURIComponent(location);

  let url = `${protocol}://${window.location.host}?role=camera&name=${encodedName}&location=${encodedLocation}`;
  if (cameraToken) url += `&token=${cameraToken}`;

  updateStatus('connecting');
  log('Подключение к серверу...', 'info');

  ws = new WebSocket(url);

  ws.onopen = () => {
    log('Подключено к серверу', 'success');
    updateStatus('connected');
    startSending();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'registered') {
        cameraId = msg.id;
        const camIdEl = document.getElementById('cameraId');
        if (camIdEl) camIdEl.textContent = cameraId.slice(0, 12) + '...';
        log(`Зарегистрирована ID: ${cameraId}`, 'success');
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    updateStatus('disconnected');
    if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
    if (stream) setTimeout(() => { if (stream) connectWS(name, location, resolution); }, 3000);
  };
}

// УЛЬТРА-БЫСТРАЯ БИНАРНАЯ ОТПРАВКА
function startSending() {
  const fpsInput = document.getElementById('fpsRange');
  const qualityInput = document.getElementById('qualityRange');

  const fps = fpsInput ? (parseInt(fpsInput.value) || 20) : 20; // Выставили по умолчанию 20 FPS
  const quality = qualityInput ? (parseInt(qualityInput.value) / 100 || 0.4) : 0.4;
  const interval = 1000 / fps;

  log(`Отправка: ${fps} FPS, Качество: ${Math.round(quality * 100)}%`, 'info');

  if (sendInterval) clearInterval(sendInterval);

  const encoder = new TextEncoder();

  sendInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !video || video.paused) return;

    // Автоматическая защита от задержек сети
    if (ws.bufferedAmount > 0) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (motionEnabled) detectMotion();

    canvas.toBlob((blob) => {
      if (!blob || !ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 0) return;

      blob.arrayBuffer().then(jpegBuffer => {
        const idBytes = encoder.encode(cameraId);
        const packet = new Uint8Array(1 + idBytes.length + jpegBuffer.byteLength);

        packet[0] = idBytes.length;
        packet.set(idBytes, 1);
        packet.set(new Uint8Array(jpegBuffer), 1 + idBytes.length);

        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) {
          ws.send(packet.buffer);
          frameCount++;
          const fcEl = document.getElementById('frameCount');
          if (fcEl) fcEl.textContent = frameCount;
        }
      });
    }, 'image/jpeg', quality);

  }, interval);
}

function detectMotion() {
  if (!canvas || !motionCtx) return;
  const smallW = 160;
  const smallH = 120;

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  const smallCtx = smallCanvas.getContext('2d');
  smallCtx.drawImage(canvas, 0, 0, smallW, smallH);

  const currentFrame = smallCtx.getImageData(0, 0, smallW, smallH);

  if (prevFrameData) {
    const sensInput = document.getElementById('motionSensitivity');
    const sensitivity = sensInput ? (parseInt(sensInput.value) || 30) : 30;
    const threshold = 255 - (sensitivity * 2.55);
    let changedPixels = 0;

    for (let i = 0; i < currentFrame.data.length; i += 4) {
      const rDiff = Math.abs(currentFrame.data[i] - prevFrameData.data[i]);
      const gDiff = Math.abs(currentFrame.data[i + 1] - prevFrameData.data[i + 1]);
      const bDiff = Math.abs(currentFrame.data[i + 2] - prevFrameData.data[i + 2]);
      if ((rDiff + gDiff + bDiff) / 3 > threshold) changedPixels++;
    }

    const changePercent = (changedPixels / (smallW * smallH)) * 100;
    const mStatus = document.getElementById('motionStatus');

    if (changePercent > 5) {
      if (mStatus) {
        mStatus.textContent = `Да! (${changePercent.toFixed(1)}%)`;
        mStatus.style.color = 'var(--danger)';
      }

      if (!detectMotion.lastAlert || Date.now() - detectMotion.lastAlert > 5000) {
        detectMotion.lastAlert = Date.now();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'motion-detected', message: `Движение (${changePercent.toFixed(1)}%)` }));
        }
      }

      motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
      motionCtx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      motionCtx.lineWidth = 3;
      motionCtx.strokeRect(10, 10, motionCanvas.width - 20, motionCanvas.height - 20);
    } else {
      if (mStatus) {
        mStatus.textContent = 'Нет';
        mStatus.style.color = 'var(--success)';
      }
      motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
    }
  }
  prevFrameData = currentFrame;
}

function toggleMotion() {
  motionEnabled = !motionEnabled;
  const btn = document.getElementById('motionToggleBtn');
  if (btn) {
    btn.textContent = `👁 Движение: ${motionEnabled ? 'ВКЛ' : 'ВЫКЛ'}`;
    btn.className = motionEnabled ? 'btn btn-success' : 'btn';
  }
}

function updateStatus(status) {
  const el = document.getElementById('statusIndicator');
  if (!el) return;
  if (status === 'connected') {
    el.className = 'status-indicator status-connected';
    el.textContent = '● Подключена';
  } else if (status === 'disconnected') {
    el.className = 'status-indicator status-disconnected';
    el.textContent = '● Отключена';
  } else {
    el.className = 'status-indicator status-connecting';
    el.textContent = '◌ Подключение...';
  }
}

function log(message, type = 'info') {
  const output = document.getElementById('logOutput');
  if (!output) return;
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${message}`;
  output.appendChild(entry);
  output.scrollTop = output.scrollHeight;
}

window.startCamera = startCamera;
window.stopCamera = stopCamera;
window.toggleMotion = toggleMotion;
