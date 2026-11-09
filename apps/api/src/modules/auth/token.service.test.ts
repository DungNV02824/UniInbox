import { randomBytes, randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config';
import { JWT_ALGORITHM, JWT_ISSUER } from './auth.constants';
import { TokenService } from './token.service';

const config = {
  JWT_SECRET: randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '30d',
} as AppConfig;

const jwt = new JwtService();
const tokens = new TokenService(jwt, config);
const sub = randomUUID();

/** Ký token với secret ĐÚNG của loại kia, để chỉ còn claim `typ` quyết định. */
const forge = (payload: object, secret: string) =>
  jwt.signAsync(payload, { secret, algorithm: JWT_ALGORITHM, issuer: JWT_ISSUER, expiresIn: 60 });

describe('TokenService — claim typ', () => {
  it('payload hợp lệ (đối chứng) được chấp nhận', async () => {
    const refresh = await forge({ sub, typ: 'refresh' }, config.JWT_REFRESH_SECRET);
    await expect(tokens.verifyRefresh(refresh)).resolves.toMatchObject({ sub, typ: 'refresh' });
    const access = await forge({ sub, role: 'admin', typ: 'access' }, config.JWT_SECRET);
    await expect(tokens.verifyAccess(access)).resolves.toMatchObject({ sub, typ: 'access' });
  });

  it('typ=access ký bằng refresh secret bị verifyRefresh từ chối', async () => {
    const token = await forge({ sub, role: 'admin', typ: 'access' }, config.JWT_REFRESH_SECRET);
    await expect(tokens.verifyRefresh(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('typ=refresh ký bằng access secret bị verifyAccess từ chối', async () => {
    const token = await forge({ sub, role: 'admin', typ: 'refresh' }, config.JWT_SECRET);
    await expect(tokens.verifyAccess(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('thiếu typ bị từ chối', async () => {
    const token = await forge({ sub, role: 'admin' }, config.JWT_SECRET);
    await expect(tokens.verifyAccess(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
