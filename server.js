const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const clients = {};

// Cria estrutura de diretório local para a sessão
function ensureSessionDir(schoolId) {
    const authPath = path.join(SESSIONS_DIR, schoolId, 'Default');
    fs.mkdirSync(authPath, { recursive: true });
}

// Caminho do arquivo session.json
function getSessionFile(schoolId) {
    return path.join(SESSIONS_DIR, schoolId, 'Default', 'session.json');
}

// Verifica se o cliente está realmente conectado ao WhatsApp
function verificarConexao(client) {
    return !!(client && client.info && client.info.wid);
}

// Inicia nova sessão ou reconecta
function iniciarSessao(schoolId, socket) {
    console.log(`🚀 Iniciando sessão para ${schoolId}`);
    ensureSessionDir(schoolId);

    const authPath = path.join(SESSIONS_DIR, schoolId);
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { headless: true, args: ['--no-sandbox'] }
    });

    clients[schoolId] = client;

    client.on('qr', async qr => {
        console.log(`📲 QR gerado para ${schoolId}`);
        const qrCode = await QRCode.toDataURL(qr);
        socket.emit('qr', qrCode);
    });

    client.on('ready', () => {
        console.log(`✅ WhatsApp pronto para ${schoolId}`);
        socket.emit('ready');

        const sessionPath = getSessionFile(schoolId);
        if (fs.existsSync(sessionPath)) {
            const sessionData = fs.readFileSync(sessionPath, 'utf-8');
            socket.emit('download-session', sessionData);
            console.log(`📦 Arquivo de sessão enviado para ${schoolId}`);
        }
    });

    client.on('authenticated', () => {
        console.log(`🔐 ${schoolId} autenticado`);
    });

    client.on('disconnected', () => {
        console.log(`❌ ${schoolId} desconectado`);
        socket.emit('disconnected');
        delete clients[schoolId];
    });

    client.initialize();
}

// Verifica se a sessão local existe e tenta reconectar, senão força QR
async function verificarSessaoLocal(schoolId, socket) {
    console.log(`📥 Verificando sessão local para ${schoolId}...`);
    const sessionJsonPath = getSessionFile(schoolId);

    if (!fs.existsSync(sessionJsonPath)) {
        console.log(`📭 Sessão não encontrada para ${schoolId}. Gerando QR...`);
        iniciarSessao(schoolId, socket);
        return;
    }

    console.log(`📁 Sessão encontrada para ${schoolId}. Tentando conectar...`);
    iniciarSessao(schoolId, socket);

    // Aguarda 10 segundos. Se não conectar, força QR
    setTimeout(() => {
        const client = clients[schoolId];
        if (!verificarConexao(client)) {
            console.log(`⚠️ Sessão inválida para ${schoolId}. Forçando QR...`);
            if (client) {
                client.logout().then(() => {
                    iniciarSessao(schoolId, socket);
                }).catch(() => {
                    iniciarSessao(schoolId, socket);
                });
            } else {
                iniciarSessao(schoolId, socket);
            }
        } else {
            console.log(`✅ Sessão validada com sucesso para ${schoolId}`);
        }
    }, 10000);
}

// Conexão via WebSocket
io.on('connection', socket => {
    console.log('🔗 Socket conectado');

    socket.on('iniciar-sessao', async (schoolId) => {
        console.log(`🧠 Socket pediu início da sessão: ${schoolId}`);
        if (!schoolId) {
            console.log('❌ School ID ausente!');
            return;
        }
        verificarSessaoLocal(schoolId, socket);
    });

    socket.on('upload-session', ({ sessionId, sessionData }) => {
        if (!sessionId || !sessionData) return;

        console.log(`📤 Recebido upload de sessão para ${sessionId}`);
        const sessionPath = getSessionFile(sessionId);
        ensureSessionDir(sessionId);

        try {
            fs.writeFileSync(sessionPath, sessionData);
            iniciarSessao(sessionId, socket);
        } catch (err) {
            console.error(`❌ Erro ao restaurar sessão ${sessionId}:`, err);
            socket.emit('disconnected');
        }
    });
});

// Endpoint para envio de mensagens
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;

    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ erro: 'Parâmetros obrigatórios ausentes.' });
    }

    const client = clients[schoolId];
    if (!verificarConexao(client)) {
        return res.status(500).json({ erro: 'Cliente não está conectado.' });
    }

    try {
        const destinatario = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(destinatario, mensagem);
        res.json({ sucesso: true });
        console.log(`📤 Mensagem enviada para ${numero} (${schoolId})`);
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ erro: 'Falha ao enviar mensagem.' });
    }
});

// Inicializa servidor
server.listen(PORT, () => {
    console.log(`🚀 Backend PedagogIA rodando na porta ${PORT}`);
});
