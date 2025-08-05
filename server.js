const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LegacySessionAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

// =============== CONFIG FIREBASE ADMIN ===============
const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk-fbsvc-c6c428fcb2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix-default-rtdb.firebaseio.com'
});
const db = admin.database();

const FIREBASE_DB_URL = 'https://pedagogia-systematrix-default-rtdb.firebaseio.com'; // sem / no final

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
const activeSockets = new Map(); // Map<deviceId, socketId>

async function getSessionFromFirebase(schoolId) {
    try {
        const res = await axios.get(`${FIREBASE_DB_URL}/whatsapp-sessions/${schoolId}.json`);
        if (res.data && res.data.session) {
            return res.data.session;
        }
    } catch (err) {
        console.warn(`[⚠️] Sessão não encontrada no Firebase: ${schoolId}`);
    }
    return null;
}

async function saveSessionToFirebase(schoolId, session) {
    try {
        await axios.put(`${FIREBASE_DB_URL}/whatsapp-sessions/${schoolId}.json`, {
            session: session
        });
        console.log(`[✅] Sessão de ${schoolId} salva no Firebase`);
    } catch (err) {
        console.error(`[❌] Erro ao salvar sessão no Firebase:`, err.message);
    }
}

// Criar cliente WhatsApp com persistência de sessão
async function createClient(schoolId, socket) {
    const session = await getSessionFromFirebase(schoolId);

    const client = new Client({
        authStrategy: new LegacySessionAuth({
            session: session || undefined
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox']
        }
    });

    client.on('authenticated', async (sessionData) => {
        console.log(`[🔐] Autenticado: ${schoolId}`);
        await saveSessionToFirebase(schoolId, sessionData);
    });

    client.on('ready', () => {
        console.log(`[✅] WhatsApp pronto para ${schoolId}`);
        socket.emit('ready', { deviceId: schoolId });
    });

    client.on('disconnected', () => {
        console.log(`[⚠️] Desconectado: ${schoolId}`);
        socket.emit('disconnected', { deviceId: schoolId });
    });

    client.on('qr', async (qr) => {
        const qrDataURL = await QRCode.toDataURL(qr);
        socket.emit('qr', { deviceId: schoolId, qr: qrDataURL });
        console.log(`[📲] QR code emitido para ${schoolId}`);
    });

    client.initialize();
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

    // Bloqueia chamadas simultâneas para o mesmo deviceId
    if (activeSockets.has(deviceId)) {
      const oldSocketId = activeSockets.get(deviceId);
      if (oldSocketId !== socket.id) {
        activeSockets.delete(deviceId);
        console.log('Conexão já existente da mesma escola cancelada!')
      }
    }
  
    activeSockets.set(deviceId, socket.id);
    
    if (clients.has(deviceId)) {
      const client = clients.get(deviceId);
    
      if (client.info?.wid) {
        socket.emit('info', `Sessão ${deviceId} já está ativa.`);
        return;
      }
    
      try {
        await client.destroy(); // Garante que a sessão anterior seja encerrada
        clients.delete(deviceId);
        console.log(`Sessão travada ${deviceId} encerrada.`);
      } catch (e) {
        console.warn(`Erro ao destruir sessão travada ${deviceId}:`, e.message);
      }
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
      for (const [deviceId, sockId] of activeSockets.entries()) {
        if (sockId === socket.id) {
          activeSockets.delete(deviceId);
        }
      }
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
