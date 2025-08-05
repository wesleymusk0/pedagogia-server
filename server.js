const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

// =============== CONFIG EXPRESS E SOCKET.IO ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

// =============== WHATSAPP CLIENT ===============
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

let isReady = false;

// Enviar QR para o front-end quando necessário
client.on('qr', async (qr) => {
  try {
    const qrDataURL = await QRCode.toDataURL(qr);
    io.emit('qr', qrDataURL);
    isReady = false;
    console.log('📲 QR code gerado e emitido');
  } catch (err) {
    console.error('Erro ao gerar QR Code:', err);
  }
});

// Quando conectado com sucesso
client.on('ready', () => {
  isReady = true;
  console.log('✅ WhatsApp conectado.');
  io.emit('ready');
});

// Falha de autenticação
client.on('auth_failure', () => {
  isReady = false;
  console.error('❌ Falha na autenticação do WhatsApp.');
  io.emit('auth_failure');
});

// Desconectado
client.on('disconnected', () => {
  isReady = false;
  console.warn('🔌 WhatsApp desconectado.');
  io.emit('disconnected');
});

// Iniciar cliente
client.initialize();

// =============== SOCKET.IO FRONTEND INTEGRAÇÃO ===============
io.on('connection', (socket) => {
  console.log(`🟢 Cliente conectado: ${socket.id}`);
  if (isReady) {
    socket.emit('ready');
  } else {
    socket.emit('waiting');
  }
});

// =============== ENDPOINT DE ENVIO DE MENSAGEM ===============
app.post('/enviar-whatsapp', async (req, res) => {
  const { numero, mensagem } = req.body;
  if (!numero || !mensagem) {
    return res.status(400).json({ erro: 'Número e mensagem são obrigatórios.' });
  }

  try {
    await client.sendMessage(`${numero}@c.us`, mensagem);
    console.log(`📤 Mensagem enviada para ${numero}`);
    return res.json({ sucesso: true, enviado: true });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro);
    return res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

// =============== ENDPOINT TESTE (opcional) ===============
app.get('/', (req, res) => {
  res.send('Servidor WhatsApp Web.js + Firebase está funcionando.');
});

// =============== INICIAR SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
