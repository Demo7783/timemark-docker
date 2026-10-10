process.env.NODE_ENV = 'production';
delete process.env.CORS_ORIGIN;
const { Hono } = await import('hono');
const { cors } = await import('hono/cors');
const { getConfiguredOrigins, isAllowedOrigin } = await import('../src/utils/allowed-origins.js');

const a = new Hono();
a.use('*', cors({
  origin: (origin, c) => {
    console.log('cb origin=', JSON.stringify(origin), 'host=', JSON.stringify(c?.req?.header('host')));
    if (!origin) return 'http://localhost:5173';
    const ok = isAllowedOrigin(origin, c?.req?.header('host'), getConfiguredOrigins());
    console.log('cb isAllowedOrigin=', ok);
    return ok ? origin : null;
  },
  credentials: true,
}));
a.post('/x', (c) => c.text('ok'));

const r = await a.request('https://timemark.test/x', {
  method: 'OPTIONS',
  headers: { Origin: 'https://timemark.test', 'Access-Control-Request-Method': 'POST' },
});
console.log('ACAO =', r.headers.get('access-control-allow-origin'));
process.exit(0);
