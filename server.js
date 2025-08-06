const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Inicialização do Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://pedagogia-systematrix-default-rtdb.firebaseio.com"
});
const db = admin.database();

// Configurações do servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Diretório local para arquivos de sessão
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// Dicionário de instâncias de cliente
const clients = {};

// Utilitários para sessão
function getSessionPath(schoolId) {
    return path.join(SESSIONS_DIR, `${schoolId}.json`);
}

async function salvarSessao(schoolId, sessionPath) {
    const file = fs.readFileSync(sessionPath);
    const base64 = Buffer.from(file).toString('base64');
    await db.ref(`sessions/${schoolId}`).set(base64);
}

async function restaurarSessao(schoolId) {
    const snapshot = await db.ref(`sessions/${schoolId}`).once('value');
    if (!snapshot.exists()) return null;

    const sessionPath = getSessionPath(schoolId);
    fs.writeFileSync(sessionPath, Buffer.from(snapshot.val(), 'base64'));
    return sessionPath;
}

function verificarConexao(client) {
    return !!(client && client.info && client.info.wid);
}

// Criação e gerenciamento de sessões
async function iniciarSessao(schoolId, socket) {
    const authPath = path.join(SESSIONS_DIR, schoolId);
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { headless: true, args: ['--no-sandbox'] }
    });

    clients[schoolId] = client;

    client.on('qr', async qr => {
        const qrCode = await QRCode.toDataURL(qr);
        socket.emit('qr', qrCode);
    });

    client.on('ready', async () => {
        console.log(`✅ ${schoolId} conectado.`);
        socket.emit('ready');

        // Exportar o arquivo de sessão para download
        const sessionFile = path.join(authPath, 'Default', 'session.json');
        if (fs.existsSync(sessionFile)) {
            await salvarSessao(schoolId, sessionFile);
            const sessionData = fs.readFileSync(sessionFile, 'utf-8');
            socket.emit('download-session', sessionData);
        }
    });

    client.on('authenticated', () => {
        console.log(`🔐 ${schoolId} autenticado.`);
    });

    client.on('disconnected', async () => {
        console.log(`❌ ${schoolId} desconectado.`);
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    client.initialize();
}

// Verificação completa no início da conexão
async function verificarEstadoInicial(schoolId, socket) {
    // Se cliente já está conectado, apenas avisa
    if (clients[schoolId] && verificarConexao(clients[schoolId])) {
        socket.emit('ready');
        return;
    }

    const sessionPath = getSessionPath(schoolId);
    const existeNoFirebase = await db.ref(`sessions/${schoolId}`).once('value');

    if (!existeNoFirebase.exists()) {
        console.log(`⚠️ Sessão não encontrada no Firebase: ${schoolId}`);
        iniciarSessao(schoolId, socket); // Vai gerar QR rapidamente
        return;
    }

    try {
        fs.writeFileSync(sessionPath, Buffer.from(existeNoFirebase.val(), 'base64'));
        console.log(`📂 Sessão restaurada de ${schoolId}`);

        // Iniciar sessão normalmente
        iniciarSessao(schoolId, socket);

        // Aguarda até 10 segundos para confirmar conexão
        setTimeout(() => {
            const client = clients[schoolId];
            if (!verificarConexao(client)) {
                console.log(`⚠️ Sessão de ${schoolId} falhou. Forçando QR...`);
                client.logout().then(() => {
                    iniciarSessao(schoolId, socket);
                }).catch(() => {
                    iniciarSessao(schoolId, socket);
                });
            }
        }, 10000); // 10 segundos de tolerância
    } catch (err) {
        console.error(`❌ Erro ao restaurar sessão de ${schoolId}:`, err);
        iniciarSessao(schoolId, socket);
    }
}

// WebSocket
io.on('connection', socket => {
    console.log('🔗 Socket conectado');

    socket.on('iniciar-sessao', async (schoolId) => {
        if (!schoolId) return;
        await verificarEstadoInicial(schoolId, socket);
    });

    socket.on('upload-session', async ({ sessionId, sessionData }) => {
        if (!sessionId || !sessionData) return;

        const sessionPath = getSessionPath(sessionId);
        try {
            fs.writeFileSync(sessionPath, sessionData);
            await salvarSessao(sessionId, sessionPath);
            iniciarSessao(sessionId, socket);
        } catch (err) {
            console.error(`❌ Erro ao restaurar sessão de ${sessionId}:`, err);
            socket.emit('disconnected');
        }
    });
});

// Envio de mensagens via WhatsApp
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;
    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ erro: 'Parâmetros obrigatórios ausentes.' });
    }

    const client = clients[schoolId];
    if (!verificarConexao(client)) {
        return res.status(500).json({ erro: 'Cliente não conectado.' });
    }

    try {
        const formato = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(formato, mensagem);
        res.json({ sucesso: true });
    } catch (err) {
        console.error(`📤 Erro ao enviar mensagem para ${numero}:`, err);
        res.status(500).json({ erro: 'Erro ao enviar mensagem.' });
    }
});

// Inicia o servidor
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Backend PedagogIA rodando na porta ${PORT}`);
});
