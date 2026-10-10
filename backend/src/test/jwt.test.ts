import { describe, expect, it } from 'vitest';
import { generateAccessToken, generateRefreshToken, verifyToken } from '../utils/jwt.js';

describe('JWT token use', () => {
  it('distinguishes access tokens from refresh tokens', async () => {
    const access = await generateAccessToken('7', 'session-token');
    const refresh = await generateRefreshToken('7', 'session-token', true);

    expect(await verifyToken(access, undefined, 'access')).toMatchObject({
      userId: '7',
      sessionToken: 'session-token',
      typ: 'access',
      rememberMe: false,
    });
    expect(await verifyToken(refresh, undefined, 'refresh')).toMatchObject({
      userId: '7',
      sessionToken: 'session-token',
      typ: 'refresh',
      rememberMe: true,
    });
    // typ 闸门：access 不能当 refresh 用（/refresh 依赖此判定）
    expect(await verifyToken(access, undefined, 'refresh')).toBeNull();
    expect(await verifyToken(refresh, undefined, 'access')).toBeNull();
  });
});
