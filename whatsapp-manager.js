// whatsapp-manager.js

// === INÍCIO DA MUDANÇA ===
// A importação agora é feita diretamente, desestruturando do require principal.
const { Client, LegacySessionAuth } = require('whatsapp-web.js');
// === FIM DA MUDANÇA ===

const qrcode = require('qrcode');
const axios = require('axios');
const admin = require('firebase-admin');

// O resto do seu código de inicialização do Firebase permanece o mesmo...
const serviceAccount = process.env.FIREBASE_KEY_JSON
    ? JSON.parse(process.env.FIREBASE_KEY_JSON)
    : require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://pedagogia-systematrix.firebaseio.com`
});

const db = admin.database();
const clients = {};

async function uploadSessionToFileHost(sessionData) {
    try {
        const response = await axios.post('https://hastebin.com/documents', sessionData, {
            headers: { 'Content-Type': 'text/plain' },
        });
        const key = response.data.key;
        if (!key) {
            throw new Error('A resposta da API do Hastebin não incluiu uma chave (key).');
        }
        const rawUrl = `https://hastebin.com/raw/${key}`;
        console.log(`Sessão enviada para o Hastebin. URL raw: ${rawUrl}`);
        return rawUrl;
    } catch (error) {
        console.error('Erro ao fazer upload da sessão para o Hastebin:', error.message);
        if (error.response) {
            console.error('Detalhes do erro da API Hastebin:', error.response.data);
        }
        return null;
    }
}

async function downloadSession(url) {
    try {
        const response = await axios.get(url);
        if (typeof response.data === 'string') {
            return JSON.parse(response.data);
        }
        if (typeof response.data === 'object' && response.data !== null) {
            return response.data;
        }
        return null;
    } catch (error) {
        console.error(`Falha ao baixar sessão da URL: ${url}`, error.message);
        return null;
    }
}

const initializeClient = async (schoolId, socket) => {
    console.log(`[${schoolId}] Iniciando inicialização do cliente...`);

    const sessionRef = db.ref(`escolas/${schoolId}/whatsappSession/sessionUrl`);
    const snapshot = await sessionRef.once('value');
    const sessionUrl = snapshot.val();
    let sessionData = null;

    if (sessionUrl) {
        console.log(`[${schoolId}] URL de sessão encontrada. Tentando baixar...`);
        sessionData = await downloadSession(sessionUrl);
        if (sessionData) {
            console.log(`[${schoolId}] Sessão baixada com sucesso.`);
            socket.emit('message', { text: 'Sessão encontrada. Restaurando...' });
        } else {
            console.log(`[${schoolId}] Falha ao baixar sessão. Prosseguindo com QR code.`);
        }
    } else {
        console.log(`[${schoolId}] Nenhuma sessão encontrada. Necessário escanear QR code.`);
    }

    // O código aqui agora funcionará, pois LegacySessionAuth está importado corretamente
    const client = new Client({
        authStrategy: new LegacySessionAuth({
            session: sessionData 
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log(`[${schoolId}] QR Code recebido.`);
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error(`[${schoolId}] Erro ao gerar QR Code:`, err);
                return;
            }
            socket.emit('qr', url);
            socket.emit('message', { text: 'QR Code recebido. Escaneie com seu celular.' });
        });
    });

    client.on('authenticated', async (session) => {
        console.log(`[${schoolId}] Cliente autenticado.`);
        const sessionJson = JSON.stringify(session);
        
        socket.emit('download-session', sessionJson);
        
        const newSessionUrl = await uploadSessionToFileHost(sessionJson);
        if (newSessionUrl) {
            await sessionRef.set(newSessionUrl);
            console.log(`[${schoolId}] Nova URL de sessão salva no Firebase: ${newSessionUrl}`);
        }
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
        sessionRef.remove();
    });

    client.on('disconnected', (reason) => {
        console.log(`[${schoolId}] Cliente foi desconectado:`, reason);
        delete clients[schoolId];
        socket.emit('disconnected');
        sessionRef.remove();
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
