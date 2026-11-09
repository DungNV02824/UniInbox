import type { PublicConfig } from '@dezon/shared';
import { Controller, Get, Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config';
import { Public } from '../auth/decorators/public.decorator';

/** Cờ tính năng cho web (không chứa secret). */
@Controller('config')
export class PublicConfigController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Public()
  @Get()
  get(): PublicConfig {
    return {
      featureAiEnabled: this.config.FEATURE_AI_ENABLED,
      zaloPersonalEnabled: this.config.ZALO_PERSONAL_ENABLED,
    };
  }
}
