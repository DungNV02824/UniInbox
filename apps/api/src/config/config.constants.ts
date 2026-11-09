import type { Env } from '@dezon/shared/server';

/** Token DI cho cấu hình đã validate (Env). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export type AppConfig = Readonly<Env>;
