const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===== Хранилище данных =====
const cameras = new Map();       // id -> { id, name, location, status, ws, lastSeen, resolution, fps, recording }
const viewers = new Map();       // ws -> { id, subscribedTo: Set }
const recordings = new Map();    // cameraId -> [{ id, start, end, size, thumbnail }]
const alerts = [];               // [{ id, cameraId, type, message, timestamp, read }]
const motionZones = new Map();   // cameraId -> [{ x, y, w, h, sensitivity }]
const snapshots = new Map();     // cameraId -> base64 последний кадр

// ===== REST API =====

// Получить все камеры
app.get('/api/cameras', (req, res) => {
  const list = [];
  cameras.forEach((cam) => {
    list.push({
      id: cam.id,
      name: cam.name,
      location: cam.location,
      status: cam.status,
      lastSeen: cam.lastSeen,
      resolution: cam.resolution,
      fps: cam.fps,
      recording: cam.recording,
      hasSnapshot: snapshots.has(cam.id)
    });
  });
  res.json(list);
});

// Получить одну камеру
app.get('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  res.json({
    id: cam.id,
    name: cam.name,
    location: cam.location,
    status: cam.status,
    lastSeen: cam.lastSeen,
    resolution: cam.resolution,
    fps: cam.fps,
    recording: cam.recording
  });
});

// Обновить камеру
app.put('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  const { name, location, recording, fps, resolution } = req.body;
  if (name) cam.name = name;
  if (location) cam.location = location;
  if (recording !== undefined) cam.recording = recording;
  if (fps) cam.fps = fps;
  if (resolution) cam.resolution = resolution;

  // Отправить камере обновлённые настройки
  if (cam.ws && cam.ws.readyState === 1) {
    cam.ws.send(JSON.stringify({ type: 'settings-update', settings: { recording: cam.recording, fps: cam.fps, resolution: cam.resolution } }));
  }

  broadcastToViewers({ type: 'camera-updated', camera: sanitizeCam(cam) });
  res.json({ success: true });
});

// Удалить камеру
app.delete('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (cam.ws && cam.ws.readyState === 1) {
    cam.ws.send(JSON.stringify({ type: 'disconnect' }));
    cam.ws.close();
  }
  cameras.delete(req.params.id);
  snapshots.delete(req.params.id);
  recordings.delete(req.params.id);
  broadcastToViewers({ type: 'camera-removed', cameraId: req.params.id });
  res.json({ success: true });
});

// Снимок камеры
app.get('/api/cameras/:id/snapshot', (req, res) => {
  const snap = snapshots.get(req.params.id);
  if (!snap) return res.status(404).json({ error: 'No snapshot' });
  res.json({ snapshot: snap });
});

// Алерты
app.get('/api/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(alerts.slice(-limit).reverse());
});

app.put('/api/alerts/:id/read', (req, res) => {
  const alert = alerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.read = true;
  res.json({ success: true });
});

app.delete('/api/alerts', (req, res) => {
  alerts.length = 0;
  res.json({ success: true });
});

// Записи
app.get('/api/cameras/:id/recordings', (req, res) => {
  res.json(recordings.get(req.params.id) || []);
});

// PTZ управление
app.post('/api/cameras/:id/ptz', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (cam.ws && cam.ws.readyState === 1) {
    cam.ws.send(JSON.stringify({ type: 'ptz-command', command: req.body }));
    res.json({ success: true });
  } else {
    res.status(503).json({ error: 'Camera offline' });
  }
});

// Зоны движения
app.get('/api/cameras/:id/zones', (req, res) => {
  res.json(motionZones.get(req.params.id) || []);
});

app.post('/api/cameras/:id/zones', (req, res) => {
  motionZones.set(req.params.id, req.body.zones || []);
  const cam = cameras.get(req.params.id);
  if (cam && cam.ws && cam.ws.readyState === 1) {
    cam.ws.send(JSON.stringify({ type: 'motion-zones', zones: req.body.zones }));
  }
  res.json({ success: true });
});

// Статистика
app.get('/api/stats', (req, res) => {
  let online = 0, recording = 0;
  cameras.forEach(c => {
    if (c.status === 'online') online++;
    if (c.recording) recording++;
  });
  res.json({
    totalCameras: cameras.size,
    onlineCameras: online,
    recordingCameras: recording,
    totalAlerts: alerts.length,
    unreadAlerts: alerts.filter(a => !a.read).length,
    viewersConnected: viewers.size
  });
});

// ===== WebSocket =====
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role'); // 'camera' или 'viewer'

  if (role === 'camera') {
    handleCameraConnection(ws, url);
  } else {
    handleViewerConnection(ws);
  }
});

