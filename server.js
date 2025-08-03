const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const path = require('path');

// Inicializar Firebase Admin
const serviceAccount = require('./credenciais-firebase.json'); // JSON do projeto Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://pedagogia-systematrix.firebaseio.com'
});
const db = admin.database();

// Inicializar WhatsApp
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('Escaneie o QR Code acima com o WhatsApp');
});

client.on('ready', () => {
  console.log('✅ Cliente do WhatsApp está pronto!');
});

// Iniciar cliente do WhatsApp
client.initialize();

// Configurar servidor
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Escutar atualizações do Firebase
function escutarEEnviar(tipo) {
  const ref = db.ref(`/escolas`);
  ref.on('child_added', (escolaSnap) => {
    const escolaId = escolaSnap.key;
    const refTipo = db.ref(`/escolas/${escolaId}/relatorios/${tipo}`);

    refTipo.on('child_added', async (snap) => {
      const dado = snap.val();
      const texto = `📌 Nova ${tipo.toUpperCase()}:\nAluno: ${dado.alunoNome}\nTurma: ${dado.turmaNome}\n${dado.descricao ? `Descrição: ${dado.descricao}\n` : ''}Data: ${dado.data}`;

      // Buscar telefone do responsável (aqui simplificado)
      const responsavelSnap = await db.ref(`/escolas/${escolaId}/responsaveis/${dado.alunoId}`).once('value');
      const telefone = responsavelSnap.val()?.telefone || null;
      if (telefone) {
        client.sendMessage(`${telefone}@c.us`, texto);
      } else {
        console.warn('Telefone não encontrado para:', dado.alunoNome);
      }
    });
  });
}

// Escutar para cada tipo
['ocorrencias', 'faltas', 'observacoes'].forEach(escutarEEnviar);

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
