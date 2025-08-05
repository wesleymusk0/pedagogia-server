const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://pedagogia-systematrix-default-rtdb.firebaseio.com', // Substitua corretamente
  });
}

const db = admin.database();
module.exports = db;
