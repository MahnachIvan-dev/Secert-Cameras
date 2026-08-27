// ===== STATE =====
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

// ===== UI HANDLERS =====
document.getElementById('fpsRange').addEventListener('input', (e) => {
  document.getElementById('fpsValue').textContent = e.target.value + ' fps';
});

document.getElementById('qualityRange').addEventListener('input', (e) => {
  document.getElementById('qualityValue').textContent = e.target.value + '%';
});

// ===== START CAMERA =====
async function startCamera() {
  const name = document.getElementById('cameraName').value.trim() || 'Camera';
  const location = document.getElementById('cameraLocation').value.trim() || 'Unknown';
  const resStr = document.getElementById('resolutionSelect').value;
  const [width, height] = resStr.split('x').map(Number);

  log('Запрос доступа к камере...', 'info');

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: width },
        height: { ideal: height },
        facingMode: 'environment'
      },
      audio: false
    });

    video = document.getElementById('videoPreview');
    video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    log(`Камера открыта: ${settings.width}x${settings.height}`, 'success');

    document.getElementById('resInfo').textContent = `${settings.width}x${settings.height}`;

    // Скрытый canvas для захвата кадров
    canvas = document.createElement('canvas');
    canvas.width = settings.width;
    canvas.height = settings.height;
    ctx = canvas.getContext('2d');

    // Canvas для движения
    motionCanvas = document.getElementById('motionCanvas');
    motionCanvas.width = settings.width;
    motionCanvas.height = settings.height;
    motionCtx = motionCanvas.getContext('2d');

    motionEnabled = document.getElementById('motionDetection').checked;

    // UI switch
    document.getElementById('settingsSection').style.display = 'none';
    document.getElementById('previewSection').style.display = 'block';

    // Connect WebSocket
    connectWS(name, location, resStr);

  } catch (err) {
    log(`Ошибка доступа к камере: ${err.message}`, 'error');
    showToast('Не удалось получить доступ к камере', 'error');
  }
}

// ===== STOP CAMERA =====
function stopCamera() {
  if (sendInterval) {
    clearInterval(sendInterval);
    sendInterval = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  document.getElementById('settingsSection').style.display = 'block';
  document.getElementById('previewSection').style.display = 'none';
  updateStatus('disconnected');
  log('Камера остановлена', 'warn');
}

// ===== WEBSOCKET =====
function connectWS(name, location, resolution) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const encodedName = encodeURIComponent(name);
  const encodedLocation = encodeURIComponent(location);
  const url = `${protocol}://${window.location.host}?role=camera&name=${encodedName}&location=${encodedLocation}`;

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
      handleServerMessage(msg);
    } catch (e) {}
  };

  ws.onclose = () => {
    log('Отключено от сервера', 'error');
    updateStatus('disconnected');
    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }
    // Автореконнект через 3 сек если камера ещё активна
    if (stream) {
      log('Переподключение через 3с...', 'warn');
      setTimeout(() => {
        if (stream) connectWS(name, location, resolution);
      }, 3000);
    }
  };

  ws.onerror = (err) => {
    log('Ошибка WebSocket', 'error');
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'registered':
      cameraId = msg.id;
      document.getElementById('cameraId').textContent = cameraId.slice(0, 12) + '...';
      log(`Зарегистрирована с ID: ${cameraId}`, 'success');
      break;

    case 'settings-update':
      log(`Настройки обновлены сервером: ${JSON.stringify(msg.settings)}`, 'info');
      // Можно адаптировать fps и т.д.
      break;

    case 'ptz-command':
      log(`PTZ команда: ${JSON.stringify(msg.command)}`, 'info');
      break;

    case 'motion-zones':
      log(`Зоны движения обновлены: ${msg.zones.length} зон`, 'info');
      break;

    case 'disconnect':
      log('Сервер запросил отключение', 'warn');
      stopCamera();
      break;
  }
}

// ===== SENDING FRAMES =====
function startSending() {
  const fps = parseInt(document.getElementById('fpsRange').value) || 10;
  const quality = parseInt(document.getElementById('qualityRange').value) / 100 || 0.5;
  const interval = 1000 / fps;

  log(`Отправка: ${fps} fps, качество: ${Math.round(quality * 100)}%`, 'info');

  if (sendInterval) clearInterval(sendInterval);

  sendInterval = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !video || video.paused) return;

    // Нарисовать кадр на canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Детектирование движения
    if (motionEnabled) {
      detectMotion();
    }

    // Отправить кадр
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    try {
      ws.send(JSON.stringify({
        type: 'frame',
        frame: dataUrl
      }));

      frameCount++;
      document.getElementById('frameCount').textContent = frameCount;
    } catch (e) {
      log('Ошибка отправки кадра', 'error');
    }
  }, interval);
}

