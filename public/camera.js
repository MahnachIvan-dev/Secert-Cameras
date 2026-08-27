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

// Инициализация после загрузки страницы
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

  // Автозапуск
  if (autostart === '1') {
    setTimeout(() => {
      startCamera();
    }, 500);
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
    log(`Ошибка доступа к камере: ${err.message}`, 'error');
    showToast('Не удалось получить доступ к камере: ' + err.message, 'error');
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
        log(`Зарегистрирована с ID: ${cameraId}`, 'success');
      }
    } catch (e) {}
  };

  ws.onclose = () => {
    log('Отключено от сервера', 'error');
    updateStatus('disconnected');
    if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
    if (stream) {
      log('Переподключение через 3с...', 'warn');
      setTimeout(() => { if (stream) connectWS(name, location, resolution); }, 3000);
    }
  };

  ws.onerror = () => log('Ошибка WebSocket', 'error');
}

function startSending() {
  const fpsInput = document.getElementById('fpsRange');
  const qualityInput = document.getElementById('qualityRange');

  const fps = fpsInput ? (parseInt(fpsInput.value) || 10) : 10;
  const quality = qualityInput ? (parseInt(qualityInput.value) / 100 || 0.4) : 0.4;
  const interval = 1000 / fps;

  log(`Отправка: ${fps} fps, качество: ${Math.round(quality * 100)}%`, 'info');

  if (sendInterval) clearInterval(sendInterval);

  sendInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !video || video.paused) return;

    // Пропуск кадров для убирания лагов сети
    if (ws.bufferedAmount > 0) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (motionEnabled) detectMotion();

    // Быстрая бинарная передача кадра
    canvas.toBlob((blob) => {
      if (blob && ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount === 0) {
        ws.send(blob);
        frameCount++;
        const fcEl = document.getElementById('frameCount');
        if (fcEl) fcEl.textContent = frameCount;
      }
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
    const totalPixels = smallW * smallH;

    for (let i = 0; i < currentFrame.data.length; i += 4) {
      const rDiff = Math.abs(currentFrame.data[i] - prevFrameData.data[i]);
      const gDiff = Math.abs(currentFrame.data[i + 1] - prevFrameData.data[i + 1]);
      const bDiff = Math.abs(currentFrame.data[i + 2] - prevFrameData.data[i + 2]);
      if ((rDiff + gDiff + bDiff) / 3 > threshold) changedPixels++;
    }

    const changePercent = (changedPixels / totalPixels) * 100;
    const mStatus = document.getElementById('motionStatus');

    if (changePercent > 5) {
      if (mStatus) {
        mStatus.textContent = `Да! (${changePercent.toFixed(1)}%)`;
        mStatus.style.color = 'var(--danger)';
      }

      if (!detectMotion.lastAlert || Date.now() - detectMotion.lastAlert > 5000) {
        detectMotion.lastAlert = Date.now();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'motion-detected', message: `Движение обнаружено (${changePercent.toFixed(1)}%)` }));
          log(`Движение: ${changePercent.toFixed(1)}%`, 'warn');
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
  if (!motionEnabled && motionCtx) {
    motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
    const mStatus = document.getElementById('motionStatus');
    if (mStatus) {
      mStatus.textContent = 'Выкл';
      mStatus.style.color = 'var(--text-muted)';
    }
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
  while (output.children.length > 200) output.removeChild(output.firstChild);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
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

// Привязываем функции к window для HTML onclick
window.startCamera = startCamera;
window.stopCamera = stopCamera;
window.toggleMotion = toggleMotion;

window.addEventListener('beforeunload', () => {
  if (sendInterval) clearInterval(sendInterval);
  if (ws) ws.close();
  if (stream) stream.getTracks().forEach(t => t.stop());
});