function handleCameraConnection(ws, url) {
  const cameraId = url.searchParams.get('id') || uuidv4();
  const name = decodeURIComponent(url.searchParams.get('name') || `Camera-${cameraId.slice(0, 6)}`);
  const location = decodeURIComponent(url.searchParams.get('location') || 'Unknown');

  const cam = {
    id: cameraId,
    name,
    location,
    status: 'online',
    ws,
    lastSeen: Date.now(),
    resolution: '1280x720',
    fps: 30,
    recording: false
  };

  cameras.set(cameraId, cam);
  console.log(`📷 Camera connected: ${name} (${cameraId})`);

  ws.send(JSON.stringify({ type: 'registered', id: cameraId }));
  broadcastToViewers({ type: 'camera-online', camera: sanitizeCam(cam) });

  ws.on('message', (data) => {
    try {
      // Проверяем, бинарные данные или текст
      if (typeof data !== 'string' && !(data instanceof String)) {
        // Бинарные данные - это видеокадр
        const base64 = Buffer.from(data).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        snapshots.set(cameraId, dataUrl);
        cam.lastSeen = Date.now();

        // Пересылаем подписанным зрителям
        viewers.forEach((viewer, viewerWs) => {
          if (viewer.subscribedTo.has(cameraId) && viewerWs.readyState === 1) {
            viewerWs.send(JSON.stringify({ type: 'video-frame', cameraId, frame: dataUrl, timestamp: Date.now() }));
          }
        });
        return;
      }

      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'frame':
          snapshots.set(cameraId, msg.frame);
          cam.lastSeen = Date.now();
          viewers.forEach((viewer, viewerWs) => {
            if (viewer.subscribedTo.has(cameraId) && viewerWs.readyState === 1) {
              viewerWs.send(JSON.stringify({ type: 'video-frame', cameraId, frame: msg.frame, timestamp: Date.now() }));
            }
          });
          break;

        case 'motion-detected':
          const alert = {
            id: uuidv4(),
            cameraId,
            type: 'motion',
            message: msg.message || `Motion detected on ${cam.name}`,
            timestamp: Date.now(),
            read: false,
            thumbnail: msg.thumbnail || null
          };
          alerts.push(alert);
          if (alerts.length > 1000) alerts.splice(0, alerts.length - 1000);
          broadcastToViewers({ type: 'alert', alert });
          break;

        case 'status':
          cam.resolution = msg.resolution || cam.resolution;
          cam.fps = msg.fps || cam.fps;
          cam.lastSeen = Date.now();
          break;

        case 'recording-saved':
          if (!recordings.has(cameraId)) recordings.set(cameraId, []);
          recordings.get(cameraId).push({
            id: uuidv4(),
            start: msg.start,
            end: msg.end,
            size: msg.size,
            thumbnail: msg.thumbnail
          });
          break;
      }
    } catch (e) {
      console.error('Camera message parse error:', e.message);
    }
  });

  ws.on('close', () => {
    cam.status = 'offline';
    cam.ws = null;
    console.log(`📷 Camera disconnected: ${name}`);
    broadcastToViewers({ type: 'camera-offline', cameraId });
  });

  ws.on('error', () => {
    cam.status = 'offline';
    cam.ws = null;
  });
}

function handleViewerConnection(ws) {
  const viewerId = uuidv4();
  viewers.set(ws, { id: viewerId, subscribedTo: new Set() });
  console.log(`👁 Viewer connected: ${viewerId}`);

  // Отправить список камер
  const camList = [];
  cameras.forEach(c => camList.push(sanitizeCam(c)));
  ws.send(JSON.stringify({ type: 'camera-list', cameras: camList }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const viewer = viewers.get(ws);
      if (!viewer) return;

      switch (msg.type) {
        case 'subscribe':
          viewer.subscribedTo.add(msg.cameraId);
          ws.send(JSON.stringify({ type: 'subscribed', cameraId: msg.cameraId }));
          // Отправить последний снапшот сразу
          const snap = snapshots.get(msg.cameraId);
          if (snap) {
            ws.send(JSON.stringify({ type: 'video-frame', cameraId: msg.cameraId, frame: snap, timestamp: Date.now() }));
          }
          break;

        case 'unsubscribe':
          viewer.subscribedTo.delete(msg.cameraId);
          ws.send(JSON.stringify({ type: 'unsubscribed', cameraId: msg.cameraId }));
          break;

        case 'subscribe-all':
          cameras.forEach((_, id) => viewer.subscribedTo.add(id));
          break;

        case 'unsubscribe-all':
          viewer.subscribedTo.clear();
          break;
      }
    } catch (e) {
      console.error('Viewer message error:', e.message);
    }
  });

  ws.on('close', () => {
    viewers.delete(ws);
    console.log(`👁 Viewer disconnected: ${viewerId}`);
  });
}

function sanitizeCam(cam) {
  return {
    id: cam.id,
    name: cam.name,
    location: cam.location,
    status: cam.status,
    lastSeen: cam.lastSeen,
    resolution: cam.resolution,
    fps: cam.fps,
    recording: cam.recording
  };
}

function broadcastToViewers(msg) {
  const data = JSON.stringify(msg);
  viewers.forEach((_, ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// Проверка камер каждые 30 сек
setInterval(() => {
  const now = Date.now();
  cameras.forEach((cam) => {
    if (cam.status === 'online' && now - cam.lastSeen > 60000) {
      cam.status = 'offline';
      broadcastToViewers({ type: 'camera-offline', cameraId: cam.id });
    }
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎥 Surveillance System running on http://localhost:${PORT}`);
  console.log(`📷 Camera page: http://localhost:${PORT}/camera.html`);
  console.log(`👁  Viewer page: http://localhost:${PORT}/index.html\n`);
});
