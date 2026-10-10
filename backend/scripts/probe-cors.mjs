process.env.NODE_ENV = 'production';
delete process.env.CORS_ORIGIN;
delete process.env.VERCEL;
const { createApp } = await import('../src/app.js');
const app = createApp();
const res = await app.request('https://timemark.test/__cors-probe', {
  method: 'OPTIONS',
  headers: { Origin: 'https://timemark.test', 'Access-Control-Request-Method': 'POST', 'user-agent': 'Mozilla/5.0' },
}, { incoming: { socket: { remoteAddress: '203.0.113.10', remotePort: 1, remoteFamily: 'IPv4', encrypted: true } } });
console.log('status', res.status);
console.log('ACAO', res.headers.get('access-control-allow-origin'));
console.log('ACAC', res.headers.get('access-control-allow-credentials'));
const { isAllowedOrigin, getConfiguredOrigins } = await import('../src/utils/allowed-origins.js');
console.log('list', getConfiguredOrigins());
console.log('match-host', isAllowedOrigin('https://timemark.test', 'timemark.test', getConfiguredOrigins()));
process.exit(0);
