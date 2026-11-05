import { randomBytes, scryptSync } from 'node:crypto';
const password=randomBytes(18).toString('base64url');
const salt=randomBytes(16).toString('hex');
console.log(JSON.stringify({
  username:'admin',
  password,
  ADMIN_USERNAME:'admin',
  ADMIN_PASSWORD_HASH:`scrypt$${salt}$${scryptSync(password,Buffer.from(salt,'hex'),64).toString('hex')}`,
  SESSION_SECRET:randomBytes(48).toString('base64url'),
},null,2));
