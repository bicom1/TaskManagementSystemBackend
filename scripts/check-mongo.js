require('dotenv').config();
const mongoose = require('mongoose');

const u = process.env.MONGO_URI || '';
console.log('URI length', u.length);
console.log('has surrounding quotes', u.startsWith('"') || u.startsWith("'"));
console.log('has whitespace', /\s/.test(u));

const m = u.match(/^mongodb\+srv:\/\/([^:]+):([^@]+)@([^/?]+)\/?([^?]*)(\?.*)?$/);
if (!m) {
  console.log('URI pattern: unexpected');
  console.log('starts:', u.slice(0, 24));
  console.log('ends:', u.slice(-50));
  process.exit(1);
}

console.log('user:', m[1]);
console.log('passLen:', m[2].length);
console.log('host:', m[3]);
console.log('db:', m[4] || '(empty)');
console.log('query present:', Boolean(m[5]));

(async () => {
  try {
    await mongoose.connect(u, { serverSelectionTimeoutMS: 12000 });
    console.log('CONNECTED', mongoose.connection.name);
    await mongoose.disconnect();
  } catch (e) {
    console.log('FAIL:', e.message);
    console.log('HINT: Atlas username/password in MONGO_URI is incorrect.');
  }
})();
