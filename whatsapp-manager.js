// whatsapp-manager.js

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { FirebaseStore } = require('wwebjs-mongo'); // Nome enganoso, mas funciona com Firebase!
const admin = require('firebase-admin');

// Não precisamos de 'qrcode', pois a RemoteAuth não o usa diretamente dessa forma.

// Inicialize o Firebase Admin SDK
const serviceAccount = process.env.FIREBASE_KEY_JSON
    ? JSON.parse(process.env.FIREBASE_KEY_JSON)
    : require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://pedagogia-systematrix-default-rtdb.firebaseio.com`
});

const db = admin.database();

// Criamos um "Store" compatível que usa o Firebase Realtime Database
const store = new FirebaseStore({
    db: db, // Passa a instância do banco de dados do Firebase
    collectionName: 'whatsapp_sessions' // Nome do "nó" onde as sessões serão salvas
});

// A estratégia de autenticação agora será a RemoteAuth, que é feita para isso
const authStrategy = new RemoteAuth({
    store: store,
    backupSyncIntervalMs: 300000 // Salva um backup a cada 5 minutos
});

const clients = {}; 

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando inicialização do cliente com RemoteAuth e Firebase Store...`);
    
    // A RemoteAuth cuidará de verificar se já existe uma sessão para este `clientId` no Firebase
    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: schoolId,
            store: store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        // Este evento ainda pode ser acionado se não houver sessão salva
        console.log(`[${schoolId}] QR Code recebido. Enviando para o cliente.`);
        socket.emit('qr', qr); // O frontend já sabe como transformar isso em uma imagem
        socket.emit('message', { text: 'QR Code recebido. Escaneie com seu celular.' });
    });

    client.on('remote_session_saved', () => {
        console.log(`[${schoolId}] Sessão remota salva com sucesso no Firebase!`);
    });

    client.on('ready', () => {
        console.log(`[${schoolId}] Cliente do WhatsApp está pronto!`);
        clients[schoolId] = client;
        socket.emit('ready');
        socket.emit('message', { text: 'WhatsApp conectado com sucesso!' });
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${schoolId}] Falha na autenticação:`, msg);
        socket.emit('disconnected');
    });

    client.on('disconnected', (reason) => {
        console.log(`[${schoolId}] Cliente foi desconectado:`, reason);
        delete clients[schoolId];
        socket.emit('disconnected');
    });

    client.initialize().catch(err => {
        console.error(`[${schoolId}] Erro ao inicializar o cliente: `, err);
    });
};

const sendMessage = async (schoolId, numero, mensagem) => {
    const client = clients[schoolId];
    if (!client) {
        return { sucesso: false, mensagem: "Sessão não iniciada para esta escola." };
    }

    try {
        const chatId = `${numero.replace(/\D/g, '')}@c.us`;
        await client.sendMessage(chatId, mensagem);
        console.log(`[${schoolId}] Mensagem enviada para ${chatId}`);
        return { sucesso: true, mensagem: "Mensagem enviada." };
    } catch (error) {
        console.error(`[${schoolId}] Erro ao enviar mensagem para ${numero}:`, error);
        return { sucesso: false, mensagem: "Falha ao enviar mensagem." };
    }
};

module.exports = {
    initializeClient,
    sendMessage
};
