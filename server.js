const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, LegacySessionAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);

// Corrigir o private_key
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

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

// ===================== UTILIDADES =====================
function encodeSessionData(data) {
  const encoded = {};
  for (const key in data) {
    encoded[key] = Buffer.from(JSON.stringify(data[key])).toString('base64');
  }
  return encoded;
}

function decodeSessionData(data) {
  const decoded = {};
  for (const key in data) {
    decoded[key] = JSON.parse(Buffer.from(data[key], 'base64').toString());
  }
  return decoded;
}

async function loadSession(schoolId) {
  const snap = await db.ref(`whatsapp_sessions/${schoolId}`).once('value');
  return snap.exists() ? decodeSessionData(snap.val()) : null;
}

async function saveSession(schoolId, session) {
  const encoded = encodeSessionData(session);
  await db.ref(`whatsapp_sessions/${schoolId}`).set(encoded);
}

// ===================== INSTÂNCIA WHATSAPP =====================
async function startWhatsAppInstance(schoolId) {
  if (whatsappInstances.has(schoolId)) return;

  const savedSession = await loadSession(schoolId);

  const client = new Client({
    authStrategy: new LegacySessionAuth({
      session: savedSession || undefined
    }),
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

  client.on('authenticated', (session) => {
    console.log(`🔐 [${schoolId}] Autenticado, salvando sessão`);
    saveSession(schoolId, session);
  });

  client.on('auth_failure', () => {
    whatsappInstances.get(schoolId).isReady = false;
    emitToSchool(schoolId, 'auth_failure');
    console.error(`❌ [${schoolId}] Falha de autenticação`);
  });

  client.on('disconnected', () => {
    whatsappInstances.get(schoolId).isReady = false;
    emitToSchool(schoolId, 'disconnected');
    console.warn(`🔌 [${schoolId}] Desconectado`);
  });

  client.initialize();
}

function emitToSchool(schoolId, event, data) {
  for (const [socketId, id] of socketToSchool.entries()) {
    if (id === schoolId) {
      io.to(socketId).emit(event, data);
    }
  }
}

// ===================== SOCKET.IO =====================
io.on('connection', (socket) => {
  console.log('🟢 Socket conectado:', socket.id);

  socket.on('join-school', async (schoolId) => {
    socketToSchool.set(socket.id, schoolId);
    console.log(`🔗 Socket ${socket.id} associado à escola ${schoolId}`);
    await startWhatsAppInstance(schoolId);

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

// ===================== ENVIO DE MENSAGENS =====================
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
    console.error(`Erro ao enviar para ${numero}:`, err);
    return res.status(500).json({ erro: err.message });
  }
});

// ===================== INÍCIO DO SERVIDOR =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor WhatsApp Multi-Instância rodando em http://localhost:${PORT}`);
  console.log('Hora: ', new Date);
});