// ===== MOTION DETECTION =====
function detectMotion() {
  const width = canvas.width;
  const height = canvas.height;

  // Уменьшаем для производительности
  const smallW = 160;
  const smallH = 120;

  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  const smallCtx = smallCanvas.getContext('2d');
  smallCtx.drawImage(canvas, 0, 0, smallW, smallH);

  const currentFrame = smallCtx.getImageData(0, 0, smallW, smallH);

  if (prevFrameData) {
    const sensitivity = parseInt(document.getElementById('motionSensitivity').value) || 30;
    const threshold = 255 - (sensitivity * 2.55);
    let changedPixels = 0;
    const totalPixels = smallW * smallH;

    for (let i = 0; i < currentFrame.data.length; i += 4) {
      const rDiff = Math.abs(currentFrame.data[i] - prevFrameData.data[i]);
      const gDiff = Math.abs(currentFrame.data[i + 1] - prevFrameData.data[i + 1]);
      const bDiff = Math.abs(currentFrame.data[i + 2] - prevFrameData.data[i + 2]);
      const avgDiff = (rDiff + gDiff + bDiff) / 3;

      if (avgDiff > threshold) {
        changedPixels++;
      }
    }

    const changePercent = (changedPixels / totalPixels) * 100;

    if (changePercent > 5) {
      document.getElementById('motionStatus').textContent = `Да! (${changePercent.toFixed(1)}%)`;
      document.getElementById('motionStatus').style.color = 'var(--danger)';

      // Отправить алерт (не чаще раз в 5 сек)
      if (!detectMotion.lastAlert || Date.now() - detectMotion.lastAlert > 5000) {
        detectMotion.lastAlert = Date.now();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'motion-detected',
            message: `Движение обнаружено (${changePercent.toFixed(1)}%)`,
            level: changePercent
          }));
          log(`Движение: ${changePercent.toFixed(1)}%`, 'warn');
        }
      }

      // Визуализация на canvas
      motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
      motionCtx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
      motionCtx.lineWidth = 3;
      motionCtx.strokeRect(10, 10, motionCanvas.width - 20, motionCanvas.height - 20);
      motionCtx.fillStyle = 'rgba(239, 68, 68, 0.15)';
      motionCtx.fillRect(10, 10, motionCanvas.width - 20, motionCanvas.height - 20);

      // Текст
      motionCtx.fillStyle = 'rgba(239, 68, 68, 0.9)';
      motionCtx.font = 'bold 18px sans-serif';
      motionCtx.fillText(`⚠ MOTION ${changePercent.toFixed(1)}%`, 20, 40);
    } else {
      document.getElementById('motionStatus').textContent = 'Нет';
      document.getElementById('motionStatus').style.color = 'var(--success)';
      motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
    }
  }

  prevFrameData = currentFrame;
}

function toggleMotion() {
  motionEnabled = !motionEnabled;
  const btn = document.getElementById('motionToggleBtn');
  btn.textContent = `👁 Движение: ${motionEnabled ? 'ВКЛ' : 'ВЫКЛ'}`;
  btn.className = motionEnabled ? 'btn btn-success' : 'btn';
  log(`Детекция движения: ${motionEnabled ? 'включена' : 'выключена'}`, 'info');

  if (!motionEnabled && motionCtx) {
    motionCtx.clearRect(0, 0, motionCanvas.width, motionCanvas.height);
    document.getElementById('motionStatus').textContent = 'Выкл';
    document.getElementById('motionStatus').style.color = 'var(--text-muted)';
  }
}

// ===== UI HELPERS =====
function updateStatus(status) {
  const el = document.getElementById('statusIndicator');
  switch (status) {
    case 'connected':
      el.className = 'status-indicator status-connected';
      el.textContent = '● Подключена';
      break;
    case 'disconnected':
      el.className = 'status-indicator status-disconnected';
      el.textContent = '● Отключена';
      break;
    case 'connecting':
      el.className = 'status-indicator status-connecting';
      el.textContent = '◌ Подключение...';
      break;
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

  // Ограничение строк
  while (output.children.length > 200) {
    output.removeChild(output.firstChild);
  }
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
    toast.style.transition = '0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Очистка при закрытии страницы
window.addEventListener('beforeunload', () => {
  if (sendInterval) clearInterval(sendInterval);
  if (ws) ws.close();
  if (stream) stream.getTracks().forEach(t => t.stop());
});
