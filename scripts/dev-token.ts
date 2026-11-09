import { signToken } from '../src/http/auth.ts';

const [role, id] = process.argv.slice(2);
const secret = process.env.RIDECORE_JWT_SECRET;

if (secret === undefined || secret === '') {
  console.error('RIDECORE_JWT_SECRET is not set (see .env.example)');
  process.exit(1);
}
if ((role !== 'passenger' && role !== 'driver') || id === undefined || id === '') {
  console.error('Usage: npm run token -- <passenger|driver> <id>');
  process.exit(1);
}

console.log(await signToken({ id, role }, secret));
