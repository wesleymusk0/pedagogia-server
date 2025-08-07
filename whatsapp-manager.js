// whatsapp-manager.js

// Importação correta da biblioteca principal
const { Client, RemoteAuth } = require('whatsapp-web.js');
// Importação correta da biblioteca de store. A classe chama-se MongoStore.
const { MongoStore } = require('wwebjs-mongo');
const admin = require('firebase-admin');

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
// A classe é MongoStore, mas funciona com o objeto 'db' do Firebase Admin
const store = new MongoStore({
    db: db, 
    collectionName: 'whatsapp_sessions'
});

const clients = {}; 

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando inicialização do cliente com RemoteAuth e Firebase Store...`);
    
    const client = new Client({
        authStrategy: new RemoteAuth({
            clientId: schoolId,
            store: store,
            backupSyncIntervalMs: 300000 // Salva um backup a cada 5 minutos
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`[${schoolId}] QR Code recebido. Enviando para o cliente.`);
        // Para o frontend, precisamos converter o QR em uma URL de dados
        // Vamos precisar do 'qrcode' de volta.
        const qrcode = require('qrcode');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR Code:`, err);
                return;
            }
            socket.emit('qr', url);
            socket.emit('message', { text: 'QR Code recebido. Escaneie com seu celular.' });
        });
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
