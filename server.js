const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Inicialização do Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount), databaseURL: "https://pedagogia-systematrix-default-rtdb.firebaseio.com" });
const db = admin.database();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const clients = {}; // Armazena instâncias do WhatsApp

// Carrega sessão salva do Firebase
async function carregarSessao(schoolId) {
    const snapshot = await db.ref(`sessions/${schoolId}`).once('value');
    if (!snapshot.exists()) return null;
    const base64 = snapshot.val();
    const sessionPath = path.join(SESSIONS_DIR, `${schoolId}.json`);
    fs.writeFileSync(sessionPath, Buffer.from(base64, 'base64'));
    return sessionPath;
}

// Salva sessão no Firebase
async function salvarSessao(schoolId, sessionPath) {
    const data = fs.readFileSync(sessionPath);
    const base64 = Buffer.from(data).toString('base64');
    await db.ref(`sessions/${schoolId}`).set(base64);
}

// Cria uma nova sessão do WhatsApp
async function iniciarSessao(schoolId, socket) {
    const authPath = path.join(SESSIONS_DIR, schoolId);
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { headless: true, args: ['--no-sandbox'] }
    });

    clients[schoolId] = client;

    client.on('qr', async qr => {
        const qrImg = await QRCode.toDataURL(qr);
        socket.emit('qr', qrImg);
    });

    client.on('ready', async () => {
        socket.emit('ready');
        const sessionFile = path.join(authPath, 'Default', 'session.json');
        if (fs.existsSync(sessionFile)) {
            await salvarSessao(schoolId, sessionFile);
            const sessionData = fs.readFileSync(sessionFile, 'utf-8');
            socket.emit('download-session', sessionData);
        }
    });

    client.on('authenticated', () => console.log(`✅ ${schoolId} autenticado.`));
    client.on('disconnected', async () => {
        console.log(`❌ ${schoolId} desconectado.`);
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    client.initialize();
}

// Socket.IO
io.on('connection', socket => {
    console.log('🔗 Socket conectado');

    socket.on('iniciar-sessao', async (schoolId) => {
        if (clients[schoolId]) {
            socket.emit('ready');
            return;
        }

        try {
            await carregarSessao(schoolId);
        } catch (err) {
            console.error('⚠️ Erro ao carregar sessão:', err);
        }

        await iniciarSessao(schoolId, socket);
    });

    socket.on('upload-session', async ({ sessionId, sessionData }) => {
        const sessionPath = path.join(SESSIONS_DIR, `${sessionId}.json`);
        fs.writeFileSync(sessionPath, sessionData);
        await salvarSessao(sessionId, sessionPath);
        await iniciarSessao(sessionId, socket);
    });
});

// Enviar mensagem pelo WhatsApp
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;

    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ erro: 'Parâmetros inválidos.' });
    }

    const client = clients[schoolId];
    if (!client) return res.status(500).json({ erro: 'Cliente WhatsApp não conectado.' });

    try {
        const numeroComDdd = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(numeroComDdd, mensagem);
        res.json({ sucesso: true });
    } catch (error) {
        console.error('Erro ao enviar WhatsApp:', error);
        res.status(500).json({ erro: 'Erro ao enviar mensagem.' });
    }
});

server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
