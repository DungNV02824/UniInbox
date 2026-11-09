import { Param } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const uuidSchema = z.uuid('Mã không hợp lệ');

/** Tham số route `:name` phải là UUID (sai => 400). */
export const UuidParam = (name = 'id') => Param(name, new ZodValidationPipe(uuidSchema));
