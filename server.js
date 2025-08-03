const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const path = require('path');

// =============== CONFIGURAÇÃO DO FIREBASE ADMIN ===============
const serviceAccount = require('./pedagogia-systematrix-firebase-adminsdk-fbsvc-c6c428fcb2.json'); // <-- coloque seu JSON aqui

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix.firebaseio.com'
});

const db = admin.database();

// =============== CONFIGURAÇÃO DO SERVIDOR EXPRESS + SOCKET.IO ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // ou coloque seu domínio como: "https://systematrix.com.br"
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// =============== WHATSAPP-WEB.JS CLIENT ===============
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

// Emitir QR code para os clientes conectados
client.on('qr', async (qr) => {
  try {
    const qrCodeDataURL = await QRCode.toDataURL(qr);
    io.emit('qr', qrCodeDataURL);
    console.log('📲 Novo QR code emitido para conexão.');
  } catch (err) {
    console.error('Erro ao gerar QR Code:', err);
  }
});

// Emitir status de conexão
client.on('ready', () => {
  console.log('✅ WhatsApp está conectado.');
  io.emit('ready');
});

client.on('auth_failure', () => {
  console.log('❌ Falha de autenticação. Reconectando...');
  io.emit('auth_failure');
});

client.on('disconnected', () => {
  console.log('🔌 WhatsApp desconectado.');
  io.emit('disconnected');
});

// Iniciar WhatsApp
client.initialize();

// =============== SOCKET.IO CONEXÃO COM FRONT-END ===============
io.on('connection', (socket) => {
  console.log('🟢 Cliente conectado ao socket:', socket.id);
});

// =============== ENDPOINT DE ENVIO MANUAL DE MENSAGEM ===============
app.post('/enviar-whatsapp', async (req, res) => {
  const { numero, mensagem } = req.body;

  if (!numero || !mensagem) {
    return res.status(400).json({ erro: 'Número e mensagem são obrigatórios.' });
  }

  try {
    await client.sendMessage(`${numero}@c.us`, mensagem);
    return res.json({ sucesso: true, enviado: true });
  } catch (erro) {
    console.error('Erro ao enviar mensagem:', erro);
    return res.status(500).json({ sucesso: false, erro: erro.message });
  }
});

// =============== INICIAR SERVIDOR ===============
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
