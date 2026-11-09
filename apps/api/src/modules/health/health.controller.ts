import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { HttpReply } from '../../common/http.types';
import { Public } from '../auth/decorators/public.decorator';
import { type HealthResult, HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 200 khi DB và Redis đều sống, ngược lại 503 kèm thành phần bị lỗi. */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) reply: HttpReply): Promise<HealthResult> {
    const result = await this.health.check();
    if (result.status !== 'ok') reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
