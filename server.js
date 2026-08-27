const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));

const cameras = new Map();
const viewers = new Map();
const alerts = [];
const snapshots = new Map(); // cameraId -> Uint8Array (binary JPEG packet)
const cameraTokens = new Map();

// ===== REST API =====
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

app.get('/api/cameras', (req, res) => {
  const list = [];
  cameras.forEach((cam) => list.push(sanitizeCam(cam)));
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
  const { name, location } = req.body;
  if (name) cam.name = name;
  if (location) cam.location = location;
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
  broadcastToViewers({ type: 'camera-removed', cameraId: req.params.id });
  res.json({ success: true });
});

app.get('/api/alerts', (req, res) => {
  res.json(alerts.slice(-50).reverse());
});

app.delete('/api/alerts', (req, res) => {
  alerts.length = 0;
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  let online = 0;
  cameras.forEach(c => { if (c.status === 'online') online++; });
  res.json({
    totalCameras: cameras.size,
    onlineCameras: online,
    totalAlerts: alerts.length,
    unreadAlerts: alerts.filter(a => !a.read).length,
    viewersConnected: viewers.size
  });
});

// ===== WEBSOCKET =====
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
    if (cam.ws && cam.ws.readyState === 1) cam.ws.close();
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
      lastSeen: Date.now()
    };
    cameras.set(cameraId, cam);
  }

  console.log(`📷 Camera connected: ${name} (${cameraId})`);
  ws.send(JSON.stringify({ type: 'registered', id: cameraId }));
  broadcastToViewers({ type: 'camera-online', camera: sanitizeCam(cam) });

  ws.on('message', (data, isBinary) => {
    cam.lastSeen = Date.now();

    // БЫСТРЫЙ БИНАРНЫЙ МОСТ (Прямая пересылка байтов зрителям)
    if (isBinary) {
      if (data.length < 2) return;
      const idLen = data[0];
      const camId = data.subarray(1, 1 + idLen).toString('utf8');

      snapshots.set(camId, data);

      // Молниеносная пересылка байтов зрителям
      viewers.forEach((viewer, viewerWs) => {
        if (viewer.subscribedTo.has(camId) && viewerWs.readyState === 1) {
          viewerWs.send(data, { binary: true });
        }
      });
      return;
    }

    try {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'motion-detected') {
        const alert = {
          id: uuidv4(),
          cameraId,
          type: 'motion',
          message: msg.message || `Движение на ${cam.name}`,
          timestamp: Date.now(),
          read: false
        };
        alerts.push(alert);
        if (alerts.length > 500) alerts.shift();
        broadcastToViewers({ type: 'alert', alert });
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    cam.status = 'offline';
    cam.ws = null;
    console.log(`📷 Camera disconnected: ${name}`);
    broadcastToViewers({ type: 'camera-offline', cameraId });
  });
}

function handleViewerConnection(ws) {
  const viewerId = uuidv4();
  viewers.set(ws, { id: viewerId, subscribedTo: new Set() });

  const camList = [];
  cameras.forEach(c => camList.push(sanitizeCam(c)));
  ws.send(JSON.stringify({ type: 'camera-list', cameras: camList }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      const viewer = viewers.get(ws);
      if (!viewer) return;

      if (msg.type === 'subscribe') {
        viewer.subscribedTo.add(msg.cameraId);
        const snap = snapshots.get(msg.cameraId);
        if (snap && ws.readyState === 1) ws.send(snap, { binary: true });
      } else if (msg.type === 'subscribe-all') {
        cameras.forEach((_, id) => {
          viewer.subscribedTo.add(id);
          const s = snapshots.get(id);
          if (s && ws.readyState === 1) ws.send(s, { binary: true });
        });
      } else if (msg.type === 'unsubscribe-all') {
        viewer.subscribedTo.clear();
      }
    } catch (e) {}
  });

  ws.on('close', () => viewers.delete(ws));
}

function sanitizeCam(cam) {
  return { id: cam.id, name: cam.name, location: cam.location, status: cam.status };
}

function broadcastToViewers(msg) {
  const data = JSON.stringify(msg);
  viewers.forEach((_, ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎥 Server running on http://localhost:${PORT}`);
});
