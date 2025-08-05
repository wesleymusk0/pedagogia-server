const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// ========= CONFIG FIREBASE =========
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON); // RECOMENDADO: usar variável de ambiente
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://pedagogia-systematrix-default-rtdb.firebaseio.com" // Altere aqui
});
const db = admin.database();

// ========= EXPRESS SETUP =========
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ========= SESSÕES =========
const activeClients = {};

function getSessionPath(sessionName) {
  return path.join(__dirname, `.wwebjs_auth/session-${sessionName}`);
}

async function uploadSessionToFirebase(sessionName) {
  const sessionPath = getSessionPath(sessionName);
  if (!fs.existsSync(sessionPath)) return;

  const files = fs.readdirSync(sessionPath);
  
  for (const file of files) {
    const filePath = path.join(sessionPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isFile()) {
      const content = fs.readFileSync(filePath, { encoding: 'base64' });
      await db.ref(`sessions/${sessionName}/${file}`).set(content);
    }
  }
}


async function restoreSessionFromFirebase(sessionName) {
  const sessionPath = getSessionPath(sessionName);
  fs.mkdirSync(sessionPath, { recursive: true });

  const snapshot = await db.ref(`sessions/${sessionName}`).once('value');
  const files = snapshot.val();
  if (files) {
    for (const [file, base64] of Object.entries(files)) {
      const filePath = path.join(sessionPath, file);
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    }
  }
}

async function startSession(sessionName, res) {
  if (activeClients[sessionName]) {
    if (!res.headersSent) res.send({ status: 'Já conectado' });
    return;
  }

  await restoreSessionFromFirebase(sessionName);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: sessionName }),
    puppeteer: { args: ['--no-sandbox'] }
  });

  let responseSent = false;

  client.on('qr', qr => {
    if (responseSent) return;
    QRCode.toDataURL(qr, (err, url) => {
      if (!responseSent && !res.headersSent) {
        res.send({ status: 'QRCode', qr: url });
        responseSent = true;
      }
    });
  });

  client.on('ready', async () => {
    console.log(`✅ Sessão ${sessionName} pronta`);
    await uploadSessionToFirebase(sessionName);
    if (!responseSent && !res.headersSent) {
      res.send({ status: 'Conectado e pronto' });
      responseSent = true;
    }
  });

  client.on('authenticated', async () => {
    console.log(`🔐 Sessão ${sessionName} autenticada`);
    await uploadSessionToFirebase(sessionName);
  });

  client.on('disconnected', reason => {
    console.log(`❌ Sessão ${sessionName} desconectada: ${reason}`);
    delete activeClients[sessionName];
  });

  client.initialize();
  activeClients[sessionName] = client;
}
// ========= ROTAS =========

app.post('/start/:session', async (req, res) => {
  const sessionName = req.params.session;
  try {
    await startSession(sessionName, res);
  } catch (e) {
    console.error(e);
    res.status(500).send({ error: 'Erro ao iniciar sessão' });
  }
});

app.post('/enviar-whatsapp', async (req, res) => {
  const { numero, mensagem, schoolId } = req.body;

  if (!numero || !mensagem || !schoolId) {
    return res.status(400).json({ sucesso: false, erro: 'Campos obrigatórios ausentes.' });
  }

  const client = activeClients[schoolId];

  if (!client) {
    return res.status(404).json({ sucesso: false, erro: `Sessão ${schoolId} não está ativa.` });
  }

  try {
    const numeroFormatado = numero.includes('@c.us') ? numero : `${numero}@c.us`;
    await client.sendMessage(numeroFormatado, mensagem);
    return res.status(200).json({ sucesso: true, enviadoPara: numeroFormatado });
  } catch (error) {
    console.error(`Erro ao enviar mensagem para ${numero} na sessão ${schoolId}:`, error);
    return res.status(500).json({ sucesso: false, erro: 'Erro ao enviar mensagem.', detalhes: error.toString() });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
