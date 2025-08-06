// whatsapp-manager.js

const { Client, LegacySessionAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data'); // FormData não é mais necessário, mas deixamos aqui caso precise trocar de serviço novamente.
const admin = require('firebase-admin');

// Inicialize o Firebase Admin SDK
// Em produção (Render), o JSON virá de uma variável de ambiente.
const serviceAccount = process.env.FIREBASE_KEY_JSON
    ? JSON.parse(process.env.FIREBASE_KEY_JSON)
    : require('./firebase-service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://pedagogia-systematrix-default-rtdb.firebaseio.com/` // <-- CONFIRME SE ESTA É SUA URL
});

const db = admin.database();
const clients = {}; // Objeto para armazenar as instâncias dos clientes por schoolId

// =======================================================================
// ===                    INÍCIO DA PARTE ALTERADA                     ===
// =======================================================================

/**
 * Faz o upload do arquivo de sessão para o Hastebin (substituto do 0x0.st)
 * e retorna a URL para o arquivo raw.
 * @param {string} sessionData - O conteúdo do arquivo de sessão em JSON string.
 * @returns {Promise<string|null>} - A URL do arquivo ou null em caso de erro.
 */
async function uploadSessionToFileHost(sessionData) {
    try {
        // Hastebin espera o conteúdo bruto no corpo da requisição POST
        const response = await axios.post('https://hastebin.com/documents', sessionData, {
            headers: { 'Content-Type': 'text/plain' },
        });

        // A resposta do Hastebin é um JSON como: { "key": "somekey" }
        const key = response.data.key;
        if (!key) {
            throw new Error('A resposta da API do Hastebin não incluiu uma chave (key).');
        }

        // Construímos a URL para o conteúdo bruto (raw)
        const rawUrl = `https://hastebin.com/raw/${key}`;
        console.log(`Sessão enviada para o Hastebin. URL raw: ${rawUrl}`);
        return rawUrl;

    } catch (error) {
        console.error('Erro ao fazer upload da sessão para o Hastebin:', error.message);
        // Log detalhado em caso de erro na resposta da API
        if (error.response) {
            console.error('Detalhes do erro da API Hastebin:', error.response.data);
        }
        return null;
    }
}

// =======================================================================
// ===                     FIM DA PARTE ALTERADA                       ===
// =======================================================================


/**
 * Baixa o arquivo de sessão a partir de uma URL.
 * @param {string} url - A URL do arquivo de sessão.
 * @returns {Promise<object|null>} - O objeto de sessão ou null em caso de erro.
 */
async function downloadSession(url) {
    try {
        const response = await axios.get(url);
        // O axios já deve parsear a resposta para JSON se o content-type estiver correto.
        // Se a resposta for uma string, tentamos fazer o parse manual.
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

    const client = new Client({
        authStrategy: new LegacySessionAuth({
            session: sessionData // Se for null, ele irá gerar um QR Code
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Necessário para rodar no Render
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
