const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 }); // Увеличил лимит до 50мб на всякий случай

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

// ===== Хранилище =====
const cameras = new Map();
const viewers = new Map();
const recordings = new Map();
const alerts = [];
const motionZones = new Map();
const snapshots = new Map();
const cameraTokens = new Map(); // token -> { name, location, createdAt }

// ===== REST API =====

// Генерация ссылки на камеру
app.post('/api/generate-link', (req, res) => {
  const { name, location } = req.body;
  const token = uuidv4();
  cameraTokens.set(token, {
    name: name || 'New Camera',
    location: location || 'Unknown',
    createdAt: Date.now()
  });

  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');
  const url = `${protocol}://${host}/camera.html?token=${token}&name=${encodeURIComponent(name || '')}&location=${encodeURIComponent(location || '')}&autostart=1`;

  res.json({ token, url });
});

app.get('/api/token/:token', (req, res) => {
  const info = cameraTokens.get(req.params.token);
  if (!info) return res.status(404).json({ error: 'Invalid token' });
  res.json(info);
});

app.get('/api/cameras', (req, res) => {
  const list = [];
  cameras.forEach((cam) => {
    list.push(sanitizeCam(cam));
  });
  res.json(list);
});

app.get('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  res.json(sanitizeCam(cam));
});

app.put('/api/cameras/:id', (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  const { name, location, recording, fps, resolution } = req.body;
  if (name) cam.name = name;
  if (location) cam.location = location;
  if (recording !== undefined) cam.recording = recording;
  if (fps) cam.fps = fps;
  if (resolution) cam.resolution = resolution;

  if (cam.ws && cam.ws.readyState === 1) {
    cam.ws.send(JSON.stringify({ type: 'settings-update', settings: { recording: cam.recording, fps: cam.fps, resolution: cam.resolution } }));
  }
  broadcastToViewers({ type: 'camera-updated', camera: sanitizeCam(cam) });
  res.json({ success: true });
});

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

app.get('/api/cameras/:id/snapshot', (req, res) => {
  const snap = snapshots.get(req.params.id);
  if (!snap) return res.status(404).json({ error: 'No snapshot' });
  res.json({ snapshot: snap });
});

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
  const role = url.searchParams.get('role');

  if (role === 'camera') {
    handleCameraConnection(ws, url);
  } else {
    handleViewerConnection(ws);
  }
});

function handleCameraConnection(ws, url) {
  const token = url.searchParams.get('token');
  let cameraId;
  let name, location;

  // Если есть токен — используем его как ID
  if (token && cameraTokens.has(token)) {
    cameraId = token;
    const tokenInfo = cameraTokens.get(token);
    name = decodeURIComponent(url.searchParams.get('name') || tokenInfo.name);
    location = decodeURIComponent(url.searchParams.get('location') || tokenInfo.location);
  } else {
    cameraId = url.searchParams.get('id') || uuidv4();
    name = decodeURIComponent(url.searchParams.get('name') || `Camera-${cameraId.slice(0, 6)}`);
    location = decodeURIComponent(url.searchParams.get('location') || 'Unknown');
  }

  let cam = cameras.get(cameraId);
  if (cam) {
    if (cam.ws && cam.ws.readyState === 1) {
      cam.ws.close();
    }
    cam.ws = ws;
    cam.status = 'online';
    cam.lastSeen = Date.now();
    cam.name = name;
    cam.location = location;
  } else {
    cam = {
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
  }

  console.log(`📷 Camera connected: ${name} (${cameraId})`);

  ws.send(JSON.stringify({ type: 'registered', id: cameraId }));
  broadcastToViewers({ type: 'camera-online', camera: sanitizeCam(cam) });

  ws.on('message', (data, isBinary) => {
    try {
      cam.lastSeen = Date.now();

      if (isBinary) {
        const base64 = Buffer.from(data).toString('base64');
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        snapshots.set(cameraId, dataUrl);
        viewers.forEach((viewer, viewerWs) => {
          if (viewer.subscribedTo.has(cameraId) && viewerWs.readyState === 1) {
            viewerWs.send(JSON.stringify({ type: 'video-frame', cameraId, frame: dataUrl, timestamp: Date.now() }));
          }
        });
        return;
      }

      const text = data.toString('utf8');
      const msg = JSON.parse(text);

      switch (msg.type) {
        case 'frame':
          if (msg.frame) {
            snapshots.set(cameraId, msg.frame);
            viewers.forEach((viewer, viewerWs) => {
              if (viewer.subscribedTo.has(cameraId) && viewerWs.readyState === 1) {
                viewerWs.send(JSON.stringify({ type: 'video-frame', cameraId, frame: msg.frame, timestamp: Date.now() }));
              }
            });
          }
          break;

        case 'motion-detected':
          const alert = {
            id: uuidv4(),
            cameraId,
            type: 'motion',
            message: msg.message || `Движение на ${cam.name}`,
            timestamp: Date.now(),
            read: false
          };
          alerts.push(alert);
          if (alerts.length > 1000) alerts.splice(0, alerts.length - 1000);
          broadcastToViewers({ type: 'alert', alert });
          break;

        case 'status':
          cam.resolution = msg.resolution || cam.resolution;
          cam.fps = msg.fps || cam.fps;
          break;
      }
    } catch (e) {
      console.error('Camera msg error:', e.message);
    }
  });

  ws.on('close', () => {
    cam.status = 'offline';
    cam.ws = null;
    console.log(`📷 Disconnected: ${name}`);
    broadcastToViewers({ type: 'camera-offline', cameraId });
  });

  ws.on('error', (err) => {
    cam.status = 'offline';
    cam.ws = null;
  });
}

function handleViewerConnection(ws) {
  const viewerId = uuidv4();
  viewers.set(ws, { id: viewerId, subscribedTo: new Set() });
  console.log(`👁 Viewer connected: ${viewerId}`);

  const camList = [];
  cameras.forEach(c => camList.push(sanitizeCam(c)));
  ws.send(JSON.stringify({ type: 'camera-list', cameras: camList }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      const viewer = viewers.get(ws);
      if (!viewer) return;

      switch (msg.type) {
        case 'subscribe':
          viewer.subscribedTo.add(msg.cameraId);
          ws.send(JSON.stringify({ type: 'subscribed', cameraId: msg.cameraId }));
          const snap = snapshots.get(msg.cameraId);
          if (snap) {
            ws.send(JSON.stringify({ type: 'video-frame', cameraId: msg.cameraId, frame: snap, timestamp: Date.now() }));
          }
          break;

        case 'unsubscribe':
          viewer.subscribedTo.delete(msg.cameraId);
          break;

        case 'subscribe-all':
          cameras.forEach((_, id) => viewer.subscribedTo.add(id));
          cameras.forEach((_, id) => {
            const s = snapshots.get(id);
            if (s) {
              ws.send(JSON.stringify({ type: 'video-frame', cameraId: id, frame: s, timestamp: Date.now() }));
            }
          });
          break;

        case 'unsubscribe-all':
          viewer.subscribedTo.clear();
          break;
      }
    } catch (e) {
      console.error('Viewer msg error:', e.message);
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎥 Server running on http://localhost:${PORT}`);
});
