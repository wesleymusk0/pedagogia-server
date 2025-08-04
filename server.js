const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');

const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk-fbsvc-c6c428fcb2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix.firebaseio.com'
});

const db = admin.database();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

const whatsappInstances = new Map(); // schoolId => { client, isReady }
const socketToSchool = new Map();    // socket.id => schoolId

// ========== Função para iniciar uma instância de WhatsApp ==========
function startWhatsAppInstance(schoolId) {
  if (whatsappInstances.has(schoolId)) return;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: schoolId }),
    puppeteer: { headless: true }
  });

  whatsappInstances.set(schoolId, { client, isReady: false });

  client.on('qr', async (qr) => {
    const qrDataURL = await QRCode.toDataURL(qr);
    emitToSchool(schoolId, 'qr', qrDataURL);
    whatsappInstances.get(schoolId).isReady = false;
    console.log(`📲 [${schoolId}] QR code gerado`);
  });

  client.on('ready', () => {
    whatsappInstances.get(schoolId).isReady = true;
    emitToSchool(schoolId, 'ready');
    console.log(`✅ [${schoolId}] WhatsApp conectado`);
  });

  client.on('auth_failure', () => {
    whatsappInstances.get(schoolId).isReady = false;
    emitToSchool(schoolId, 'auth_failure');
    console.error(`❌ [${schoolId}] Falha de autenticação`);
  });

  client.on('disconnected', () => {
    whatsappInstances.get(schoolId).isReady = false;
    emitToSchool(schoolId, 'disconnected');
    console.warn(`🔌 [${schoolId}] WhatsApp desconectado`);
  });

  client.initialize();
}

// ========== Emitir evento apenas para sockets daquela escola ==========
function emitToSchool(schoolId, event, data) {
  for (const [socketId, id] of socketToSchool.entries()) {
    if (id === schoolId) {
      io.to(socketId).emit(event, data);
    }
  }
}

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  console.log('🟢 Novo socket conectado:', socket.id);

  socket.on('join-school', (schoolId) => {
    socketToSchool.set(socket.id, schoolId);
    console.log(`🔗 Socket ${socket.id} associado à escola ${schoolId}`);

    if (!whatsappInstances.has(schoolId)) {
      startWhatsAppInstance(schoolId);
    }

    const instance = whatsappInstances.get(schoolId);
    if (instance?.isReady) {
      socket.emit('ready');
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('disconnect', () => {
    console.log('🔴 Socket desconectado:', socket.id);
    socketToSchool.delete(socket.id);
  });
});

// ========== ENDPOINT ENVIO DE MENSAGEM ==========
app.post('/enviar-whatsapp', async (req, res) => {
  const { numero, mensagem, schoolId } = req.body;

  if (!numero || !mensagem || !schoolId) {
    return res.status(400).json({ erro: 'Número, mensagem e schoolId são obrigatórios.' });
  }

  const instance = whatsappInstances.get(schoolId);
  if (!instance || !instance.isReady) {
    return res.status(400).json({ erro: 'Instância do WhatsApp não está pronta.' });
  }

  try {
    await instance.client.sendMessage(`${numero}@c.us`, mensagem);
    console.log(`📤 [${schoolId}] Mensagem enviada para ${numero}`);
    return res.json({ sucesso: true });
  } catch (err) {
    console.error(`Erro ao enviar mensagem para ${numero}:`, err);
    return res.status(500).json({ erro: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Multi-Instância Systematrix v4.0');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor ativo em http://localhost:${PORT}`);
});
