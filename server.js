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

// Objeto para rastrear os clientes ativos por schoolId
const clients = {};

// Cria estrutura de diretório local para a sessão
function ensureSessionDir(schoolId) {
    const authPath = path.join(SESSIONS_DIR, schoolId);
    fs.mkdirSync(authPath, { recursive: true });
}

// Caminho do arquivo de autenticação dentro da pasta de sessão
// whatsapp-web.js cria uma pasta "Default" dentro do dataPath
function getSessionPath(schoolId) {
    return path.join(SESSIONS_DIR, schoolId);
}

// Verifica se o cliente está realmente conectado ao WhatsApp
function verificarConexao(client) {
    // A verificação mais confiável é ver se o cliente tem um 'wid' (WhatsApp ID)
    return !!(client && client.info && client.info.wid);
}

// Função para iniciar uma nova sessão ou reconectar
function iniciarSessao(schoolId, socket) {
    console.log(`🚀 Iniciando sessão para ${schoolId}`);
    
    const authPath = getSessionPath(schoolId);
    ensureSessionDir(schoolId);

    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: authPath }),
        puppeteer: { 
            headless: true, 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // <- pode ajudar em ambientes com pouca memória
                '--disable-gpu'
            ]
        }
    });

    // Armazena o cliente recém-criado no nosso objeto de rastreamento
    clients[schoolId] = client;

    client.on('qr', async qr => {
        console.log(`📲 QR gerado para ${schoolId}`);
        try {
            const qrCode = await QRCode.toDataURL(qr);
            socket.emit('qr', qrCode); // Envia o QR para o socket correto
        } catch (err) {
            console.error(`Erro ao gerar QR Code para ${schoolId}:`, err);
        }
    });

    client.on('ready', () => {
        console.log(`✅ WhatsApp pronto para ${schoolId}`);
        socket.emit('ready');
    });

    client.on('authenticated', () => {
        console.log(`🔐 ${schoolId} autenticado`);
    });

    client.on('disconnected', (reason) => {
        console.log(`❌ ${schoolId} desconectado. Motivo:`, reason);
        socket.emit('disconnected');
        // Limpa o cliente da memória após a desconexão
        if (clients[schoolId]) {
            delete clients[schoolId];
        }
    });

    client.initialize().catch(err => {
        console.error(`Falha ao inicializar cliente para ${schoolId}:`, err);
    });
}

// Função para verificar se a sessão local existe
async function verificarSessaoLocal(schoolId, socket) {
    console.log(`📥 Verificando sessão local para ${schoolId}...`);
    const sessionDir = getSessionPath(schoolId);
    
    // O whatsapp-web.js cria uma pasta 'Default' se a sessão existe
    const sessionExists = fs.existsSync(path.join(sessionDir, 'Default'));

    if (!sessionExists) {
        console.log(`📭 Sessão não encontrada para ${schoolId}. Gerando QR...`);
    } else {
        console.log(`📁 Sessão encontrada para ${schoolId}. Tentando conectar...`);
    }

    iniciarSessao(schoolId, socket);
}

// Gerenciamento da conexão via WebSocket
io.on('connection', socket => {
    console.log('🔗 Socket conectado:', socket.id);

    socket.on('iniciar-sessao', async (schoolId) => {
        console.log(`🧠 Socket [${socket.id}] pediu início da sessão: ${schoolId}`);
        if (!schoolId) {
            console.log('❌ School ID ausente!');
            return;
        }

        // --- INÍCIO DA CORREÇÃO ---
        // Verifica se já existe um cliente para este schoolId (de uma conexão anterior/zumbi)
        if (clients[schoolId]) {
            console.log(`👻 Encontrado cliente existente para ${schoolId}. Destruindo...`);
            try {
                // .destroy() encerra a instância do puppeteer e limpa os recursos
                await clients[schoolId].destroy();
                console.log(`✅ Cliente antigo para ${schoolId} destruído.`);
            } catch (e) {
                console.error(`⚠️ Erro ao destruir cliente antigo para ${schoolId}:`, e.message);
            }
            delete clients[schoolId]; // Remove do nosso objeto de rastreamento
        }
        // --- FIM DA CORREÇÃO ---

        // Agora, com o ambiente limpo, procede com a criação de uma nova sessão
        verificarSessaoLocal(schoolId, socket);
    });

    socket.on('upload-session', async ({ sessionId, sessionData }) => {
        if (!sessionId || !sessionData) return;
        console.log(`📤 Recebido upload de sessão para ${sessionId}`);

        // --- INÍCIO DA CORREÇÃO (Consistência) ---
        // Garante que qualquer cliente existente seja destruído antes de restaurar a sessão
        if (clients[sessionId]) {
            console.log(`👻 Encontrado cliente existente para ${sessionId} antes do upload. Destruindo...`);
            try {
                await clients[sessionId].destroy();
                console.log(`✅ Cliente antigo para ${sessionId} destruído.`);
            } catch (e) {
                console.error(`⚠️ Erro ao destruir cliente antigo para ${sessionId}:`, e.message);
            }
            delete clients[sessionId];
        }
        // --- FIM DA CORREÇÃO ---

        const authPath = getSessionPath(sessionId);
        ensureSessionDir(sessionId);

        // O arquivo de sessão precisa ser salvo em um local específico que o LocalAuth espera
        const sessionFilePath = path.join(authPath, 'Default', 'session.json');
        fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });

        try {
            fs.writeFileSync(sessionFilePath, sessionData);
            console.log(`📄 Arquivo de sessão salvo em: ${sessionFilePath}`);
            iniciarSessao(sessionId, socket); // Inicia a sessão com o arquivo restaurado
        } catch (err) {
            console.error(`❌ Erro ao restaurar sessão ${sessionId}:`, err);
            socket.emit('disconnected');
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Socket desconectado:', socket.id);
        // A lógica de limpeza agora é tratada de forma mais robusta no início de uma nova conexão,
        // o que é mais confiável do que tentar limpar na desconexão.
    });
});

// Endpoint para envio de mensagens
app.post('/enviar-whatsapp', async (req, res) => {
    const { numero, mensagem, schoolId } = req.body;

    if (!numero || !mensagem || !schoolId) {
        return res.status(400).json({ sucesso: false, erro: 'Parâmetros obrigatórios ausentes.' });
    }

    const client = clients[schoolId];
    if (!client || !verificarConexao(client)) {
        return res.status(500).json({ sucesso: false, erro: 'Cliente do WhatsApp não está conectado ou pronto.' });
    }

    try {
        // Formata o número para o padrão do WhatsApp (ex: 5511999999999@c.us)
        const destinatario = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(destinatario, mensagem);
        res.json({ sucesso: true, mensagem: 'Mensagem enviada com sucesso.' });
        console.log(`📤 Mensagem enviada para ${numero} (da escola ${schoolId})`);
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ sucesso: false, erro: 'Falha ao enviar mensagem.' });
    }
});

// Inicializa o servidor HTTP
server.listen(PORT, () => {
    console.log(`🚀 Servidor PedagogIA rodando na porta ${PORT}`);
});
