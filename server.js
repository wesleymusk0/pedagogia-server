const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LegacySessionAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');

// =============== CONFIG FIREBASE ADMIN ===============
const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk-fbsvc-c6c428fcb2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix.firebaseio.com'
});
const db = admin.database();

// Teste simples
db.ref('teste-systematrix').set({ status: 'ok', timestamp: Date.now() })
  .then(() => console.log('✅ Firebase Database funciona'))
  .catch((error) => console.error('❌ Erro ao gravar no Firebase:', error));

// =============== CONFIG EXPRESS E SOCKET.IO ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// =============== GERENCIAMENTO DE CLIENTES ===============
const clients = new Map(); // Map<deviceId, Client>

// Salvar sessão no Firebase
async function saveSessionToFirebase(deviceId, session) {
  try {
    await db.ref(`whatsapp-sessions/${deviceId}`).set(session);
    console.log(`Sessão ${deviceId} salva no Firebase.`);
  } catch (error) {
    console.error(`Erro ao salvar sessão ${deviceId}:`, error);
  }
}

// Carregar sessão do Firebase
async function loadSessionFromFirebase(deviceId) {
  try {
    const snapshot = await db.ref(`whatsapp-sessions/${deviceId}`).once('value');
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error(`Erro ao carregar sessão ${deviceId}:`, error);
    return null;
  }
}

// Criar cliente WhatsApp com persistência de sessão
async function createClient(deviceId, socket) {
  const savedSession = await loadSessionFromFirebase(deviceId);

  const client = new Client({
    authStrategy: new LegacySessionAuth({ session: savedSession }),
    puppeteer: { headless: true }
  });

  // Eventos do WhatsApp client
  client.on('qr', async (qr) => {
    try {
      const qrDataURL = await QRCode.toDataURL(qr);
      socket.emit('qr', { deviceId, qr: qrDataURL });
      console.log(`[${deviceId}] QR code gerado e enviado ao frontend.`);
    } catch (err) {
      console.error(`[${deviceId}] Erro ao gerar QR code:`, err);
    }
  });

  client.on('ready', () => {
    socket.emit('ready', { deviceId });
    console.log(`[${deviceId}] WhatsApp pronto.`);
  });

  client.on('authenticated', (session) => {
    saveSessionToFirebase(deviceId, session);
  });

  client.on('auth_failure', () => {
    socket.emit('auth_failure', { deviceId });
    console.error(`[${deviceId}] Falha na autenticação. Removendo sessão.`);
    db.ref(`whatsapp-sessions/${deviceId}`).remove();
  });

  client.on('disconnected', (reason) => {
    socket.emit('disconnected', { deviceId, reason });
    console.log(`[${deviceId}] WhatsApp desconectado: ${reason}`);
    clients.delete(deviceId);
    client.destroy();
  });

  await client.initialize();

  return client;
}

// =============== SOCKET.IO ===============
io.on('connection', (socket) => {
  console.log(`Cliente conectado no Socket.IO: ${socket.id}`);

  socket.on('startSession', async ({ deviceId }) => {
    if (!deviceId) {
      socket.emit('error', 'deviceId é obrigatório');
      return;
    }
    if (clients.has(deviceId)) {
      socket.emit('info', `Sessão ${deviceId} já está ativa.`);
      return;
    }

    try {
      const client = await createClient(deviceId, socket);
      clients.set(deviceId, client);
      socket.emit('started', { deviceId });
    } catch (error) {
      console.error(`Erro ao iniciar cliente ${deviceId}:`, error);
      socket.emit('error', `Erro ao iniciar sessão ${deviceId}`);
    }
  });

  socket.on('stopSession', ({ deviceId }) => {
    const client = clients.get(deviceId);
    if (client) {
      client.destroy();
      clients.delete(deviceId);
      socket.emit('stopped', { deviceId });
      console.log(`Sessão ${deviceId} parada.`);
    }
  });
});

// =============== ENDPOINT PARA ENVIAR MENSAGEM ===============
app.post('/enviar-whatsapp', async (req, res) => {
  const { deviceId, numero, mensagem } = req.body;
  if (!deviceId || !numero || !mensagem) {
    return res.status(400).json({ erro: 'deviceId, número e mensagem são obrigatórios.' });
  }

  const client = clients.get(deviceId);
  if (!client) {
    return res.status(404).json({ erro: 'Cliente WhatsApp não encontrado para o deviceId informado.' });
  }

  try {
    await client.sendMessage(`${numero}@c.us`, mensagem);
    console.log(`Mensagem enviada para ${numero} via sessão ${deviceId}.`);
    return res.json({ sucesso: true, enviado: true });
  } catch (error) {
    console.error(`Erro ao enviar mensagem via ${deviceId}:`, error);
    return res.status(500).json({ sucesso: false, erro: error.message });
  }
});

// =============== ENDPOINT TESTE ===============
app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Web.js com múltiplas sessões e persistência no Firebase está funcionando.');
});

// =============== INICIAR SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
